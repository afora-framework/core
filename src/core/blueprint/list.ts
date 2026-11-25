import { parseField } from "../parse/parse";
import type { ParseResult } from "../parse/types/parse.interface";
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

/**
 * `list`, frozen, with the `~standard` and the `safeParse` that handle a value
 * as `list` does. Both close over `list` itself and are not enumerable, so a
 * copy of it (`{ ...list, optional: true }`) gets its own, never this one.
 */
export function standardListOf<List extends object>(list: List): List {
	const parse = (value: unknown): ParseResult<unknown> =>
		parseField(list as unknown as AnyBlueprintList, value, [], "list");
	Object.defineProperty(list, "safeParse", {
		value: parse,
		enumerable: false,
	});
	return Object.freeze(withStandard(list, parse));
}

/** Whether `value` is a list made by `listOf`. */
export function isBlueprintList(value: unknown): value is AnyBlueprintList {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "list"
	);
}
