import type {
	RecordSensitiveKeys,
	RecordUniqueKeys,
} from "../../record/types/plugin.interface";
import type { RecordConstructor } from "../../record/types/record.interface";
import type { Meta } from "../../symbols/meta";
import type {
	AnyBlueprint,
	AnyBlueprintList,
	AnyOptionalRecord,
	AnyRecordClass,
	BlueprintData,
	BlueprintField,
	IBlueprint,
	IBlueprintCollection,
	IBlueprintList,
	OptionalRecord,
} from "./blueprint.interface";

/** What a mask of a field is: the mask of its item, of its keys, or nothing for a property. */
type FieldMask<Field> = 0 extends 1 & Field
	? object
	: Field extends AnyBlueprintList
		? FieldMask<Field["item"]>
		: Field extends AnyBlueprint
			? SliceMask<Field["properties"]>
			: Field extends AnyRecordClass
				? SliceMask<Field["blueprint"]["properties"]>
				: Field extends AnyOptionalRecord
					? SliceMask<Field["record"]["blueprint"]["properties"]>
					: never;

/**
 * The keys of `Properties` a slice keeps: `true` keeps a field whole, a nested
 * mask keeps only its keys, e.g. `{ name: true, address: { city: true } }`.
 */
export type SliceMask<Properties> = {
	readonly [Key in keyof Properties]?: true | FieldMask<Properties[Key]>;
};

/** A mask for values, which have no blueprint to check its keys against. */
export interface ValueMask {
	readonly [key: string]: true | ValueMask | undefined;
}

/** `Mask`, without any key `Allowed` does not have, at any depth. */
export type ExactMask<Mask, Allowed> = [Allowed] extends [never]
	? never
	: {
			readonly [Key in keyof Mask]: Key extends keyof Allowed
				? Mask[Key] extends true
					? Mask[Key]
					: Mask[Key] extends object
						? ExactMask<Mask[Key], Exclude<NonNullable<Allowed[Key]>, true>>
						: never
				: never;
		};

/** The mask a blueprint or record class stands for: its keys, at any depth. */
export type MaskOf<Selector> = Selector extends AnyRecordClass
	? MaskOf<Selector["blueprint"]>
	: Selector extends AnyBlueprint
		? {
				readonly [Key in keyof Selector["properties"]]: FieldMaskOf<
					Selector["properties"][Key]
				>;
			}
		: never;

type FieldMaskOf<Field> = Field extends AnyBlueprintList
	? FieldMaskOf<Field["item"]>
	: Field extends AnyBlueprint | AnyRecordClass
		? MaskOf<Field>
		: Field extends AnyOptionalRecord
			? MaskOf<Field["record"]>
			: true;

type AsBlueprint<Properties, Optional extends boolean> = IBlueprint<
	Extract<Properties, IBlueprintCollection>,
	Optional
>;

type SlicedProperties<Properties, Mask> = {
	[Key in keyof Mask & keyof Properties]: Mask[Key] extends true
		? Properties[Key]
		: SliceField<Properties[Key], Mask[Key]>;
};

type SliceField<Field, Mask> = 0 extends 1 & Field
	? never
	: Field extends AnyBlueprintList
		? SliceField<Field["item"], Mask> extends infer Item extends BlueprintField
			? IBlueprintList<Item, Field["optional"]>
			: never
		: Field extends AnyBlueprint
			? AsBlueprint<
					SlicedProperties<Field["properties"], Mask>,
					Field["optional"]
				>
			: Field extends AnyRecordClass
				? SlicedRecord<Field, Mask>
				: Field extends AnyOptionalRecord
					? SlicedRecord<Field["record"], Mask> extends infer Sliced extends
							AnyRecordClass
						? OptionalRecord<Sliced>
						: never
					: never;

/**
 * The record class of the keys of `Mask` in `Original`, keeping its `unique` and
 * `change` keys among them. A plain record, not an entity.
 */
type SlicedRecord<Original extends AnyRecordClass, Mask> =
	SlicedProperties<
		Original["blueprint"]["properties"],
		Mask
	> extends infer Properties extends IBlueprintCollection
		? RecordConstructor<
				Properties,
				KeptChange<InstanceType<Original>, keyof Properties>[],
				KeptUnique<Original, keyof Properties>,
				unknown,
				{ readonly [Meta]: { readonly blueprint: Original["blueprint"] } },
				KeptSensitive<Original, keyof Properties>
			>
		: never;

type KeptChange<Instance, Keys> = Instance extends {
	readonly change: infer Change;
}
	? Extract<keyof Change, Keys & string>
	: never;

type KeptUnique<Original, Keys> = Original extends {
	readonly [RecordUniqueKeys]?: infer Unique;
}
	? Extract<Unique, Keys & string>
	: never;

type KeptSensitive<Original, Keys> = Original extends {
	readonly [RecordSensitiveKeys]?: infer Sensitive;
}
	? Extract<Sensitive, Keys & string>
	: never;

/** The properties of `Blueprint`, read lazily so generic uses stay shallow. */
export type PropertiesOf<Blueprint> =
	Blueprint extends IBlueprint<infer Properties, boolean> ? Properties : never;

/** The blueprint of `Properties` that keeps only the keys of `Mask`. */
export type SlicedBlueprint<Properties, Mask> = AsBlueprint<
	SlicedProperties<Properties, Mask>,
	false
>;

/**
 * `Value` with only the keys of `Mask`, in objects, records (by `toJSON`, with
 * the keys their blueprint requires) and lists.
 */
export type SlicedValue<Value, Mask> = Value extends readonly (infer Item)[]
	? SlicedValue<Item, Mask>[]
	: Value extends {
				readonly [Meta]: {
					readonly blueprint: IBlueprint<infer Properties, boolean>;
				};
				toJSON(): unknown;
			}
		? SlicedValue<BlueprintData<Properties>, Mask>
		: Value extends { toJSON(): infer Json }
			? SlicedValue<Json, Mask>
			: Value extends object
				? {
						[Key in keyof Value as Key extends keyof Mask
							? Key
							: never]: Key extends keyof Mask
							? Mask[Key] extends true
								? Value[Key]
								: SlicedValue<Value[Key], Mask[Key]>
							: never;
					}
				: Value;
