import { describe, expect, test } from "bun:test";
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
