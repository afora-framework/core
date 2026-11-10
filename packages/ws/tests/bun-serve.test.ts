import { afterAll, expect, test } from "bun:test";
import type { WsSession } from "../src/index";
import { realtime } from "./fixture";

const { endpoint, hub } = realtime();

// The adapter of the README: a session per socket, the context from the upgrade headers.
const server = Bun.serve<{
	values: Record<string, string | undefined>;
	session?: WsSession;
}>({
	port: 0,
	fetch(request, server) {
		const values = { "x-user": request.headers.get("x-user") ?? undefined };
		if (server.upgrade(request, { data: { values } })) return undefined;
		return new Response("Upgrade required", { status: 426 });
	},
	websocket: {
		open(ws) {
			ws.data.session = endpoint.session(ws, { hub, values: ws.data.values });
		},
		message(ws, message) {
			void ws.data.session?.message(message);
		},
		close(ws) {
			ws.data.session?.close();
		},
	},
});

afterAll(() => server.stop(true));

/** A client that keeps every message and can wait for the next ones. */
async function connect(headers: Record<string, string> = {}) {
	const socket = new WebSocket(`ws://localhost:${server.port}`, {
		headers,
	} as never);
	const received: unknown[] = [];
	const waiting: { count: number; resolve: () => void }[] = [];
	socket.addEventListener("message", (event) => {
		received.push(JSON.parse(String(event.data)));
		for (const wait of [...waiting]) {
			if (received.length >= wait.count) {
				waiting.splice(waiting.indexOf(wait), 1);
				wait.resolve();
			}
		}
	});
	await new Promise((resolve) => socket.addEventListener("open", resolve));
	return {
		received,
		send: (frame: unknown) => socket.send(JSON.stringify(frame)),
		until: (count: number) =>
			received.length >= count
				? Promise.resolve()
				: new Promise<void>((resolve) => waiting.push({ count, resolve })),
		close: () => socket.close(),
	};
}

test("a real socket calls, subscribes and receives the events", async () => {
	const watcher = await connect();
	const writer = await connect({ "x-user": "ana" });

	watcher.send({ id: "w", subscribe: "feed" });
	await watcher.until(1);
	expect(watcher.received[0]).toEqual({ id: "w", subscribed: "feed" });

	writer.send({ id: 1, op: "Posts.create", input: { title: "Live" } });
	await writer.until(1);
	await watcher.until(2);

	const reply = writer.received[0] as {
		id: number;
		value: { post: Record<string, unknown> };
	};
	expect(reply.id).toBe(1);
	expect(reply.value.post).toMatchObject({
		title: "Live",
		author: "ana",
		secret: "********",
	});
	expect(watcher.received[1]).toMatchObject({
		topic: "feed",
		event: { name: "published", entity: { title: "Live", secret: "********" } },
	});

	watcher.close();
	writer.close();
	// The server closes the session: the hub forgets the socket.
	for (let tries = 0; hub.size("feed") > 0 && tries < 50; tries++) {
		await Bun.sleep(10);
	}
	expect(hub.size("feed")).toBe(0);
});
