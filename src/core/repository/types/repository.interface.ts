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

/** `delete`: destroys the entity (or the one of the id), removes it and gives it. */
export interface RepositoryDelete<Entity> {
	delete(
		entity: EntityInstanceOf<Entity> | string,
	): Promise<EntityInstanceOf<Entity>>;
}

/** `count`: how many entities it holds. */
export interface RepositoryCount {
	count(): Promise<number>;
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
	("count" extends Actions ? RepositoryCount : unknown);

/** A method a repository of `Entity` can have, e.g. `"findByEmail"`. */
export type RepositoryAction<Entity> =
	| keyof RepositoryFindBy<Entity>
	| keyof RepositoryFindManyBy<Entity>
	| "create"
	| "update"
	| "delete"
	| "count";

/**
 * A repository of `Entity` with the methods of `Actions`, whose provider gets
 * `Environment` as `context.env`, e.g.
 * `RepositoryOf<typeof User, ["findById", "create"]>`.
 */
export type RepositoryOf<
	Entity extends AnyRepositoryEntity,
	Actions extends readonly RepositoryAction<Entity>[],
	Environment = Readonly<Record<never, never>>,
> = AbstractRepository<Entity, Actions, Environment> &
	RepositoryMethods<Entity, Actions[number]>;

/** Any repository, whatever its entity, actions and environment. */
// biome-ignore lint/suspicious/noExplicitAny: any repository
export type AnyRepository = AbstractRepository<any, any, any>;

/** A value of an entity as a provider stores it: plain, unmasked. */
export type RepositoryData = Readonly<Record<string, unknown>>;

/** What a provider gets with every call: whose entities, and the environment. */
export interface RepositoryContext<Environment = unknown> {
	/** The entity class, e.g. to name a table after it. */
	readonly entity: AnyRepositoryEntity;
	/** The name of the repository, for the source of its exceptions. */
	readonly name: string;
	/** The keys no two entities may share, `id` first. */
	readonly unique: readonly string[];
	/** The variables of the `environmentDependencies` of the repository. */
	readonly env: Environment;
}

/**
 * How a repository reads and writes: plain values of its entity, by its
 * context. `insert` and `update` enforce `context.unique`, throwing
 * `RepositoryUniqueViolation`; `update` and `remove` throw
 * `RepositoryEntityNotFound` for an unknown id.
 */
export interface IRepositoryProvider<Environment = unknown> {
	findOne(
		context: RepositoryContext<Environment>,
		key: string,
		value: unknown,
	): Promise<RepositoryData | undefined>;
	findMany(
		context: RepositoryContext<Environment>,
		key: string,
		value: unknown,
	): Promise<readonly RepositoryData[]>;
	insert(
		context: RepositoryContext<Environment>,
		data: RepositoryData,
	): Promise<void>;
	update(
		context: RepositoryContext<Environment>,
		data: RepositoryData,
	): Promise<void>;
	remove(context: RepositoryContext<Environment>, id: string): Promise<void>;
	count(context: RepositoryContext<Environment>): Promise<number>;
	/**
	 * Optional: every value whose `key` is one of `values`, in a single call.
	 * A repository uses it to load the entities another one holds by id, and
	 * calls `findOne` for each id when it is missing.
	 */
	findIn?(
		context: RepositoryContext<Environment>,
		key: string,
		values: readonly unknown[],
	): Promise<readonly RepositoryData[]>;
}
