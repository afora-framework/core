/** The names a step cannot bind with `as`: they are roots or escapes of values. */
export const RESERVED_NAMES: readonly string[] = [
	"input",
	"context",
	"env",
	"literal",
];

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9][0-9]*)$/;
const BLOCKED = new Set(["__proto__", "constructor", "prototype"]);

/** Whether `value` is usable as the name of a step result or of a `run`. */
export function isStepName(value: unknown): value is string {
	return typeof value === "string" && IDENTIFIER.test(value);
}

/** A reference split in its root (`input`, `context`, `env` or a bound name) and path. */
export interface ParsedReference {
	readonly root: string;
	readonly path: readonly string[];
}

const parsed = new Map<string, ParsedReference | null>();

/** Splits `$root.a.0.b`; `undefined` when `text` is not a well-formed reference. */
export function parseReference(text: string): ParsedReference | undefined {
	const cached = parsed.get(text);
	if (cached !== undefined) return cached ?? undefined;
	let result: ParsedReference | null = null;
	if (text.startsWith("$")) {
		const [root, ...path] = text.slice(1).split(".");
		if (
			root !== undefined &&
			IDENTIFIER.test(root) &&
			path.every((segment) => SEGMENT.test(segment))
		) {
			result = Object.freeze({ root, path: Object.freeze(path) });
		}
	}
	if (parsed.size < 4096) parsed.set(text, result);
	return result ?? undefined;
}

/** A plain object or array, the shapes a value is made of. */
export function isPlain(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Whether `value` is `{ literal: x }`, the escape that is `x` as it is. */
function isLiteralEscape(
	value: unknown,
): value is { readonly literal: unknown } {
	return (
		isPlain(value) &&
		Object.keys(value).length === 1 &&
		Object.hasOwn(value, "literal")
	);
}

/** What a walk over a value finds wrong in it. */
export type ValueIssue = "invalid_value" | "invalid_reference";

/**
 * Visits every reference in `value` (a reference, a literal or a mapping),
 * and reports the first thing that cannot be a value: a function, a class
 * instance, `undefined`, or a malformed reference.
 */
export function walkValue(
	value: unknown,
	onReference: (reference: ParsedReference, text: string) => void,
	onIssue: (issue: ValueIssue, text: string) => never,
): void {
	if (typeof value === "string") {
		if (!value.startsWith("$")) return;
		const reference = parseReference(value);
		if (!reference) onIssue("invalid_reference", value);
		else onReference(reference, value);
		return;
	}
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return;
	}
	if (isLiteralEscape(value)) {
		// The escape holds a JSON value that is never resolved.
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) walkValue(item, onReference, onIssue);
		return;
	}
	if (isPlain(value)) {
		for (const item of Object.values(value)) {
			walkValue(item, onReference, onIssue);
		}
		return;
	}
	onIssue("invalid_value", String(value));
}

/** Follows `path` from `from`; a missing segment is `undefined`, never an error. */
export function followPath(from: unknown, path: readonly string[]): unknown {
	let current = from;
	for (const segment of path) {
		if (
			(typeof current !== "object" && typeof current !== "function") ||
			current === null ||
			BLOCKED.has(segment)
		) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/** The value `value` stands for, with `lookup` resolving the references. */
export function resolveValue(
	value: unknown,
	lookup: (reference: ParsedReference) => unknown,
): unknown {
	if (typeof value === "string") {
		if (!value.startsWith("$")) return value;
		const reference = parseReference(value);
		return reference ? lookup(reference) : undefined;
	}
	if (isLiteralEscape(value)) return value.literal;
	if (Array.isArray(value))
		return value.map((item) => resolveValue(item, lookup));
	if (isPlain(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				resolveValue(item, lookup),
			]),
		);
	}
	return value;
}

/** A copy of the data in `value`, frozen; classes and functions are kept as they are. */
export function freezeData<Value>(value: Value): Value {
	if (Array.isArray(value)) {
		return Object.freeze(value.map(freezeData)) as Value;
	}
	if (isPlain(value)) {
		return Object.freeze(
			Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, freezeData(item)]),
			),
		) as Value;
	}
	return value;
}
