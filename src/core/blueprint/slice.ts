import { AbstractRecord } from "../record/abstract-record";
import { declareRecord } from "../record/record";
import { blueprintFromProperties } from "./blueprint";
import { UndeclaredBlueprintProperty } from "./exceptions";
import { isBlueprint } from "./is-blueprint";
import { isBlueprintList, listOf } from "./list";
import { optionalOf } from "./optional";
import { isRecordClass, recordFieldOf } from "./record-field";
import type {
	AnyBlueprint,
	AnyRecordClass,
	BlueprintField,
	IBlueprintCollection,
} from "./types/blueprint.interface";
import type {
	ExactMask,
	MaskOf,
	PropertiesOf,
	SlicedBlueprint,
	SlicedValue,
	SliceMask,
	ValueMask,
} from "./types/slice.interface";

type Mask = { readonly [key: string]: true | Mask | undefined };

/** The keys of the blueprint, or record class, a field stands for, through lists. */
function propertiesOfField(
	field: BlueprintField | undefined,
): IBlueprintCollection | undefined {
	if (field === undefined) return undefined;
	if (isBlueprintList(field)) return propertiesOfField(field.item);
	const record = recordFieldOf(field);
	if (record) return record.record.blueprint.properties;
	return isBlueprint(field) ? field.properties : undefined;
}

/**
 * The mask a blueprint or record class stands for, or `selector` itself when
 * it is a mask. `against` are the properties the mask will slice: a nested
 * blueprint or record the selector shares with them is selected whole.
 */
function maskOf(selector: unknown, against?: IBlueprintCollection): Mask {
	if (isRecordClass(selector)) return maskOf(selector.blueprint, against);
	if (isBlueprint(selector)) {
		return Object.fromEntries(
			Object.entries(selector.properties as IBlueprintCollection).map(
				([key, field]) => [key, fieldMaskOf(field, against?.[key])],
			),
		);
	}
	return selector as Mask;
}

function fieldMaskOf(
	field: BlueprintField,
	other: BlueprintField | undefined,
): true | Mask {
	if (isBlueprintList(field)) {
		return fieldMaskOf(field.item, isBlueprintList(other) ? other.item : other);
	}
	const record = recordFieldOf(field);
	if (record) {
		if (record.record === recordFieldOf(other)?.record) return true;
		return maskOf(record.record, propertiesOfField(other));
	}
	if (isBlueprint(field)) {
		return field === other ? true : maskOf(field, propertiesOfField(other));
	}
	return true;
}

function sliceCollection(
	properties: IBlueprintCollection,
	mask: Mask,
	path: string,
): IBlueprintCollection {
	const sliced: Record<string, BlueprintField> = {};
	for (const [key, selected] of Object.entries(mask)) {
		if (!selected) continue;
		if (!Object.hasOwn(properties, key)) {
			throw new UndeclaredBlueprintProperty({
				source: "blueprint",
				details: { key: path + key },
			});
		}
		sliced[key] = sliceField(
			properties[key] as BlueprintField,
			selected,
			path + key,
		);
	}
	return sliced;
}

/**
 * A record class of the keys `mask` names in `Original`, which keeps what the
 * record declares about them: `sensitive`, `unique` and `change`. It is a
 * plain record, not an entity: the identity keys are in it only if `mask`
 * names them, and it has no events, `destroy` or plugin members. It accepts
 * the instances of `Original`.
 */
function slicedRecordOf(
	Original: AnyRecordClass,
	mask: Mask,
	path: string,
): AnyRecordClass {
	const source = Original.blueprint;
	const blueprint = blueprintFromProperties(
		source.plugins,
		sliceCollection(source.properties, mask, `${path}.`),
	);
	const kept = (keys: readonly string[]) =>
		keys.filter((key) => Object.hasOwn(blueprint.properties, key));
	const { sensitive, unique, change } = (
		Original as unknown as { readonly options: object }
	).options as {
		readonly [Option in "sensitive" | "unique" | "change"]: readonly string[];
	};
	const Sliced = declareRecord(
		AbstractRecord,
		blueprint,
		{
			sensitive: kept(sensitive),
			unique: kept(unique),
			change: kept(change),
		},
		Original.name,
	);
	Object.defineProperty(Sliced, Symbol.hasInstance, {
		value(this: object, value: unknown) {
			return (
				Function.prototype[Symbol.hasInstance].call(this, value) ||
				value instanceof Original
			);
		},
	});
	return Sliced as unknown as AnyRecordClass;
}

function sliceField(
	field: BlueprintField,
	selected: true | Mask,
	path: string,
): BlueprintField {
	if (selected === true) return field;
	if (isBlueprintList(field)) {
		const list = listOf(sliceField(field.item, selected, path), {
			minItems: field.minItems,
			maxItems: field.maxItems,
		});
		return field.optional ? optionalOf(list) : list;
	}
	const record = recordFieldOf(field);
	if (record) {
		const sliced = slicedRecordOf(record.record, selected, path);
		return record.optional ? optionalOf(sliced) : sliced;
	}
	if (isBlueprint(field)) {
		const sliced = blueprintFromProperties(
			field.plugins,
			sliceCollection(field.properties, selected, `${path}.`),
		);
		return field.optional ? optionalOf(sliced) : sliced;
	}
	// A property has no keys to pick from.
	throw new UndeclaredBlueprintProperty({
		source: "blueprint",
		details: { key: `${path}.${Object.keys(selected)[0] ?? ""}` },
	});
}

/**
 * A new blueprint with only the fields of `blueprint` that `selector` names,
 * recursively into nested blueprints, records and lists (whose wrappers,
 * optionality and flags are kept). `selector` is a mask, as
 * `{ name: true, address: { city: true } }`, or a blueprint or record class,
 * whose keys, at any depth, are the mask. A key `blueprint` does not have
 * throws `UndeclaredBlueprintProperty`, and is a type error for a mask.
 */
export const sliceOf: {
	<const Blueprint extends AnyBlueprint, const Selector>(
		blueprint: Blueprint,
		selector: ExactMask<Selector, SliceMask<PropertiesOf<Blueprint>>>,
	): NoInfer<SlicedBlueprint<PropertiesOf<Blueprint>, Selector>>;
	<
		const Blueprint extends AnyBlueprint,
		const Selector extends AnyBlueprint | AnyRecordClass,
	>(
		blueprint: Blueprint,
		selector: MaskOf<Selector> extends SliceMask<PropertiesOf<Blueprint>>
			? Selector
			: never,
	): NoInfer<SlicedBlueprint<PropertiesOf<Blueprint>, MaskOf<Selector>>>;
} = ((blueprint: AnyBlueprint, selector: unknown): unknown =>
	blueprintFromProperties(
		blueprint.plugins,
		sliceCollection(
			blueprint.properties,
			maskOf(selector, blueprint.properties),
			"",
		),
	)) as never;

/**
 * `value` with only the keys `selector` names, recursively through objects and
 * lists, without validating it. A record instance is read by its `toJSON`, so
 * what is sensitive stays masked; a plain object is copied as it is. A key
 * missing from `value` is left out. `selector` is a mask or a blueprint or
 * record class, as for `sliceOf`.
 */
export const sliceValue: {
	<Value, const Selector extends AnyBlueprint | AnyRecordClass>(
		value: Value,
		selector: Selector,
	): SlicedValue<Value, MaskOf<Selector>>;
	<Value, const Selector extends ValueMask>(
		value: Value,
		selector: Selector,
	): SlicedValue<Value, Selector>;
} = ((value: unknown, selector: unknown): unknown =>
	pick(value, maskOf(selector))) as never;

function pick(value: unknown, mask: Mask): unknown {
	if (Array.isArray(value)) return value.map((item) => pick(item, mask));
	if (typeof value !== "object" || value === null) return value;

	const source = (
		isRecordClass(value.constructor)
			? (value as { toJSON(): unknown }).toJSON()
			: value
	) as Readonly<Record<string, unknown>>;
	const picked: Record<string, unknown> = {};
	for (const [key, selected] of Object.entries(mask)) {
		if (!selected || !Object.hasOwn(source, key)) continue;
		picked[key] = selected === true ? source[key] : pick(source[key], selected);
	}
	return picked;
}
