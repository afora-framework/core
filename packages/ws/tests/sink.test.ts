import { describe, expect, test } from "bun:test";
import {
	InvalidOutputStage,
	outputOf,
	StdStages,
	stageDescriptionOf,
} from "@afora/core";
import { stages, type WsReply, WsStages, websocket, wsHub } from "../src/index";
import { fakeSocket, realtime } from "./fixture";

type Problem = {
	title: string;
	status: number;
	detail: string;
	issues?: { code: string; path: unknown[] }[];
	trace?: string;
};
const problemOf = (reply: WsReply) => (reply as { problem: Problem }).problem;

describe("websocket sink: handle", () => {
	test("calls an operation and masks the response", async () => {
		const { endpoint } = realtime();
		const reply = await endpoint.handle(
			JSON.stringify({ id: 1, op: "Posts.create", input: { title: "Hi" } }),
			{ values: { "x-user": "ana" } },
		);
		expect(reply.id).toBe(1);
		const { post } = (reply as { value: { post: Record<string, unknown> } })
			.value;
		expect(post).toMatchObject({
			title: "Hi",
			author: "ana",
			secret: "********",
		});
	});

	test("takes an object as well as text and bytes", async () => {
		const { endpoint } = realtime();
		const asObject = await endpoint.handle({ op: "Posts.count" });
		expect(asObject).toEqual({ id: null, value: { total: 0 } });
		const asBytes = await endpoint.handle(
			new TextEncoder().encode(JSON.stringify({ id: "a", op: "Posts.count" })),
		);
		expect(asBytes).toEqual({ id: "a", value: { total: 0 } });
	});

	test("invalid input is a 400 with issues", async () => {
		const { endpoint } = realtime();
		const reply = await endpoint.handle({
			id: 2,
			op: "Posts.create",
			input: {},
		});
		expect(reply.id).toBe(2);
		expect(problemOf(reply)).toMatchObject({
			title: "InvalidUseCaseInput",
			status: 400,
		});
		expect(problemOf(reply).issues?.[0]?.code).toBe("required");
	});

	test("an error of the use case gets the status of the output", async () => {
		const { endpoint } = realtime();
		const reply = await endpoint.handle({
			op: "Posts.create",
			input: { title: "forbidden" },
		});
		expect(problemOf(reply)).toMatchObject({ title: "Forbidden", status: 403 });
	});

	test("an unknown operation is a 404", async () => {
		const { endpoint } = realtime();
		const reply = await endpoint.handle({ id: 3, op: "Posts.nope" });
		expect(reply.id).toBe(3);
		expect(problemOf(reply)).toMatchObject({ title: "NotFound", status: 404 });
	});

	test("a message that is not a frame is a 400 InvalidWsMessage", async () => {
		const { endpoint } = realtime({ maxMessageBytes: 64 });
		const cases: [unknown, string, unknown][] = [
			["{nope", "not valid JSON", null],
			["[1]", "must be a JSON object", null],
			[{ id: 4 }, 'exactly one of "op"', 4],
			[
				{ id: 5, op: "Posts.count", subscribe: "feed" },
				'exactly one of "op"',
				5,
			],
			[{ id: 6, op: "" }, '"op" must be a non-empty string', 6],
			[{ id: 7, op: "Posts.count", extra: 1 }, 'no key "extra"', 7],
			[{ id: {}, op: "Posts.count" }, '"id" must be', null],
			[{ subscribe: "feed", input: {} }, '"input" only goes with "op"', null],
			[
				JSON.stringify({ op: "Posts.count", input: { pad: "x".repeat(80) } }),
				"larger than 64 bytes",
				null,
			],
			[new Uint8Array([0xff, 0xfe]), "not valid UTF-8", null],
		];
		for (const [message, reason, id] of cases) {
			const reply = await endpoint.handle(message as never);
			expect(reply.id).toBe(id as never);
			expect(problemOf(reply)).toMatchObject({
				title: "InvalidWsMessage",
				status: 400,
			});
			expect(problemOf(reply).detail).toContain(reason);
		}
	});

	test("a subscription without a session is a 501", async () => {
		const { endpoint } = realtime();
		const reply = await endpoint.handle({ id: 8, subscribe: "feed" });
		expect(problemOf(reply)).toMatchObject({
			title: "WsSubscriptionsUnavailable",
			status: 501,
		});
	});

	test("include limits the operations and lists them", () => {
		const { endpoint } = realtime({ include: ["Posts.count"] });
		expect(endpoint.operations.map((operation) => operation.id)).toEqual([
			"Posts.count",
		]);
		const all = realtime().endpoint.operations;
		expect(all.map((operation) => operation.id)).toEqual([
			"Posts.create",
			"Posts.count",
		]);
		expect(all[0]?.description).toBe("Publishes a post.");
		expect(all[0]?.inputSchema).toMatchObject({ type: "object" });
	});
});

describe("websocket sink: sessions", () => {
	test("subscribes, receives the events of its topics, and leaves on close", async () => {
		const { endpoint, hub } = realtime();
		const watcher = fakeSocket();
		const writer = fakeSocket();
		const watching = endpoint.session(watcher, { hub });
		const writing = endpoint.session(writer, {
			hub,
			values: { "x-user": "bia" },
		});

		await watching.message(JSON.stringify({ id: "s", subscribe: "feed" }));
		expect(watcher.sent).toEqual([{ id: "s", subscribed: "feed" }]);

		await writing.message(
			JSON.stringify({ id: 1, op: "Posts.create", input: { title: "One" } }),
		);
		const created = writer.sent[0] as { value: { post: { id: string } } };
		const id = created.value.post.id;

		await watching.message(JSON.stringify({ subscribe: `posts/${id}` }));
		expect(watching.topics).toEqual(["feed", `posts/${id}`]);
		expect(hub.size(`posts/${id}`)).toBe(1);

		// Only the events published after the subscription reach it.
		await writing.message(
			JSON.stringify({ op: "Posts.create", input: { title: "Two" } }),
		);
		const second = (writer.sent[1] as { value: { post: { id: string } } }).value
			.post.id;
		await watching.message(JSON.stringify({ subscribe: `posts/${second}` }));
		expect(watcher.sent.at(-1)).toEqual({
			id: null,
			subscribed: `posts/${second}`,
		});

		watching.close();
		expect(hub.size("feed")).toBe(0);
		expect(watching.topics).toEqual([]);
		await watching.message(JSON.stringify({ op: "Posts.count" }));
		expect(watcher.sent.at(-1)).toEqual({
			id: null,
			subscribed: `posts/${second}`,
		});
	});

	test("refuses topics outside the options or refused by authorize", async () => {
		const { endpoint, hub } = realtime();
		const socket = fakeSocket();
		const session = endpoint.session(socket, {
			hub,
			values: { "x-user": "ana" },
			authorize: (topic, values) =>
				topic !== "posts/secret" && values["x-user"] === "ana",
		});
		for (const topic of ["comments", "posts", "posts/a/b", "posts/secret"]) {
			await session.message(JSON.stringify({ id: topic, subscribe: topic }));
		}
		expect(
			socket.sent.map((reply) => problemOf(reply as WsReply).status),
		).toEqual([403, 403, 403, 403]);
		expect(problemOf(socket.sent[0] as WsReply).title).toBe("WsTopicForbidden");
		expect(session.topics).toEqual([]);

		const closed = realtime({ subscriptions: undefined as never });
		const refused = fakeSocket();
		await closed.endpoint
			.session(refused, { hub: closed.hub })
			.message(JSON.stringify({ subscribe: "feed" }));
		expect(problemOf(refused.sent[0] as WsReply).status).toBe(403);
	});

	test("unsubscribes, and a session without a hub answers 501", async () => {
		const { endpoint, hub } = realtime();
		const socket = fakeSocket();
		const session = endpoint.session(socket, { hub });
		await session.message(JSON.stringify({ subscribe: "feed" }));
		await session.message(JSON.stringify({ id: 9, unsubscribe: "feed" }));
		expect(socket.sent.at(-1)).toEqual({ id: 9, unsubscribed: "feed" });
		expect(hub.size("feed")).toBe(0);

		const lonely = fakeSocket();
		const noHub = endpoint.session(lonely);
		await noHub.message(JSON.stringify({ subscribe: "feed" }));
		await noHub.message(JSON.stringify({ unsubscribe: "feed" }));
		expect(
			lonely.sent.map((reply) => problemOf(reply as WsReply).status),
		).toEqual([501, 501]);
	});

	test("a socket whose send throws does not break the session", async () => {
		const { endpoint } = realtime();
		const session = endpoint.session({
			send() {
				throw new Error("closed");
			},
		});
		await session.message(JSON.stringify({ op: "Posts.count" }));
	});
});

describe("websocket sink: events end to end", () => {
	test("a call publishes its event, masked, to the subscribers of the topic", async () => {
		const { endpoint, hub } = realtime();
		const watcher = fakeSocket();
		const writer = fakeSocket();
		const watching = endpoint.session(watcher, { hub });
		const writing = endpoint.session(writer, {
			hub,
			values: { "x-user": "ana" },
		});

		await watching.message(JSON.stringify({ id: "w", subscribe: "feed" }));
		await writing.message(
			JSON.stringify({ id: 1, op: "Posts.create", input: { title: "Hi" } }),
		);

		const { post } = (writer.sent[0] as { value: { post: { id: string } } })
			.value;
		expect(watcher.sent).toEqual([
			{ id: "w", subscribed: "feed" },
			{
				topic: "feed",
				event: {
					name: "published",
					command: "Posts",
					operation: "create",
					entity: expect.objectContaining({
						id: post.id,
						title: "Hi",
						author: "ana",
						secret: "********",
					}),
				},
			},
		]);
		// The writer is not subscribed, so it only got its reply.
		expect(writer.sent).toHaveLength(1);
	});

	test("the id placeholder makes one topic per entity", async () => {
		const { endpoint, hub } = realtime({}, "posts/{id}");
		const watcher = fakeSocket();
		// Subscribing to a topic of an entity that exists later: allowed by the pattern.
		const session = endpoint.session(watcher, { hub });
		await session.message(JSON.stringify({ subscribe: "posts/abc" }));
		expect(watcher.sent).toEqual([{ id: null, subscribed: "posts/abc" }]);
		await endpoint.handle({ op: "Posts.create", input: { title: "Other" } });
		// The event went to posts/<its id>, not to posts/abc.
		expect(watcher.sent).toHaveLength(1);
	});

	test("the hub drops a socket whose send throws", () => {
		const hub = wsHub();
		const good = fakeSocket();
		const bad = {
			send() {
				throw new Error("gone");
			},
		};
		hub.subscribe("feed", good);
		hub.subscribe("feed", bad);
		hub.subscribe("other", bad);
		const event = { name: "e", command: "C", operation: "o", entity: null };
		hub.publish("feed", event);
		expect(good.sent).toEqual([{ topic: "feed", event }]);
		expect(hub.size("feed")).toBe(1);
		expect(hub.size("other")).toBe(0);
		hub.publish("nobody", event);
		hub.unsubscribe("nobody", good);
	});
});

describe("websocket sink: options and catalog", () => {
	const make = (options: unknown) => () => websocket(options as never);

	test("are validated when the stage is made", () => {
		for (const [options, message] of [
			[{ other: 1 }, 'websocket has no option "other".'],
			[{ include: [1] }, "websocket.include"],
			[{ context: [] }, "websocket.context"],
			[{ context: { a: "" } }, 'websocket.context["a"]'],
			[{ subscriptions: { topics: "x" } }, "websocket.subscriptions"],
			[{ subscriptions: { topics: ["a//b"] } }, "websocket.subscriptions"],
			[{ subscriptions: { topics: [], other: 1 } }, "websocket.subscriptions"],
			[{ maxMessageBytes: 0 }, "websocket.maxMessageBytes"],
			[{ debug: "yes" }, "websocket.debug"],
		] as const) {
			expect(make(options)).toThrow(message);
		}
		expect(make({ other: 1 })).toThrow(InvalidOutputStage);
	});

	test("include names operations of the output", () => {
		const { App } = realtime();
		expect(() =>
			outputOf({
				name: "Bad",
				commands: [App.commands.Posts],
				pipe: [websocket({ include: ["Posts.nope"] })],
			}).build(),
		).toThrow('websocket.include names "Posts.nope"');
	});

	test("debug adds the trace", async () => {
		const { endpoint } = realtime({ debug: true });
		const reply = await endpoint.handle("{nope");
		expect(problemOf(reply).trace).toContain("InvalidWsMessage");
	});

	test("catalogs", () => {
		expect(stages).toEqual([
			{
				name: "websocket",
				module: "@afora/ws",
				export: "websocket",
				kind: "sink",
			},
		]);
		const stage = WsStages.resolve("websocket", { debug: true });
		expect(stageDescriptionOf(stage)).toEqual({
			kind: "sink",
			name: "websocket",
			options: { debug: true },
		});
		expect(Object.keys(StdStages.stages)).not.toContain("websocket");
	});
});
