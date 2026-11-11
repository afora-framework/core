import { type TSchema, Type } from "typebox";
import { recordPropertyLineage } from "../property/lineage";
import { derivePropertyOf } from "../property/refine";
import type { OptionalProperty } from "../property/types/optional-property.type";
import type { AnyPropertyConstructor } from "../property/types/property-collection.type";
import type { IPropertyType } from "../property/types/property-type.interface";
import { rawTypeOf, schemaOf } from "../schema/schema";
import { withStandard } from "../standard/standard";
import { Kind } from "../symbols/kind";
import { fieldOf } from "./callable";
import { isBlueprint } from "./is-blueprint";
import { isBlueprintList, standardListOf } from "./list";
import { isOptionalRecord, isRecordClass } from "./record-field";
import type {
	AnyBlueprint,
	AnyBlueprintList,
	AnyBlueprintVariant,
	AnyRecordClass,
	BlueprintField,
	OptionalBlueprint,
	OptionalBlueprintList,
	OptionalBlueprintVariant,
	OptionalRecord,
} from "./types/blueprint.interface";
import { isBlueprintVariant, standardVariantOf } from "./variant";

const cache = new WeakMap<BlueprintField, unknown>();

/**
 * The version of `Property` that accepts `undefined`. Returns `Property` itself
 * when it is already optional, and the same class for the same `Property`.
 */
export function optionalOf<Property extends AnyPropertyConstructor>(
	Property: Property,
): OptionalProperty<Property>;
/**
 * The version of `blueprint` that, as a field of another blueprint, accepts
 * `undefined`. Returns `blueprint` itself when it is already optional.
 */
export function optionalOf<Blueprint extends AnyBlueprint>(
	blueprint: Blueprint,
): OptionalBlueprint<Blueprint>;
/** The version of `list` that, as a field of a blueprint, accepts `undefined`. */
export function optionalOf<List extends AnyBlueprintList>(
	list: List,
): OptionalBlueprintList<List>;
/** The version of `variant` that, as a field of a blueprint, accepts `undefined`. */
export function optionalOf<Variant extends AnyBlueprintVariant>(
	variant: Variant,
): OptionalBlueprintVariant<Variant>;
/**
 * The version of `record` that, as a field of a blueprint, accepts `undefined`
 * or an instance of `record`. Returns `record` itself when it is already optional.
 */
export function optionalOf<Record extends AnyRecordClass>(
	record: Record | OptionalRecord<Record>,
): OptionalRecord<Record>;
/** The version of any blueprint field that accepts `undefined`. */
export function optionalOf(field: BlueprintField): BlueprintField;
export function optionalOf(given: BlueprintField): unknown {
	const field = fieldOf(given);
	const cached = cache.get(field);
	if (cached) return cached;

	if (isOptionalRecord(field)) return field;
	if (isRecordClass(field)) {
		const optional = Object.freeze(
			withStandard(
				{
					[Kind]: "record" as const,
					record: field,
					optional: true as const,
				},
				(value) => (value === undefined ? { value } : field.safeParse(value)),
			),
		);
		cache.set(field, optional);
		return optional;
	}

	if (isBlueprint(field)) {
		if (field.optional) return field;

		const optional = {
			...field,
			optional: true,
			safeParse: (value: unknown) =>
				value === undefined ? { value } : field.safeParse(value),
		};
		Object.freeze(withStandard(optional, (value) => optional.safeParse(value)));
		cache.set(field, optional);
		return optional;
	}
	if (isBlueprintList(field)) {
		if (field.optional) return field;

		const optional = standardListOf({ ...field, optional: true });
		cache.set(field, optional);
		return optional;
	}

	if (isBlueprintVariant(field)) {
		if (field.optional) return field;

		const optional = standardVariantOf({ ...field, optional: true });
		cache.set(field, optional);
		return optional;
	}

	const Property = field;
	if (Property.type.optional) return Property;

	const base = Property.type;
	const SchemaConstructor = schemaOf(
		base.name,
		Type.Optional(rawTypeOf(base.schema)),
	);
	const type: IPropertyType<TSchema> = {
		...base,
		schema: new SchemaConstructor(),
		optional: true,
	};

	const Optional = derivePropertyOf(Property, type);
	recordPropertyLineage(Optional, { kind: "optional", base: Property });
	cache.set(Property, Optional);

	return Optional;
}
