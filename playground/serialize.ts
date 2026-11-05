export type Value =
	| null
	| boolean
	| number
	| string
	| Value[]
	| { [key: string]: Value };

/** Snapshot console arguments, honoring domain serialization and limiting large/cyclic values. */
export function snapshot(
	value: unknown,
	seen = new WeakSet<object>(),
	depth = 0,
): Value {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number")
		return Number.isFinite(value) ? value : String(value);
	if (typeof value === "string")
		return value.length > 16000 ? `${value.slice(0, 16000)}…` : value;
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "[Circular]";
	if (depth > 6) return "[Depth limit]";
	seen.add(value);
	try {
		if ("toJSON" in value && typeof value.toJSON === "function")
			return snapshot(value.toJSON(), seen, depth + 1);
		if (value instanceof Error)
			return {
				name: value.name,
				message: value.message,
				stack: value.stack ?? "",
				cause: snapshot(value.cause, seen, depth + 1),
			};
		if (value instanceof Map)
			return snapshot(Array.from(value.entries()), seen, depth + 1);
		if (value instanceof Set)
			return snapshot(Array.from(value), seen, depth + 1);
		if (Array.isArray(value))
			return value.slice(0, 100).map((item) => snapshot(item, seen, depth + 1));
		const result: Record<string, Value> = {};
		for (const key of Object.keys(value).slice(0, 100)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			Object.defineProperty(result, key, {
				value:
					descriptor && "value" in descriptor
						? snapshot(descriptor.value, seen, depth + 1)
						: "[Getter]",
				enumerable: true,
			});
		}
		return result;
	} catch (error) {
		return `[Cannot inspect: ${String(error)}]`;
	} finally {
		seen.delete(value);
	}
}
