import type {
	Static,
	TArray,
	TObject,
	TOptional,
	TReadonly,
	TSchema,
	TUnsafe,
} from "typebox";
import type { ParseResult } from "../../parse/types/parse.interface";
import type { propertyOf } from "../../property/property";
import type { OptionalProperty } from "../../property/types/optional-property.type";
import type { AnyPropertyConstructor } from "../../property/types/property-collection.type";
import type {
	CallableProperty,
	StoredFields,
} from "../../property/types/property-options.interface";
import type { IPropertyType } from "../../property/types/property-type.interface";
import type { ISchema } from "../../schema/types/schema.interface";
import type { StandardSchemaV1 } from "../../standard/standard-schema";
import type { Kind } from "../../symbols/kind";
import type { listOf } from "../list";
import type { optionalOf } from "../optional";
import type {
	IBlueprintFactories,
	IBlueprintPlugin,
} from "./blueprint-plugin.interface";

/** Any blueprint, whatever its properties, optional or not. */
// biome-ignore lint/suspicious/noExplicitAny: any blueprint, whatever its properties
export type AnyBlueprint = IBlueprint<any, boolean>;

/** Any list, whatever its item, optional or not. */
// biome-ignore lint/suspicious/noExplicitAny: any list, whatever its item
export type AnyBlueprintList = IBlueprintList<any, boolean>;

/**
 * Any class made by `recordOf`, or extending one, e.g. `User`: as a field, it
 * holds an instance of the class.
 */
export interface AnyRecordClass {
	readonly [Kind]: "record";
	readonly blueprint: AnyBlueprint;
	// biome-ignore lint/suspicious/noExplicitAny: any record, whatever its value
	new (value: any): object;
	/** An instance of the record for `value`, or every issue that rejects it. */
	safeParse(value: unknown): ParseResult<object>;
	/** The Standard Schema of the record, whose `validate` gives an instance. */
	readonly "~standard": StandardSchemaV1.Props;
}

/** `Record` as a field that accepts `undefined`, made by `optionalOf`. */
export interface OptionalRecord<Record extends AnyRecordClass> {
	readonly [Kind]: "record";
	readonly record: Record;
	readonly optional: true;
	/** The Standard Schema of the record that also accepts `undefined`. */
	readonly "~standard": StandardSchemaV1.Props<
		StandardSchemaV1.InferInput<Record> | undefined,
		InstanceType<Record> | undefined
	>;
}

/** Any record made optional by `optionalOf`. */
export type AnyOptionalRecord = OptionalRecord<AnyRecordClass>;

/**
 * What a blueprint key holds: a property, a blueprint for a nested object, a
 * record, or a list of any of them.
 */
export type BlueprintField =
	| AnyPropertyConstructor
	| AnyBlueprint
	| AnyBlueprintList
	| AnyRecordClass
	| AnyOptionalRecord;

/** Fields by key, e.g. `{ name: Name, address: Address }`. */
export type IBlueprintCollection = Record<string, BlueprintField>;

/** What a blueprint picks its fields from: a plugin, or another blueprint. */
export type BlueprintSource = IBlueprintPlugin | AnyBlueprint;

/**
 * How a record field is described: `"data"` is the object of its blueprint,
 * `"value"` an instance of its class, and `"input"` either of the two, or the
 * plain object of its blueprint's input.
 */
type FieldMode = "data" | "value" | "input";

/**
 * The schema of a single field of a blueprint, its records as `Mode` says. A
 * field of `any` (as `AnyBlueprint`'s) is any schema, or a record would
 * recurse into `AnyBlueprint` endlessly.
 */
type FieldSchema<Field, Mode extends FieldMode> = 0 extends 1 & Field
	? TSchema
	: Field extends {
				// biome-ignore lint/suspicious/noExplicitAny: only the schema is inferred
				readonly type: IPropertyType<infer SchemaType extends TSchema, any>;
			}
		? SchemaType
		: Field extends AnyRecordClass
			? RecordSchema<Field, Mode>
			: Field extends OptionalRecord<infer Record>
				? TOptional<RecordSchema<Record, Mode>>
				: Field extends {
							readonly properties: infer Properties extends
								IBlueprintCollection;
							readonly optional: infer Optional;
						}
					? Optional extends true
						? TOptional<CollectionSchema<Properties, Mode>>
						: CollectionSchema<Properties, Mode>
					: Field extends {
								readonly item: infer Item;
								readonly optional: infer Optional;
							}
						? Optional extends true
							? TOptional<TArray<FieldSchema<Item, Mode>>>
							: TArray<FieldSchema<Item, Mode>>
						: never;

/** Declares the records a field of a record class takes besides its own. */
export declare const RecordAccepts: unique symbol;

/** The values besides its instances and plain input that a field of `Record` takes. */
type AcceptedBy<Record> = Record extends {
	readonly [RecordAccepts]?: infer Accepts;
}
	? unknown extends Accepts
		? never
		: NonNullable<Accepts>
	: never;

type RecordSchema<
	Record extends AnyRecordClass,
	Mode extends FieldMode,
> = Mode extends "value"
	? TUnsafe<InstanceType<Record>>
	: Mode extends "input"
		? TUnsafe<InstanceType<Record> | RecordInput<Record> | AcceptedBy<Record>>
		: Record["blueprint"] extends IBlueprint<infer Properties, boolean>
			? BlueprintSchema<Properties>
			: never;

/**
 * The plain value the constructor of `Record` takes: the input of its
 * blueprint, or, for an entity, that input with its identity optional. Any
 * object for a record of any blueprint.
 */
type RecordInput<Record extends AnyRecordClass> =
	ConstructorParameters<Record>[0] extends infer Input
		? 0 extends 1 & Input
			? object
			: Input
		: never;

type CollectionSchema<
	Properties extends IBlueprintCollection,
	Mode extends FieldMode,
> = TObject<{
	[Key in keyof Properties]: FieldSchema<Properties[Key], Mode>;
}>;

/**
 * The schema of a single field of a blueprint; a record is its blueprint's object.
 * @internal
 */
export type BlueprintPropertySchema<Field> = FieldSchema<Field, "data">;

/** The object schema described by a collection, one key per field. */
export type BlueprintSchema<Properties extends IBlueprintCollection> =
	CollectionSchema<Properties, "data">;

/**
 * The value of a single field of a blueprint, its records as `Mode` says:
 * `Static` of its `FieldSchema`, read from the fields themselves. A property
 * gives the value its type carries, so `Static` is never measured on a
 * generic schema, which costs TypeScript about a second on every check.
 */
type FieldValue<Field, Mode extends FieldMode> = 0 extends 1 & Field
	? Static<TSchema>
	: Field extends {
				readonly type: IPropertyType<infer SchemaType, infer Value>;
			}
		? 0 extends 1 & SchemaType
			? Static<TSchema>
			: Value
		: Field extends AnyRecordClass
			? RecordValueOf<Field, Mode>
			: Field extends OptionalRecord<infer Record>
				? RecordValueOf<Record, Mode>
				: Field extends {
							readonly properties: infer Properties extends
								IBlueprintCollection;
						}
					? CollectionValue<Properties, Mode>
					: Field extends { readonly item: infer Item }
						? FieldValue<Item, Mode>[]
						: never;

/** The value of a record field, as `RecordSchema` describes it. */
type RecordValueOf<
	Record extends AnyRecordClass,
	Mode extends FieldMode,
> = Mode extends "value"
	? InstanceType<Record>
	: Mode extends "input"
		? InstanceType<Record> | RecordInput<Record> | AcceptedBy<Record>
		: Record["blueprint"] extends IBlueprint<infer Properties, boolean>
			? CollectionValue<Properties, "data">
			: never;

/*
 * The keys of an object schema by their modifiers, as TypeBox sorts them to
 * build its value. They only read the schemas, never `Static`.
 */
type ReadonlyOptionalKeys<Schemas> = {
	[Key in keyof Schemas]: Schemas[Key] extends TReadonly<TSchema>
		? Schemas[Key] extends TOptional<Schemas[Key]>
			? Key
			: never
		: never;
}[keyof Schemas];
type ReadonlyKeys<Schemas> = {
	[Key in keyof Schemas]: Schemas[Key] extends TReadonly<TSchema>
		? Schemas[Key] extends TOptional<Schemas[Key]>
			? never
			: Key
		: never;
}[keyof Schemas];
type OptionalKeys<Schemas> = {
	[Key in keyof Schemas]: Schemas[Key] extends TOptional<TSchema>
		? Schemas[Key] extends TReadonly<Schemas[Key]>
			? never
			: Key
		: never;
}[keyof Schemas];
type RequiredKeys<Schemas> = keyof Omit<
	Schemas,
	ReadonlyOptionalKeys<Schemas> | ReadonlyKeys<Schemas> | OptionalKeys<Schemas>
>;

/**
 * `Static` of `CollectionSchema`, built as TypeBox builds the value of an
 * object (the same keys and modifiers, in the same order, so it displays the
 * same), but from the value of each field. `Result` is a parameter so that no
 * alias names the object.
 */
type CollectionValue<
	Properties extends IBlueprintCollection,
	Mode extends FieldMode,
	Schemas = { [Key in keyof Properties]: FieldSchema<Properties[Key], Mode> },
	Values extends Record<PropertyKey, unknown> = {
		[Key in keyof Properties]: FieldValue<Properties[Key], Mode>;
	},
	WithModifiers extends Record<PropertyKey, unknown> = Evaluate<
		Readonly<Partial<Pick<Values, ReadonlyOptionalKeys<Schemas>>>> &
			Readonly<Pick<Values, ReadonlyKeys<Schemas>>> &
			Partial<Pick<Values, OptionalKeys<Schemas>>> &
			Required<Pick<Values, RequiredKeys<Schemas>>>
	>,
	Result = keyof Properties extends never
		? object
		: { [Key in keyof WithModifiers]: WithModifiers[Key] },
> = Result;

type Evaluate<Type> = { [Key in keyof Type]: Type[Key] } & {};

/**
 * The value accepted by a collection; optional fields become optional keys,
 * and a record field takes an instance of its class, e.g. `{ author: User }`.
 */
export type BlueprintValue<Properties extends IBlueprintCollection> =
	CollectionValue<Properties, "value">;

/**
 * What a blueprint accepts to build its value: as `BlueprintValue`, but a
 * record field also takes the plain input of its blueprint, which becomes an
 * instance of the record, e.g. `{ author: { name: "Jane" } }`.
 */
export type BlueprintInput<Properties extends IBlueprintCollection> =
	CollectionValue<Properties, "input">;

/**
 * The plain value of a collection, as its schema describes it: a record
 * field is the object of the record's blueprint, as its `toJSON` gives.
 */
export type BlueprintData<Properties extends IBlueprintCollection> =
	CollectionValue<Properties, "data">;

type Override<Base, Overrides> = {
	[Key in keyof Base | keyof Overrides]: Key extends keyof Overrides
		? Overrides[Key]
		: Key extends keyof Base
			? Base[Key]
			: never;
};

/**
 * The fields of every source, in order, handed to a blueprint to pick from;
 * a later source replaces a key of an earlier one with the same name.
 */
export type BlueprintPluginContext<
	Sources extends readonly { readonly properties: IBlueprintCollection }[],
> = Sources extends readonly [
	infer Head extends { readonly properties: IBlueprintCollection },
	...infer Tail extends readonly {
		readonly properties: IBlueprintCollection;
	}[],
]
	? Override<Head["properties"], BlueprintPluginContext<Tail>>
	: Record<never, never>;

/**
 * The field factories of every plugin source, in order; a later source
 * replaces a factory of an earlier one with the same name.
 * @internal
 */
export type BlueprintFactoryContext<
	Sources extends readonly BlueprintSource[],
> = Sources extends readonly [
	infer Head,
	...infer Tail extends readonly BlueprintSource[],
]
	? Override<
			Head extends { readonly factories?: infer Factories }
				? NonNullable<Factories> extends infer Defined extends
						IBlueprintFactories
					? string extends keyof Defined
						? Record<never, never>
						: Defined
					: Record<never, never>
				: Record<never, never>,
			BlueprintFactoryContext<Tail>
		>
	: Record<never, never>;

/**
 * The fields of the joined blueprints; a later one replaces a key of an earlier one.
 * @internal
 */
export type JoinedProperties<
	Blueprints extends readonly { readonly properties: IBlueprintCollection }[],
> =
	BlueprintPluginContext<Blueprints> extends infer Properties extends
		IBlueprintCollection
		? Properties
		: never;

/**
 * A list of every field of a collection, e.g. `{ tags: IBlueprintList<Tag> }`.
 * @internal
 */
export type ListProperties<Properties> = {
	readonly [Key in keyof Properties]: Properties[Key] extends BlueprintField
		? IBlueprintList<Properties[Key]>
		: never;
};

/** The source fields of a context, less those a factory replaces. */
type ContextFields<Sources extends readonly BlueprintSource[]> = Omit<
	BlueprintPluginContext<Sources>,
	keyof BlueprintFactoryContext<Sources>
>;

/** The functions every context has, to make fields inline, as `ctx.listOf(ctx.id)`. */
export interface BlueprintHelpers {
	readonly listOf: typeof listOf;
	readonly optionalOf: typeof optionalOf;
	readonly propertyOf: typeof propertyOf;
}

/**
 * What a blueprint's definition picks from: every source field, the field
 * factories of its plugins (which replace a field with the same name), the
 * `BlueprintHelpers`, plus
 * `optional`, the same fields accepting `undefined`, and `list`, a list of
 * each field, with `list.optional` for the lists accepting `undefined`.
 */
export type BlueprintContext<Sources extends readonly BlueprintSource[]> =
	CallableProperties<ContextFields<Sources>> &
		BlueprintFactoryContext<Sources> &
		BlueprintHelpers & {
			readonly optional: CallableProperties<
				OptionalProperties<ContextFields<Sources>>
			>;
			readonly list: ListProperties<ContextFields<Sources>> & {
				readonly optional: OptionalProperties<
					ListProperties<ContextFields<Sources>>
				>;
			};
		};

/**
 * Every field of a collection, its properties callable with options, as
 * `ctx.number({ min: 1 })`.
 * @internal
 */
export type CallableProperties<Fields> = {
	readonly [Key in keyof Fields]: Fields[Key] extends AnyPropertyConstructor
		? CallableProperty<Fields[Key]>
		: Fields[Key];
};

/**
 * The optional version of every field of a collection, blueprints and records included.
 * @internal
 */
export type OptionalProperties<Properties> = {
	readonly [Key in keyof Properties]: Properties[Key] extends AnyPropertyConstructor
		? OptionalProperty<Properties[Key]>
		: Properties[Key] extends AnyBlueprint
			? OptionalBlueprint<Properties[Key]>
			: Properties[Key] extends AnyBlueprintList
				? OptionalBlueprintList<Properties[Key]>
				: Properties[Key] extends AnyRecordClass
					? OptionalRecord<Properties[Key]>
					: Properties[Key] extends AnyOptionalRecord
						? Properties[Key]
						: never;
};

export type BlueprintDefinition<
	Sources extends readonly BlueprintSource[],
	Properties extends IBlueprintCollection,
> = (ctx: BlueprintContext<Sources>) => Properties;

export interface IBlueprint<
	Properties extends IBlueprintCollection,
	Optional extends boolean = false,
> {
	readonly [Kind]: "blueprint";
	/** The plugins it was built from, its joined blueprints' included. */
	readonly plugins: readonly IBlueprintPlugin[];
	/** The fields picked by the blueprint's definition. */
	readonly properties: Properties;
	/** The general schema of every field of the blueprint. */
	readonly schema: ISchema<
		BlueprintSchema<Properties>,
		BlueprintData<Properties>
	>;
	/** Whether, as a field of another blueprint, it accepts `undefined`. */
	readonly optional: Optional;
	/**
	 * The value of the blueprint for `value`, each field handled, or every
	 * issue that rejects it; never throws. An optional blueprint accepts
	 * `undefined`.
	 */
	safeParse(
		value: unknown,
	): ParseResult<
		Optional extends true
			? BlueprintValue<Properties> | undefined
			: BlueprintValue<Properties>
	>;
	/**
	 * The Standard Schema of the blueprint: `validate` gives the handled object,
	 * its records as instances, or the issues that reject the value; an optional
	 * blueprint accepts `undefined`.
	 */
	readonly "~standard": StandardSchemaV1.Props<
		Optional extends true
			? BlueprintInput<Properties> | undefined
			: BlueprintInput<Properties>,
		Optional extends true
			? BlueprintValue<Properties> | undefined
			: BlueprintValue<Properties>
	>;
	/**
	 * A new blueprint with the fields of this one and of `blueprints`; a later
	 * one replaces a key of an earlier one.
	 */
	join<const Blueprints extends readonly AnyBlueprint[]>(
		...blueprints: Blueprints
	): IBlueprint<
		JoinedProperties<
			readonly [{ readonly properties: Properties }, ...Blueprints]
		>
	>;
}

/**
 * What `blueprintBuilderOf` returns: `blueprintOf`, building blueprints from
 * the `Base` sources, and from more sources given before the definition.
 */
export interface BlueprintBuilder<Base extends readonly BlueprintSource[]> {
	/** Builds a blueprint from the base sources. */
	<Properties extends IBlueprintCollection>(
		define: BlueprintDefinition<Base, Properties>,
	): IBlueprint<StoredFields<Properties>>;
	/**
	 * Builds a blueprint from the base sources and `sources`, plugins or
	 * blueprints, which come after them and so can replace any of their keys.
	 */
	<
		const Sources extends readonly BlueprintSource[],
		Properties extends IBlueprintCollection,
	>(
		sources: Sources,
		define: BlueprintDefinition<readonly [...Base, ...Sources], Properties>,
	): IBlueprint<StoredFields<Properties>>;
}

/** `Blueprint` as a field that accepts `undefined`. */
export type OptionalBlueprint<Blueprint extends AnyBlueprint> =
	Blueprint extends IBlueprint<infer Properties, boolean>
		? IBlueprint<Properties, true>
		: never;

export interface BlueprintListOptions {
	readonly minItems?: number;
	readonly maxItems?: number;
}

/** A field holding an array of `Item`, a property, a blueprint or a list. */
export interface IBlueprintList<
	Item extends BlueprintField,
	Optional extends boolean = false,
> extends BlueprintListOptions {
	readonly [Kind]: "list";
	readonly item: Item;
	/** Whether, as a field of a blueprint, it accepts `undefined`. */
	readonly optional: Optional;
	/**
	 * The Standard Schema of the list: `validate` gives a frozen array of the
	 * handled items, or the issues that reject the value.
	 */
	readonly "~standard": StandardSchemaV1.Props<
		ListShape<Item, "input", Optional>,
		ListShape<Item, "value", Optional>
	>;
}

type ListShape<
	Item,
	Mode extends FieldMode,
	Optional extends boolean,
> = Optional extends true
	? FieldValue<Item, Mode>[] | undefined
	: FieldValue<Item, Mode>[];

/** `List` as a field that accepts `undefined`. */
export type OptionalBlueprintList<List extends AnyBlueprintList> =
	List extends IBlueprintList<infer Item, boolean>
		? IBlueprintList<Item, true>
		: never;
