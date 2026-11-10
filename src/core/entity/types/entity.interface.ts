import type {
	BlueprintField,
	BlueprintInput,
	BlueprintValue,
	IBlueprint,
	IBlueprintCollection,
	JoinedProperties,
} from "../../blueprint/types/blueprint.interface";
import type { ParseResult } from "../../parse/types/parse.interface";
import type {
	AnyRecordPlugin,
	IRecordPluginCatalog,
	PluginMembers,
	PluginSensitiveKey,
	PluginUniqueKey,
	WithPluginProperties,
} from "../../record/types/plugin.interface";
import type {
	MarkedUniqueKey,
	RecordChanges,
	RecordKey,
	RecordOptions,
	RecordSettings,
} from "../../record/types/record.interface";
import type { StandardSchemaV1 } from "../../standard/standard-schema";
import type { Kind } from "../../symbols/kind";
import type { AbstractEntity, EntityUniqueKeys } from "../abstract-entity";

import type { EntityClassBrand, EntityEvents } from "../event";

/** The keys every entity has, which its blueprint cannot declare. */
export type EntityIdentityKey = "id" | "createdAt" | "updatedAt" | "deletedAt";

/**
 * The fields of the identity of an entity: `id` and `createdAt` always hold a
 * value, `updatedAt` and `deletedAt` are optional.
 */
export type IEntityIdentity = {
	readonly [Key in EntityIdentityKey]: BlueprintField;
};

/** What an entity builder needs: the identity fields, and how to make an id and a timestamp. */
export interface EntityBuilderSettings<
	Identity extends IEntityIdentity,
	Catalogs extends readonly IRecordPluginCatalog[] = [],
> {
	/** The blueprint of `id`, `createdAt`, `updatedAt` and `deletedAt`. */
	readonly identity: IBlueprint<Identity>;
	/** A new id, as `id` accepts it. */
	readonly generateId: () => string;
	/** The current date and time, as the timestamps accept it. */
	readonly now: () => string;
	/**
	 * Catalogs of plugins, made by `recordPluginCatalogOf`, that
	 * `options.plugins` picks from, as `(ctx) => [ctx.publishable]`.
	 */
	readonly plugins?: Catalogs;
}

/** The fields of an entity: those of its identity, then those of its blueprint. */
export type EntityProperties<
	Identity extends IEntityIdentity,
	Properties extends IBlueprintCollection,
> = JoinedProperties<
	readonly [
		{ readonly properties: Identity },
		{ readonly properties: Properties },
	]
>;

/**
 * What an entity is built from: the input of its blueprint, and, optionally,
 * its identity, e.g. when loaded from a database. A missing `id` is
 * generated, and a missing `createdAt` is now.
 */
export type EntityInput<
	Identity extends IEntityIdentity,
	Properties extends IBlueprintCollection,
> = BlueprintInput<Properties> & Partial<BlueprintInput<Identity>>;

/** What `entityOf` takes, after the blueprint, to describe its keys. */
export type EntityOptions<
	Properties extends IBlueprintCollection,
	Change extends
		readonly RecordKey<Properties>[] = readonly RecordKey<Properties>[],
	Unique extends
		readonly RecordKey<Properties>[] = readonly RecordKey<Properties>[],
	Plugins extends readonly AnyRecordPlugin[] = readonly AnyRecordPlugin[],
	Context = unknown,
	Sensitive extends
		readonly RecordKey<Properties>[] = readonly RecordKey<Properties>[],
> = RecordOptions<Properties, Change, Unique, Plugins, Context, Sensitive> &
	EntityEvents;

/**
 * The unique keys of an entity: `id`, those listed in `options.unique`, and
 * those holding a property declared `unique`, as `Slug`.
 */
export type EntityUniqueKey<
	Identity extends IEntityIdentity,
	Properties extends IBlueprintCollection,
	Unique extends readonly string[],
> =
	| "id"
	| Unique[number]
	| MarkedUniqueKey<EntityProperties<Identity, Properties>>;

/** The entities of the class `entityOf` returns, with what its plugins add, `Members`. */
export type DeclaredEntityInstance<
	Identity extends IEntityIdentity,
	Properties extends IBlueprintCollection,
	Change extends readonly string[],
	Members = unknown,
	Sensitive extends string = never,
> = AbstractEntity<EntityProperties<Identity, Properties>, Sensitive> &
	Readonly<BlueprintValue<EntityProperties<Identity, Properties>>> &
	RecordChanges<Properties, Change> &
	Members;

/** What `entityOf` returns: a record class with identity. */
export type EntityConstructor<
	Identity extends IEntityIdentity,
	Properties extends IBlueprintCollection,
	Change extends readonly string[],
	Unique extends readonly string[] = [],
	Members = unknown,
	Sensitive extends string = never,
> = {
	readonly [EntityClassBrand]: true;
	/** The keys no two entities may share, as `options.unique` lists them. */
	readonly [EntityUniqueKeys]: readonly EntityUniqueKey<
		Identity,
		Properties,
		Unique
	>[];
	new (
		value: EntityInput<Identity, Properties>,
	): DeclaredEntityInstance<Identity, Properties, Change, Members, Sensitive>;
	/**
	 * The Standard Schema of the class: `validate` gives an instance of it, or
	 * the issues that reject the value. Typed with the instance of the class
	 * `entityOf` returns, not of a subclass.
	 */
	readonly "~standard": StandardSchemaV1.Props<
		EntityInput<Identity, Properties>,
		DeclaredEntityInstance<Identity, Properties, Change, Members, Sensitive>
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
	readonly blueprint: IBlueprint<EntityProperties<Identity, Properties>>;
	readonly options: RecordSettings<EntityProperties<Identity, Properties>>;
	/** Its plugins, those they require included, each once. */
	readonly plugins: readonly AnyRecordPlugin[];
};

/**
 * What `entityBuilderOf` returns: `entityOf`, declaring entities with the
 * identity it was given, whose `options.plugins` picks from `Context`.
 */
export type EntityBuilder<
	Identity extends IEntityIdentity,
	Context = Record<never, never>,
> = <
	Properties extends IBlueprintCollection &
		Partial<Record<EntityIdentityKey, never>>,
	const Change extends readonly RecordKey<Properties>[] = [],
	const Unique extends readonly RecordKey<Properties>[] = [],
	const Plugins extends readonly AnyRecordPlugin[] = [],
	const Sensitive extends readonly RecordKey<Properties>[] = [],
>(
	blueprint: IBlueprint<Properties, boolean>,
	options?: EntityOptions<
		NoInfer<Properties>,
		Change,
		Unique,
		Plugins,
		Context,
		Sensitive
	>,
) => EntityConstructor<
	Identity,
	WithPluginProperties<Properties, Plugins>,
	Change,
	readonly (Unique[number] | PluginUniqueKey<Plugins>)[],
	PluginMembers<Plugins>,
	Sensitive[number] | PluginSensitiveKey<Plugins>
>;
