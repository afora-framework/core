import type { AnyPropertyConstructor } from "./types/property-collection.type";

/** Whether `value` is a property declaration, and not a blueprint or a list. */
export function isProperty(value: unknown): value is AnyPropertyConstructor {
	return (
		typeof value === "function" &&
		typeof (value as { type?: unknown }).type === "object"
	);
}
