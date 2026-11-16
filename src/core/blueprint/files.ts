import { isProperty } from "../property/is-property";
import { rawTypeOf } from "../schema/schema";
import { isBlueprint } from "./is-blueprint";
import { isBlueprintList } from "./list";
import { recordFieldOf } from "./record-field";
import type {
	AnyRecordClass,
	BlueprintField,
	BlueprintVariants,
	IBlueprintCollection,
} from "./types/blueprint.interface";
import { isBlueprintVariant } from "./variant";

/**
 * Whether `field` holds a file (its schema is `format: "binary"`, as
 * `fileOf`), or a list of files.
 * @internal
 */
export function isFileField(field: unknown): boolean {
	if (isBlueprintList(field)) return isFileField(field.item);
	return (
		isProperty(field) &&
		(rawTypeOf(field.type.schema) as { format?: unknown }).format === "binary"
	);
}

/**
 * The path of the first file held by `properties`, at any depth (nested
 * blueprints, lists, variants, records); `undefined` when it holds none.
 * @internal
 */
export function filePathOf(
	properties: IBlueprintCollection,
	seen: Set<AnyRecordClass> = new Set(),
): readonly string[] | undefined {
	const visit = (field: BlueprintField): readonly string[] | undefined => {
		if (isFileField(field)) return [];
		if (isBlueprintList(field)) return visit(field.item);
		if (isBlueprint(field)) return filePathOf(field.properties, seen);
		if (isBlueprintVariant(field)) {
			for (const [tag, variant] of Object.entries(
				field.variants as BlueprintVariants,
			)) {
				const found = visit(variant as BlueprintField);
				if (found) return [tag, ...found];
			}
			return undefined;
		}
		const record = recordFieldOf(field)?.record;
		if (record && !seen.has(record)) {
			seen.add(record);
			return filePathOf(record.blueprint.properties, seen);
		}
		return undefined;
	};
	for (const [key, field] of Object.entries(properties)) {
		const found = visit(field);
		if (found) return [key, ...found];
	}
	return undefined;
}
