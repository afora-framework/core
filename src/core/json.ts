/** A JSON value. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

/**
 * A deep, frozen copy of `value`, which must be finite, acyclic JSON made of
 * plain objects and arrays. `subject` names it in the messages (e.g.
 * "Provider options") and `fail` raises the error of the caller.
 */
export function frozenJson(
	value: unknown,
	subject: string,
	fail: (reason: string) => never,
	seen = new Set<object>(),
): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "object" || value === null || seen.has(value))
		return fail(`${subject} must be finite, acyclic JSON values.`);
	if (
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	)
		return fail(`${subject} must contain only plain objects and arrays.`);
	if (Object.getOwnPropertySymbols(value).length > 0)
		return fail(`${subject} cannot contain symbol keys.`);
	seen.add(value);
	const result = Array.isArray(value)
		? value.map((item) => frozenJson(item, subject, fail, seen))
		: Object.fromEntries(
				Object.entries(value).map(([key, item]) => [
					key,
					frozenJson(item, subject, fail, seen),
				]),
			);
	seen.delete(value);
	return Object.freeze(result);
}
