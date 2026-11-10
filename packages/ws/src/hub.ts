import type { IEventPublisher, PublishedEvent } from "@afora/core";

/** What the sink sends messages through: a WebSocket of any runtime has `send`. */
export interface WsSocket {
	send(text: string): void;
}

/**
 * Who is subscribed to which topic, and an `IEventPublisher`: declared under
 * a key in `applicationOf({ publishers })`, the events `publishEvents` gives
 * it reach the sockets subscribed to their topic.
 */
export interface WsHub extends IEventPublisher {
	subscribe(topic: string, socket: WsSocket): void;
	unsubscribe(topic: string, socket: WsSocket): void;
	/** How many sockets are subscribed to `topic`. */
	size(topic: string): number;
}

/**
 * A hub in memory: it reaches the sockets of this process (or Workers
 * isolate) only. `publish` sends `{ topic, event }` as JSON to each socket
 * subscribed to the topic, and drops a socket whose `send` throws; it never
 * throws itself. To reach the sockets of other instances, implement `WsHub`
 * over a broker (Redis, a Durable Object, Bun's `server.publish`).
 */
export function wsHub(): WsHub {
	const topics = new Map<string, Set<WsSocket>>();
	const drop = (socket: WsSocket) => {
		for (const [topic, sockets] of topics) {
			sockets.delete(socket);
			if (sockets.size === 0) topics.delete(topic);
		}
	};
	return Object.freeze({
		subscribe(topic: string, socket: WsSocket) {
			let sockets = topics.get(topic);
			if (!sockets) {
				sockets = new Set();
				topics.set(topic, sockets);
			}
			sockets.add(socket);
		},
		unsubscribe(topic: string, socket: WsSocket) {
			const sockets = topics.get(topic);
			if (!sockets) return;
			sockets.delete(socket);
			if (sockets.size === 0) topics.delete(topic);
		},
		size(topic: string) {
			return topics.get(topic)?.size ?? 0;
		},
		publish(topic: string, event: PublishedEvent) {
			const sockets = topics.get(topic);
			if (!sockets) return;
			const text = JSON.stringify({ topic, event });
			for (const socket of [...sockets]) {
				try {
					socket.send(text);
				} catch {
					drop(socket);
				}
			}
		},
	});
}
