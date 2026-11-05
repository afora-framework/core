import { parseField } from "../parse/parse";
import type { StoredField } from "../property/types/property-options.interface";
import { withStandard } from "../standard/standard";
import { Kind } from "../symbols/kind";
import { fieldOf } from "./callable";
import type {
	AnyBlueprintList,
	BlueprintField,
	BlueprintListOptions,
	IBlueprintList,
} from "./types/blueprint.interface";

/**
 * A field holding an array of `item`, e.g. `listOf(Address)` or
 * `listOf(ctx.string, { minItems: 1 })`.
 */
export function listOf<Item extends BlueprintField>(
	item: Item,
	{ minItems, maxItems }: BlueprintListOptions = {},
): IBlueprintList<StoredField<Item>> {
	return standardListOf({
		[Kind]: "list" as const,
		item: fieldOf(item),
		optional: false,
		minItems,
		maxItems,
	}) as IBlueprintList<StoredField<Item>>;
}

/** `list`, frozen, with the `~standard` that handles a value as `list` does. */
export function standardListOf<List extends object>(list: List): List {
	return Object.freeze(
		withStandard(list, (value) =>
			parseField(list as unknown as AnyBlueprintList, value, [], "list"),
		),
	);
}

/** Whether `value` is a list made by `listOf`. */
export function isBlueprintList(value: unknown): value is AnyBlueprintList {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "list"
	);
}
