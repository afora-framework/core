import type { Problem, PublishedEvent } from "@afora/core";

/** The id a client gives a request, echoed in the reply. */
export type WsRequestId = string | number;

/** What a client sends: a call of an operation, or a (un)subscription to a topic. */
export type WsRequest =
	| {
			readonly id?: WsRequestId;
			/** The operation id: `"Posts.create"`. */
			readonly op: string;
			readonly input?: unknown;
	  }
	| { readonly id?: WsRequestId; readonly subscribe: string }
	| { readonly id?: WsRequestId; readonly unsubscribe: string };

/** What the server answers to one request; `id` is the request's, or `null` without one. */
export type WsReply =
	| { readonly id: WsRequestId | null; readonly value: unknown }
	| { readonly id: WsRequestId | null; readonly problem: Problem }
	| { readonly id: WsRequestId | null; readonly subscribed: string }
	| { readonly id: WsRequestId | null; readonly unsubscribed: string };

/** What the server sends to the subscribers of a topic when an event is published. */
export interface WsPush {
	readonly topic: string;
	readonly event: PublishedEvent;
}

const KEYS = ["id", "op", "input", "subscribe", "unsubscribe"];
const VERBS = ["op", "subscribe", "unsubscribe"] as const;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** A frame that cannot be read: why, and the id when the frame had a readable one. */
export interface WsMessageFailure {
	readonly reason: string;
	readonly id: WsRequestId | null;
}

function isId(value: unknown): value is WsRequestId {
	return (
		(typeof value === "string" && value !== "") ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

/**
 * `data` read as a request: text (or UTF-8 bytes) of a JSON object with an
 * optional `id` and exactly one of `op`, `subscribe` and `unsubscribe`, or
 * already such an object. Never throws.
 */
export function parseWsMessage(
	data: string | ArrayBuffer | Uint8Array | object,
	maxBytes: number,
): { readonly request: WsRequest } | { readonly failure: WsMessageFailure } {
	const fail = (reason: string, id: WsRequestId | null = null) => ({
		failure: { reason, id },
	});
	let frame: unknown = data;
	if (
		typeof data === "string" ||
		data instanceof ArrayBuffer ||
		data instanceof Uint8Array
	) {
		const size =
			typeof data === "string"
				? encoder.encode(data).byteLength
				: data.byteLength;
		if (size > maxBytes) {
			return fail(`The message is larger than ${maxBytes} bytes.`);
		}
		let text: string;
		try {
			text = typeof data === "string" ? data : decoder.decode(data);
		} catch {
			return fail("The message is not valid UTF-8.");
		}
		try {
			frame = JSON.parse(text);
		} catch {
			return fail("The message is not valid JSON.");
		}
	}
	if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
		return fail("The message must be a JSON object.");
	}
	const given = frame as Record<string, unknown>;
	const id = isId(given.id) ? given.id : null;
	if (given.id !== undefined && id === null) {
		return fail('"id" must be a non-empty string or a number.');
	}
	const unknown = Object.keys(given).find((key) => !KEYS.includes(key));
	if (unknown !== undefined) {
		return fail(`The message has no key "${unknown}".`, id);
	}
	const verbs = VERBS.filter((verb) => Object.hasOwn(given, verb));
	if (verbs.length !== 1) {
		return fail(
			'The message must have exactly one of "op", "subscribe" and "unsubscribe".',
			id,
		);
	}
	const [verb] = verbs as [(typeof VERBS)[number]];
	if (typeof given[verb] !== "string" || given[verb] === "") {
		return fail(`"${verb}" must be a non-empty string.`, id);
	}
	if (verb !== "op" && given.input !== undefined) {
		return fail(`"input" only goes with "op".`, id);
	}
	return { request: given as WsRequest };
}
