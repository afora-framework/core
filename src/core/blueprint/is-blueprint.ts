import { Kind } from "../symbols/kind";
import type { AnyBlueprint } from "./types/blueprint.interface";

/** Whether `value` is a blueprint, and not a property, a plugin or a list. */
export function isBlueprint(value: unknown): value is AnyBlueprint {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "blueprint"
	);
}
