import type {
	AnyBlueprint,
	AnyRecordClass,
	BlueprintData,
	BlueprintInput,
	BlueprintValue,
	IBlueprint,
	IBlueprintCollection,
	RecordAccepts,
} from "../../blueprint/types/blueprint.interface";
import type { ParseResult } from "../../parse/types/parse.interface";
import type { StandardSchemaV1 } from "../../standard/standard-schema";
import type { Kind } from "../../symbols/kind";
import type { Meta } from "../../symbols/meta";
import type { AbstractRecord } from "../abstract-record";
import type {
	AnyRecordPlugin,
	RecordPluginsOption,
	RecordSensitiveKeys,
	RecordUniqueKeys,
} from "./plugin.interface";

/** The value of a record, read from its blueprint. */
export type RecordValue<Record extends AnyRecordShape> = Record extends {
	readonly [Meta]: { readonly blueprint: IBlueprint<infer Properties> };
}
	? BlueprintValue<Properties>
	: Record extends { readonly blueprint: IBlueprint<infer Properties> }
		? BlueprintValue<Properties>
		: never;

/** A record instance's metadata, or a record class's statics. */
type AnyRecordShape =
	| { readonly blueprint: AnyBlueprint }
	| { readonly [Meta]: { readonly blueprint: AnyBlueprint } };

/** A side effect of a change to a key: its new value and the one it replaced. */
export type RecordEffect<Value> = (value: Value, previous: Value) => void;

/** The effects of a record, by the keys of its blueprint, e.g. `{ name: (value) => ... }`. */
export type RecordEffects<Record extends AnyRecordShape> = {
	readonly [Key in keyof RecordValue<Record>]?: RecordEffect<
		RecordValue<Record>[Key]
	>;
};

/**
 * A change to any key of a record: the key, its new value and the one it
 * replaced; checking `key` narrows `value` and `previous`.
 */
export type RecordChange<Record extends AnyRecordShape> = {
	readonly [Key in keyof RecordValue<Record>]-?: {
		readonly key: Key;
		readonly value: RecordValue<Record>[Key];
		readonly previous: RecordValue<Record>[Key];
	};
}[keyof RecordValue<Record>];

/** A key of the blueprint of a record. */
export type RecordKey<Properties extends IBlueprintCollection> =
	keyof Properties & string;

/** What `recordOf` takes, after the blueprint, to describe its keys. */
export interface RecordOptions<
	Properties extends IBlueprintCollection,
	Change extends
		readonly RecordKey<Properties>[] = readonly RecordKey<Properties>[],
	Unique extends
		readonly RecordKey<Properties>[] = readonly RecordKey<Properties>[],
	Plugins extends readonly AnyRecordPlugin[] = readonly AnyRecordPlugin[],
	Context = unknown,
	Sensitive extends
		readonly RecordKey<Properties>[] = readonly RecordKey<Properties>[],
> {
	/**
	 * The name of the record, read with `recordNameOf(Class)` (or
	 * `Class.recordName`): an identifier that stays the same when a bundler
	 * renames the class. It names the record in exceptions, in the context a
	 * repository gives its provider (`context.name` is `<name>Repository`) and
	 * in OpenAPI. Without it, the name of the class is used.
	 */
	readonly name?: string;
	/**
	 * Keys whose values `toJSON` masks, every leaf as `MASK`, at any depth. A
	 * key holding a property declared `sensitive` (as `Password`), or a list of
	 * them, is always sensitive, and such a property is masked at any depth.
	 */
	readonly sensitive?: Sensitive;
	/**
	 * Keys whose value no two records may share. Records only list them in
	 * `options.unique`: repositories (or the database) enforce it. A key
	 * holding a property declared `unique` (as `Slug`), optional or not, is
	 * always listed.
	 */
	readonly unique?: Unique;
	/** Keys that get a `change.<key>` method, e.g. `change.password`. */
	readonly change?: Change;
	/**
	 * Plugins made by `recordPluginOf`, or a function picking them from the
	 * plugins of the builder's catalogs, as `(ctx) => [ctx.publishable]`. Each
	 * adds the keys, options, methods and `onSet` effects of its record class.
	 */
	readonly plugins?: RecordPluginsOption<Plugins, Context>;
}

/** The keys holding a property declared `unique`, as `Slug`, optional or not. */
export type MarkedUniqueKey<Properties extends IBlueprintCollection> = {
	[Key in keyof Properties]-?: Properties[Key] extends {
		readonly type: { readonly unique: true };
	}
		? Key
		: never;
}[keyof Properties] &
	string;

/** The options of a record, with every key resolved. */
export interface RecordSettings<Properties extends IBlueprintCollection> {
	readonly sensitive: readonly RecordKey<Properties>[];
	readonly unique: readonly RecordKey<Properties>[];
	readonly change: readonly RecordKey<Properties>[];
}

/**
 * The `change` namespace of a record: `change.<key>(value)` for each key of
 * `Change`, which `set`s it and returns the record. Absent when `Change` is empty.
 */
export type RecordChanges<
	Properties extends IBlueprintCollection,
	Change extends readonly string[],
> = [Change[number]] extends [never]
	? unknown
	: RecordChangeNamespace<Properties, Change>;

/** The record with a `change` member; `this` is the record. */
interface RecordChangeNamespace<
	Properties extends IBlueprintCollection,
	Change extends readonly string[],
> {
	readonly change: RecordChangeMethods<this, Properties, Change[number]>;
}

/** `change.<key>(value)` for each of `Key`, returning `Self`. */
type RecordChangeMethods<
	Self,
	Properties extends IBlueprintCollection,
	Key extends string,
> = {
	readonly [K in Key]: (
		value: K extends keyof BlueprintValue<Properties>
			? BlueprintValue<Properties>[K]
			: never,
	) => Self;
};

/**
 * A sensitive value as `toJSON` gives it: each leaf (string, number, boolean,
 * bigint) is the string `MASK`; lists and objects keep their shape, and
 * `null` and `undefined` stay.
 */
export type Masked<Value> = Value extends null | undefined
	? Value
	: Value extends readonly (infer Item)[]
		? Masked<Item>[]
		: Value extends object
			? { readonly [Key in keyof Value]: Masked<Value[Key]> }
			: string;

/** What `toJSON` gives for `Field`, whose plain value is `Data`. */
type JsonField<Field, Data> = Field extends {
	readonly type: { readonly sensitive: true };
}
	? Masked<Data>
	: Field extends { readonly type: unknown }
		? Data
		: Field extends AnyRecordClass
			? JsonOfRecord<Field, Data>
			: Field extends { readonly record: infer Class extends AnyRecordClass }
				? JsonOfRecord<Class, Data>
				: Field extends {
							readonly properties: infer Properties extends
								IBlueprintCollection;
						}
					? Data extends object
						? JsonKeys<Properties, Data, never>
						: Data
					: Field extends { readonly item: infer Item }
						? Data extends readonly (infer ItemData)[]
							? JsonField<Item, ItemData>[]
							: Data
						: Data;

/** What the `toJSON` of the records of `Class` gives, in place of their plain value. */
type JsonOfRecord<Class extends AnyRecordClass, Data> =
	InstanceType<Class> extends { toJSON(): infer Json }
		? Data extends object
			? Json
			: Data
		: Data;

/**
 * `Data`, the plain value of `Properties`, key by key as `toJSON` gives it.
 * `Result` is a parameter so that no alias names the object.
 */
type JsonKeys<
	Properties,
	Data,
	Sensitive,
	Result = {
		readonly [Key in keyof Data]: Key extends Sensitive
			? Masked<Data[Key]>
			: Key extends keyof Properties
				? JsonField<Properties[Key], Data[Key]>
				: Data[Key];
	},
> = Result;

/**
 * What `toJSON` of a record of `Properties` gives: every key of its plain
 * value, with the keys of `Sensitive` and every property declared
 * `sensitive`, at any depth, as `Masked`. `Result` is a parameter so that no
 * alias names the object.
 */
type JsonValue<
	Properties extends IBlueprintCollection,
	Sensitive,
	Result = 0 extends 1 & Properties
		? Readonly<Record<string, unknown>>
		: string extends keyof Properties
			? Readonly<Record<string, unknown>>
			: JsonKeys<Properties, BlueprintData<Properties>, Sensitive>,
> = Result;

/**
 * The type of `toJSON()` of a record of `Properties` whose `options.sensitive`
 * lists `Sensitive`: the plain value, no key left out, sensitive values masked.
 */
export type RecordJson<
	Properties extends IBlueprintCollection,
	Sensitive extends string = never,
> = JsonValue<Properties, Sensitive>;

export interface IRecord<
	Properties extends IBlueprintCollection,
	Sensitive extends string = never,
> {
	/** Declaration metadata, separate from domain keys. */
	readonly [Meta]: {
		readonly blueprint: IBlueprint<Properties>;
		readonly options: RecordSettings<Properties>;
	};
	/** The value with the sensitive keys, and every `sensitive` property, masked. */
	toJSON(): RecordJson<Properties, Sensitive>;
}

/**
 * The records of the class `recordOf` returns, with what its plugins add,
 * `Members`.
 */
export type DeclaredRecordInstance<
	Properties extends IBlueprintCollection,
	Change extends readonly string[],
	Members = unknown,
	Sensitive extends string = never,
> = AbstractRecord<Properties, Sensitive> &
	Readonly<BlueprintValue<Properties>> &
	RecordChanges<Properties, Change> &
	Members;

/**
 * What `recordOf` returns: a class built from the value of the blueprint;
 * `Unique` are the keys of `options.unique`, and `Members` what its plugins
 * add to its records.
 */
export type RecordConstructor<
	Properties extends IBlueprintCollection,
	Change extends readonly string[],
	Unique extends string = never,
	Members = unknown,
	Accepts = never,
	Sensitive extends string = never,
> = {
	new (
		value: BlueprintInput<Properties>,
	): DeclaredRecordInstance<Properties, Change, Members, Sensitive>;
	/**
	 * The Standard Schema of the class: `validate` gives an instance of it, or
	 * the issues that reject the value. Typed with the instance of the class
	 * `recordOf` returns, not of a subclass.
	 */
	readonly "~standard": StandardSchemaV1.Props<
		BlueprintInput<Properties>,
		DeclaredRecordInstance<Properties, Change, Members, Sensitive>
	>;
	/**
	 * An instance of the class (a subclass included) for `value`, or every
	 * issue that rejects it; never throws for an invalid value.
	 */
	safeParse<Self extends new (value: never) => object>(
		this: Self,
		value: unknown,
	): ParseResult<InstanceType<Self>>;
	readonly [Kind]: "record";
	/**
	 * The name of the class as declared: the `name` option, which a bundler
	 * does not rename, or the name of the class without one. A subclass may
	 * give its own with `static override readonly recordName = "..."`.
	 */
	readonly recordName: string;
	readonly blueprint: IBlueprint<Properties>;
	readonly options: RecordSettings<Properties>;
	/** Its plugins, those they require included, each once. */
	readonly plugins: readonly AnyRecordPlugin[];
	/** The keys of `options.unique`, for the type of a plugin of the class. */
	readonly [RecordUniqueKeys]?: Unique;
	/** The keys of `options.sensitive`, for the type of a plugin of the class. */
	readonly [RecordSensitiveKeys]?: Sensitive;
	/** More values a field of this class takes, as a sliced record takes the original's records. */
	readonly [RecordAccepts]?: Accepts;
};
