import type {
	AnyRecordClass,
	BlueprintValue,
	IBlueprint,
} from "../../blueprint/types/blueprint.interface";
import type {
	AbstractEntity,
	EntityUniqueKeys,
} from "../../entity/abstract-entity";
import type { AnyEntityClass } from "../../entity/event";
import type { RecordSettings } from "../../record/types/record.interface";
import type { AbstractRepository } from "../repository";
import type {
	ProviderCapabilities,
	ProviderQuery,
	RepositoryExists,
	RepositoryExplain,
	RepositoryFindCursor,
	RepositoryFindMany,
	RepositoryFindPage,
	RepositoryForEachPage,
	RepositoryIndex,
	RepositoryQuery,
} from "./query.interface";
import type { SchemaPlan } from "./schema.interface";

/** Any class made by `entityOf`, or extending one, that a repository holds. */
export type AnyRepositoryEntity = AnyRecordClass &
	AnyEntityClass & {
		readonly [EntityUniqueKeys]: readonly string[];
		// biome-ignore lint/suspicious/noExplicitAny: any entity, whatever its blueprint
		readonly options: RecordSettings<any>;
	};

/** The entities of `Entity`. */
export type EntityInstanceOf<Entity> = Entity extends abstract new (
	// biome-ignore lint/suspicious/noExplicitAny: any constructor arguments
	...args: any
) => infer Instance
	? Instance
	: never;

type EntityPropertiesOf<Entity> = Entity extends {
	readonly blueprint: IBlueprint<infer Properties>;
}
	? Properties
	: never;

/** The value of the entities of `Entity`, by key. */
export type EntityValueOf<Entity> = BlueprintValue<EntityPropertiesOf<Entity>>;

/** The keys of the entities of `Entity`, its identity included. */
export type EntityKeyOf<Entity> = keyof EntityPropertiesOf<Entity> & string;

/** The unique keys of `Entity`: `id`, `options.unique` and every `unique` property. */
export type EntityUniqueKeyOf<Entity> = Entity extends {
	readonly [EntityUniqueKeys]: readonly (infer Key)[];
}
	? Key & string
	: never;

type ValueAt<
	Entity,
	Key extends string,
> = Key extends keyof EntityValueOf<Entity>
	? EntityValueOf<Entity>[Key]
	: never;

/**
 * What a query takes for a value of type `Value`: an entity, or a list of
 * them, can be given by id, as repositories store entities by their ids.
 */
export type QueryValueOf<Value> = Value extends readonly (infer Item)[]
	? // biome-ignore lint/suspicious/noExplicitAny: any entity, whatever its blueprint
		Item extends AbstractEntity<any>
		? readonly (Item | string)[]
		: Value
	: // biome-ignore lint/suspicious/noExplicitAny: any entity, whatever its blueprint
		Value extends AbstractEntity<any>
		? Value | string
		: Value;

/** What `create` takes: an entity, or the input that builds one. */
export type RepositoryCreateInput<Entity> =
	| EntityInstanceOf<Entity>
	| (Entity extends new (value: infer Input) => unknown ? Input : never);

/** `create`: stores the entity, or a new one built from the input, and gives it. */
export interface RepositoryCreate<Entity> {
	create(
		entity: RepositoryCreateInput<Entity>,
	): Promise<EntityInstanceOf<Entity>>;
}

/** `update`: stores the current value of an entity it holds, and gives it. */
export interface RepositoryUpdate<Entity> {
	update(entity: EntityInstanceOf<Entity>): Promise<EntityInstanceOf<Entity>>;
}

type ChangeKeyOf<Entity> =
	EntityInstanceOf<Entity> extends {
		readonly change: infer Change;
	}
		? keyof Change & string
		: never;

/**
 * The keys `increment` takes for `Entity`: those of its `change` list that
 * hold a number.
 */
export type EntityIncrementKeyOf<Entity> = {
	[Key in ChangeKeyOf<Entity>]: NonNullable<ValueAt<Entity, Key>> extends number
		? Key
		: never;
}[ChangeKeyOf<Entity>];

/** What `increment` adds to each key, e.g. `{ views: 1 }`. */
export type RepositoryIncrementDeltas<Entity> = {
	readonly [Key in EntityIncrementKeyOf<Entity>]?: number;
};

/** The options of `increment`. */
export interface RepositoryIncrementOptions<Entity> {
	/**
	 * The input of the entity to create when the id holds none, without its
	 * `id` (the one given) and with the keys of the deltas optional (0 when
	 * left out); the deltas are added to it.
	 */
	readonly create?: Omit<
		Entity extends new (value: infer Input) => unknown ? Input : never,
		"id" | EntityIncrementKeyOf<Entity>
	> & {
		readonly [Key in EntityIncrementKeyOf<Entity>]?: number;
	};
}

/**
 * `increment`: adds the deltas to the numeric keys of the entity of the id
 * (or the one given) in one atomic write, and gives the entity as stored.
 */
export interface RepositoryIncrement<Entity> {
	increment(
		entity: EntityInstanceOf<Entity> | string,
		deltas: RepositoryIncrementDeltas<Entity>,
		options?: RepositoryIncrementOptions<Entity>,
	): Promise<EntityInstanceOf<Entity>>;
}

/** `delete`: destroys the entity (or the one of the id), removes it and gives it. */
export interface RepositoryDelete<Entity> {
	delete(
		entity: EntityInstanceOf<Entity> | string,
	): Promise<EntityInstanceOf<Entity>>;
}

/**
 * `restore`: brings back a soft-deleted entity (or the one of the id) and
 * gives it, alive; only for a repository with `deletion: "soft"`.
 */
export interface RepositoryRestore<Entity> {
	restore(
		entity: EntityInstanceOf<Entity> | string,
	): Promise<EntityInstanceOf<Entity>>;
}

/** `count`: how many entities it holds. */
export interface RepositoryCount<Entity = unknown> {
	count(query?: RepositoryQuery<Entity>): Promise<number>;
}

/** The `findBy<Key>` of `Actions`, one for each unique key: the entity, or `undefined`. */
export type RepositoryFindBy<Entity, Actions extends string = string> = {
	readonly [Key in EntityUniqueKeyOf<Entity> as `findBy${Capitalize<Key>}` extends Actions
		? `findBy${Capitalize<Key>}`
		: never]: (
		value: QueryValueOf<NonNullable<ValueAt<Entity, Key>>>,
	) => Promise<EntityInstanceOf<Entity> | undefined>;
};

/**
 * The keys of `Entity` that are not unique. When its unique keys are not
 * known (`string`), every key.
 */
export type EntityNonUniqueKeyOf<Entity> =
	string extends EntityUniqueKeyOf<Entity>
		? EntityKeyOf<Entity>
		: Exclude<EntityKeyOf<Entity>, EntityUniqueKeyOf<Entity>>;

/**
 * The `findManyBy<Key>` of `Actions`, one for each key that is not unique
 * (a unique key has `findBy<Key>`): every entity holding the value.
 */
export type RepositoryFindManyBy<Entity, Actions extends string = string> = {
	readonly [Key in EntityNonUniqueKeyOf<Entity> as `findManyBy${Capitalize<Key>}` extends Actions
		? `findManyBy${Capitalize<Key>}`
		: never]: (
		value: QueryValueOf<ValueAt<Entity, Key>>,
	) => Promise<EntityInstanceOf<Entity>[]>;
};

/**
 * The methods of `Actions` for `Entity`. Declared as methods, not properties,
 * so that a class extending a repository can override them.
 * @internal
 */
export type RepositoryMethods<
	Entity,
	Actions extends string = string,
> = RepositoryFindBy<Entity, Actions> &
	RepositoryFindManyBy<Entity, Actions> &
	("create" extends Actions ? RepositoryCreate<Entity> : unknown) &
	("update" extends Actions ? RepositoryUpdate<Entity> : unknown) &
	("delete" extends Actions ? RepositoryDelete<Entity> : unknown) &
	("restore" extends Actions ? RepositoryRestore<Entity> : unknown) &
	("increment" extends Actions ? RepositoryIncrement<Entity> : unknown) &
	("count" extends Actions ? RepositoryCount<Entity> : unknown) &
	("findMany" extends Actions ? RepositoryFindMany<Entity> : unknown) &
	("exists" extends Actions ? RepositoryExists<Entity> : unknown) &
	("findPage" extends Actions ? RepositoryFindPage<Entity> : unknown) &
	("findCursor" extends Actions ? RepositoryFindCursor<Entity> : unknown) &
	("explain" extends Actions ? RepositoryExplain<Entity> : unknown) &
	("forEachPage" extends Actions ? RepositoryForEachPage<Entity> : unknown);

/** A method a repository of `Entity` can have, e.g. `"findByEmail"`. */
export type RepositoryAction<Entity> =
	| keyof RepositoryFindBy<Entity>
	| keyof RepositoryFindManyBy<Entity>
	| "create"
	| "update"
	| "delete"
	| "restore"
	| "increment"
	| "count"
	| "findMany"
	| "exists"
	| "findPage"
	| "findCursor"
	| "explain"
	| "forEachPage";

/**
 * Whether a repository given `Provider` keeps `findCursor`: `false` when the
 * type of its `capabilities.keyset` cannot be `true` (left out of the
 * capabilities, or `false`), `true` for `true`, for a wide `boolean`, and
 * with no provider (the default in-memory one reads by cursor). `repositoryOf`
 * infers only the `capabilities` of a provider: one without them keeps
 * `findCursor` in the type and is rejected at declaration.
 */
export type ProviderKeyset<Provider> = undefined extends Provider
	? true
	: Provider extends { readonly capabilities?: infer Capabilities }
		? [NonNullable<Capabilities>] extends [{ readonly keyset?: infer Keyset }]
			? true extends Keyset
				? true
				: false
			: false
		: false;

/**
 * A repository of `Entity` with the methods of `Actions`, whose provider gets
 * `Environment` as `context.env`, e.g.
 * `RepositoryOf<typeof User, ["findById", "create"]>`.
 */
export type RepositoryOf<
	Entity extends AnyRepositoryEntity,
	Actions extends readonly RepositoryAction<Entity>[],
	Environment = Readonly<Record<never, never>>,
	Keyset extends boolean = true,
> = AbstractRepository<Entity, Actions, Environment> &
	RepositoryMethods<
		Entity,
		Keyset extends true
			? Actions[number]
			: Exclude<Actions[number], "findCursor">
	>;

/** Any repository, whatever its entity, actions and environment. */
// biome-ignore lint/suspicious/noExplicitAny: any repository
export type AnyRepository = AbstractRepository<any, any, any>;

/** A value of an entity as a provider stores it: plain, unmasked. */
export type RepositoryData = Readonly<Record<string, unknown>>;

/** What `update` of a provider gets after the data. */
export interface ProviderUpdateOptions {
	/** The `version` the stored row must hold for the write to happen. */
	readonly expectedVersion?: number;
}

/** What `increment` of a provider gets after the deltas. */
export interface ProviderIncrementOptions {
	/** Values stored as they are by the same write, e.g. `updatedAt`. */
	readonly set?: RepositoryData;
	/**
	 * The row to insert when the id holds none, or holds one that expired
	 * (which it replaces).
	 */
	readonly create?: RepositoryData;
	/**
	 * For an entity that expires (`context.expiry`), the current date and
	 * time (ISO 8601) by the clock of the entity: a row whose expiry is at or
	 * before it counts as absent. A provider called without it uses the
	 * current time.
	 */
	readonly now?: string;
}

/** `RepositoryContext.schema`. */
export interface RepositorySchema {
	readonly version: number;
	readonly key: string;
	readonly previousNames: readonly string[];
}

/** What a provider gets with every call: whose entities, and the environment. */
export interface RepositoryContext<Environment = unknown> {
	/** The entity class; name a table after `recordNameOf(entity)`, not `entity.name`. */
	readonly entity: AnyRepositoryEntity;
	/**
	 * The name of the repository, `<entity name>Repository`, for the source of
	 * its exceptions; stable under minification when the entity declares a `name`.
	 */
	readonly name: string;
	/** The keys no two entities may share, `id` first. */
	readonly unique: readonly string[];
	/**
	 * The indexes the repository declares, by name, for a provider to build
	 * (a GSI, an SQL index); a repository always gives it, empty when it
	 * declares none (optional for contexts built by hand).
	 */
	readonly indexes?: Readonly<Record<string, RepositoryIndex>>;
	/**
	 * For an entity declared with `expires`, the key holding the date at which
	 * a record expires (`expiresAt`, or the key of `at`): reads leave out the
	 * records whose date is at or before `query.now`, unless
	 * `query.withExpired`. A record without a date never expires.
	 */
	readonly expiry?: { readonly key: string };
	/**
	 * For an entity declared with `schemaVersion`: the current version, the
	 * key of each row holding it (`SCHEMA_VERSION_KEY`, which repositories
	 * write and strip, so a provider keeping it in a column of its own maps
	 * that key), and the names the entity had before.
	 */
	readonly schema?: RepositorySchema;
	/** The variables of the `environmentDependencies` of the repository. */
	readonly env: Environment;
}

/**
 * How a repository reads and writes: plain values of its entity, by its
 * context. `insert` and `update` enforce `context.unique`, throwing
 * `RepositoryUniqueViolation`; `update` and `remove` throw
 * `RepositoryEntityNotFound` for an unknown id.
 */
/**
 * What `IRepositoryProvider.migrate` gives when it did not apply the plan to
 * the store (it wrote it to a file to be run later): `app.migrate` skips the
 * backfill of the entity and reports it `deferred`.
 */
export type ProviderMigrationResult = { readonly deferred: true };

export interface IRepositoryProvider<Environment = unknown> {
	findOne(
		context: RepositoryContext<Environment>,
		query?: ProviderQuery,
	): Promise<RepositoryData | undefined>;
	/** `query.after` is only given to a provider with `capabilities.keyset`. */
	findMany(
		context: RepositoryContext<Environment>,
		query?: ProviderQuery,
	): Promise<readonly RepositoryData[]>;
	insert(
		context: RepositoryContext<Environment>,
		data: RepositoryData,
	): Promise<void>;
	/**
	 * With `options.expectedVersion`, writes only when the stored `version` is
	 * that one, and throws `RepositoryConcurrencyConflict` otherwise; only a
	 * provider with `capabilities.versioning` is given it.
	 */
	update(
		context: RepositoryContext<Environment>,
		data: RepositoryData,
		options?: ProviderUpdateOptions,
	): Promise<void>;
	remove(context: RepositoryContext<Environment>, id: string): Promise<void>;
	/**
	 * Adds each of `deltas` to the stored number of its key (a missing one
	 * counts as 0) and stores `options.set` in the same atomic write, then
	 * gives the row as stored. Only rows that are not soft-deleted, nor expired
	 * (`context.expiry`, at `options.now`), match. When the id holds none (or
	 * an expired one), inserts `options.create` as it is, replacing the expired
	 * row, and gives it, or throws `RepositoryEntityNotFound` without it; a
	 * concurrent insert of the same id still gets the deltas added. A
	 * soft-deleted row with `create` is a `RepositoryUniqueViolation` on `id`.
	 * Advertised by `capabilities.atomic`.
	 */
	increment?(
		context: RepositoryContext<Environment>,
		id: string,
		deltas: Readonly<Record<string, number>>,
		options?: ProviderIncrementOptions,
	): Promise<RepositoryData>;
	count(
		context: RepositoryContext<Environment>,
		query?: ProviderQuery,
	): Promise<number>;
	readonly capabilities?: ProviderCapabilities;
	transaction?<Result>(
		run: (provider: IRepositoryProvider<Environment>) => Promise<Result>,
	): Promise<Result>;
	/** Releases what the provider holds (connections, files); `app.stop()` calls it. */
	close?(): void | Promise<void>;
	/**
	 * Applies the structural part of `plan` (columns, tables) for a provider
	 * with a schema of its own, as SQL; `app.migrate({ mode: "apply" })` calls
	 * it before the backfill. Document stores leave it out: they rely on the
	 * upgrade on read and the backfill. Only destructive changes when
	 * `plan.destructive`. Gives `{ deferred: true }` when it did not apply
	 * the plan to the store (it wrote it to a file to be run later): the
	 * backfill of the entity is then skipped, as its rows cannot be written
	 * in the new shape yet.
	 */
	migrate?(
		context: RepositoryContext<Environment>,
		plan: SchemaPlan,
		// biome-ignore lint/suspicious/noConfusingVoidType: an `async migrate() {}` gives Promise<void>
	): Promise<void | ProviderMigrationResult>;
}
