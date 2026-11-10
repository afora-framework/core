import { InvalidRepositoryCursor } from "./exceptions";
import type { RepositoryOrder } from "./types/query.interface";
import type { RepositoryData } from "./types/repository.interface";

/** The version of the cursor format; a cursor of another one is rejected. */
const VERSION = 1;

/** What a cursor holds: its version, the order it was made for and the values of a row in it. */
interface CursorPayload {
	readonly v: number;
	readonly k: readonly string[];
	readonly a: readonly unknown[];
}

/** `key:direction` of each order, to tell a cursor made for another order. */
const signatureOf = (orders: readonly RepositoryOrder[]): string[] =>
	orders.map(({ key, direction = "asc" }) => `${key}:${direction}`);

/** A value as JSON keeps it: a date and a bigint tagged, a missing one as `null`. */
function pack(value: unknown): unknown {
	if (value === undefined || value === null) return null;
	if (value instanceof Date) return { d: value.toISOString() };
	if (typeof value === "bigint") return { b: value.toString() };
	return value;
}

/** The value `pack` was given, a missing one as `undefined`; throws for anything else. */
function unpack(value: unknown): unknown {
	if (value === null) return undefined;
	if (["string", "number", "boolean"].includes(typeof value)) return value;
	if (typeof value === "object") {
		const { d, b } = value as { readonly d?: unknown; readonly b?: unknown };
		const keys = Object.keys(value);
		if (keys.length === 1 && typeof d === "string") {
			const date = new Date(d);
			if (!Number.isNaN(date.getTime())) return date;
		}
		if (keys.length === 1 && typeof b === "string" && /^-?\d+$/.test(b))
			return BigInt(b);
	}
	throw new SyntaxError("value");
}

/** Text as base64url, with no `Buffer`: it runs in browsers and workers too. */
function encodeText(text: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(text))
		binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function decodeText(encoded: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new SyntaxError("alphabet");
	const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
	return new TextDecoder("utf-8", { fatal: true }).decode(
		Uint8Array.from(binary, (char) => char.charCodeAt(0)),
	);
}

/**
 * The cursor of `row` in `orders`: an opaque text holding the values of its
 * order keys. It is not encrypted or signed: whoever has it can read those
 * values, and changing it only moves the position inside the same query.
 */
export function encodeCursor(
	orders: readonly RepositoryOrder[],
	row: RepositoryData,
): string {
	const payload: CursorPayload = {
		v: VERSION,
		k: signatureOf(orders),
		a: orders.map(({ key }) => pack(row[key])),
	};
	return encodeText(JSON.stringify(payload));
}

/**
 * The values a cursor holds, one for each of `orders`; throws
 * `InvalidRepositoryCursor` when it is not a cursor or was made for another order.
 */
export function decodeCursor(
	source: string,
	orders: readonly RepositoryOrder[],
	cursor: unknown,
): readonly unknown[] {
	const fail = (reason: string): never => {
		throw new InvalidRepositoryCursor({
			source,
			details: {
				reason,
				issues: [
					{ code: "invalid_value", path: ["after"], message: reason, source },
				],
			},
		});
	};
	if (typeof cursor !== "string" || cursor === "")
		return fail("Expected a cursor given by findCursor.");
	let payload: Partial<CursorPayload>;
	let values: unknown[];
	try {
		payload = JSON.parse(decodeText(cursor)) as Partial<CursorPayload>;
		if (typeof payload !== "object" || payload === null)
			throw new SyntaxError();
		if (!Array.isArray(payload.k) || !Array.isArray(payload.a))
			throw new SyntaxError();
		values = payload.a.map(unpack);
	} catch {
		return fail("The cursor is not one given by findCursor.");
	}
	if (payload.v !== VERSION)
		return fail("The cursor was made by another version.");
	const expected = signatureOf(orders);
	if (
		payload.k?.length !== expected.length ||
		values.length !== expected.length ||
		expected.some((key, index) => payload.k?.[index] !== key)
	)
		return fail("The cursor was made for another orderBy.");
	return values;
}
