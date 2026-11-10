import type {
	AnyBlueprint,
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
> {
	/**
	 * Keys whose values `toJSON` masks, every leaf as `MASK`, at any depth. A
	 * key holding a property declared `sensitive` (as `Password`), or a list of
	 * them, is always sensitive, and such a property is masked at any depth.
	 */
	readonly sensitive?: readonly RecordKey<Properties>[];
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

export interface IRecord<Properties extends IBlueprintCollection> {
	/** Declaration metadata, separate from domain keys. */
	readonly [Meta]: {
		readonly blueprint: IBlueprint<Properties>;
		readonly options: RecordSettings<Properties>;
	};
	/** The value with the sensitive keys, and every `sensitive` property, masked. */
	toJSON(): Readonly<Partial<BlueprintData<Properties>>>;
}

/**
 * The records of the class `recordOf` returns, with what its plugins add,
 * `Members`.
 */
export type DeclaredRecordInstance<
	Properties extends IBlueprintCollection,
	Change extends readonly string[],
	Members = unknown,
> = AbstractRecord<Properties> &
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
> = {
	new (
		value: BlueprintInput<Properties>,
	): DeclaredRecordInstance<Properties, Change, Members>;
	/**
	 * The Standard Schema of the class: `validate` gives an instance of it, or
	 * the issues that reject the value. Typed with the instance of the class
	 * `recordOf` returns, not of a subclass.
	 */
	readonly "~standard": StandardSchemaV1.Props<
		BlueprintInput<Properties>,
		DeclaredRecordInstance<Properties, Change, Members>
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
	readonly blueprint: IBlueprint<Properties>;
	readonly options: RecordSettings<Properties>;
	/** Its plugins, those they require included, each once. */
	readonly plugins: readonly AnyRecordPlugin[];
	/** The keys of `options.unique`, for the type of a plugin of the class. */
	readonly [RecordUniqueKeys]?: Unique;
	/** More values a field of this class takes, as a sliced record takes the original's records. */
	readonly [RecordAccepts]?: Accepts;
};
