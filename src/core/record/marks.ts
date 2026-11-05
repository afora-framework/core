import { isBlueprintList } from "../blueprint/list";
import type { BlueprintField } from "../blueprint/types/blueprint.interface";
import { isProperty } from "../property/is-property";

/**
 * Whether `field` is a property declared `sensitive` or `unique`, optional or
 * not, and, with `lists`, a list of them too.
 */
export function isMarked(
	field: BlueprintField | undefined,
	mark: "sensitive" | "unique",
	{ lists = false }: { readonly lists?: boolean } = {},
): boolean {
	if (lists && isBlueprintList(field))
		return isMarked(field.item, mark, { lists });
	return isProperty(field) && field.type[mark] === true;
}
