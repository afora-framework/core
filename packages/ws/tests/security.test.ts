import { describe, expect, test } from "bun:test";
import {
	blueprintOf,
	commandOf,
	listOf,
	outputOf,
	useCaseOf,
} from "@afora/core";
import { websocket } from "../src/index";
import { fakeSocket, realtime } from "./fixture";

type Problem = { title: string; status: number; type: string };

describe("SEC-30: a session holds a bounded number of topics", () => {
	const LIMIT = 1000;
	const topic = (index: number) => `posts/${index}`;

	test("SEC-30: a subscription past the limit is refused, the held topics are kept", async () => {
		const { endpoint, hub } = realtime();
		const socket = fakeSocket();
		const session = endpoint.session(socket, { hub });
		for (let index = 0; index < LIMIT; index++) {
			await session.message(JSON.stringify({ subscribe: topic(index) }));
		}
		expect(session.topics.length).toBe(LIMIT);
		expect(socket.sent.at(-1)).toEqual({
			id: null,
			subscribed: topic(LIMIT - 1),
		});

		await session.message(
			JSON.stringify({ id: "over", subscribe: topic(LIMIT) }),
		);
		const reply = socket.sent.at(-1) as { id: string; problem: Problem };
		expect(reply.id).toBe("over");
		expect(reply.problem).toMatchObject({
			title: "WsTopicForbidden",
			status: 403,
		});
		expect(session.topics.length).toBe(LIMIT);
		expect(hub.size(topic(LIMIT))).toBe(0);
	});

	test("SEC-30: subscribing again to a held topic does not count twice", async () => {
		const { endpoint, hub } = realtime();
		const socket = fakeSocket();
		const session = endpoint.session(socket, { hub });
		for (let index = 0; index < LIMIT; index++) {
			await session.message(JSON.stringify({ subscribe: topic(index) }));
		}
		await session.message(JSON.stringify({ id: 1, subscribe: topic(0) }));
		expect(socket.sent.at(-1)).toEqual({ id: 1, subscribed: topic(0) });
		expect(session.topics.length).toBe(LIMIT);
		expect(hub.size(topic(0))).toBe(1);
	});

	test("SEC-30: unsubscribing frees a place", async () => {
		const { endpoint, hub } = realtime();
		const socket = fakeSocket();
		const session = endpoint.session(socket, { hub });
		for (let index = 0; index < LIMIT; index++) {
			await session.message(JSON.stringify({ subscribe: topic(index) }));
		}
		await session.message(JSON.stringify({ unsubscribe: topic(0) }));
		await session.message(JSON.stringify({ id: 2, subscribe: topic(LIMIT) }));
		expect(socket.sent.at(-1)).toEqual({ id: 2, subscribed: topic(LIMIT) });
		expect(session.topics.length).toBe(LIMIT);
		expect(hub.size(topic(LIMIT))).toBe(1);
	});

	test("SEC-30: subscriptions waiting on authorize at once stay under the limit", async () => {
		const { endpoint, hub } = realtime();
		const socket = fakeSocket();
		const session = endpoint.session(socket, {
			hub,
			authorize: async () => {
				await Promise.resolve();
				return true;
			},
		});
		await Promise.all(
			Array.from({ length: LIMIT + 10 }, (_, index) =>
				session.message(JSON.stringify({ subscribe: topic(index) })),
			),
		);
		expect(session.topics.length).toBe(LIMIT);
		const refused = socket.sent.filter(
			(reply) => (reply as { problem?: Problem }).problem?.status === 403,
		);
		expect(refused.length).toBe(10);
	});

	test("SEC-30: the limit is per session", async () => {
		const { endpoint, hub } = realtime();
		const first = endpoint.session(fakeSocket(), { hub });
		for (let index = 0; index < LIMIT; index++) {
			await first.message(JSON.stringify({ subscribe: topic(index) }));
		}
		const socket = fakeSocket();
		const second = endpoint.session(socket, { hub });
		await second.message(JSON.stringify({ id: 3, subscribe: topic(LIMIT) }));
		expect(socket.sent).toEqual([{ id: 3, subscribed: topic(LIMIT) }]);
		expect(hub.size(topic(0))).toBe(1);
	});
});

describe("SEC-36: a topic has a bounded length", () => {
	const LIMIT = 512;
	/** `posts/` and a segment, `bytes` UTF-8 bytes in all. */
	const topicOf = (bytes: number, char = "x") =>
		`posts/${char.repeat((bytes - 6) / new TextEncoder().encode(char).byteLength)}`;

	test("SEC-36: a topic past the limit is a 400 InvalidWsMessage, before authorize and the hub", async () => {
		const { endpoint, hub } = realtime();
		const socket = fakeSocket();
		const asked: string[] = [];
		const session = endpoint.session(socket, {
			hub,
			authorize: (topic) => {
				asked.push(topic);
				return true;
			},
		});
		const topic = topicOf(LIMIT + 2);
		await session.message(JSON.stringify({ id: "long", subscribe: topic }));
		const reply = socket.sent.at(-1) as { id: string; problem: Problem };
		expect(reply.id).toBe("long");
		expect(reply.problem).toMatchObject({
			title: "InvalidWsMessage",
			status: 400,
		});
		expect(asked).toEqual([]);
		expect(session.topics).toEqual([]);
		expect(hub.size(topic)).toBe(0);
	});

	test("SEC-36: a topic at the limit is held", async () => {
		const { endpoint, hub } = realtime();
		const socket = fakeSocket();
		const session = endpoint.session(socket, { hub });
		const topic = topicOf(LIMIT);
		await session.message(JSON.stringify({ id: 1, subscribe: topic }));
		expect(socket.sent.at(-1)).toEqual({ id: 1, subscribed: topic });
		expect(hub.size(topic)).toBe(1);
	});

	test("SEC-36: the length is counted in UTF-8 bytes", async () => {
		const { endpoint, hub } = realtime();
		const socket = fakeSocket();
		const session = endpoint.session(socket, { hub });
		const held = topicOf(LIMIT, "é");
		await session.message(JSON.stringify({ subscribe: held }));
		expect(socket.sent.at(-1)).toEqual({ id: null, subscribed: held });
		const over = `${held}é`;
		await session.message(JSON.stringify({ subscribe: over }));
		expect((socket.sent.at(-1) as { problem: Problem }).problem.status).toBe(
			400,
		);
		expect(session.topics).toEqual([held]);
	});

	test("SEC-36: an unsubscription past the limit is a 400 too, held topics are kept", async () => {
		const { endpoint, hub } = realtime();
		const socket = fakeSocket();
		const session = endpoint.session(socket, { hub });
		await session.message(JSON.stringify({ subscribe: "posts/1" }));
		await session.message(
			JSON.stringify({ id: 2, unsubscribe: topicOf(LIMIT + 2) }),
		);
		expect(socket.sent.at(-1)).toMatchObject({
			id: 2,
			problem: { title: "InvalidWsMessage", status: 400 },
		});
		expect(session.topics).toEqual(["posts/1"]);
	});

	test("SEC-36: handle answers the same 400 for such a topic", async () => {
		const { endpoint } = realtime();
		const reply = (await endpoint.handle(
			JSON.stringify({ id: 3, subscribe: topicOf(LIMIT + 2) }),
		)) as { id: number; problem: Problem };
		expect(reply.problem.status).toBe(400);
	});
});

describe("SEC-50: a problem lists a bounded number of issues", () => {
	test("SEC-50: a list of invalid items answers a bounded problem", async () => {
		class Tag extends useCaseOf({
			name: "Tag",
			blueprint: blueprintOf((ctx) => ({ tags: listOf(ctx.string) })),
			response: blueprintOf((ctx) => ({ ok: ctx.boolean })),
		}) {
			override async execute() {
				return { ok: true };
			}
		}
		const endpoint = outputOf({
			name: "Live",
			commands: [commandOf({ name: "Tags", useCases: { tag: Tag } })],
			pipe: [websocket({})],
		}).build();
		const reply = (await endpoint.handle({
			id: 1,
			op: "Tags.tag",
			input: { tags: Array.from({ length: 20_000 }, () => 0) },
		})) as unknown as { problem: Problem & { issues: unknown[] } };
		expect(reply.problem.status).toBe(400);
		expect(reply.problem.issues).toHaveLength(100);
	});
});
