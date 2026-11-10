import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { recordFieldOf } from "../blueprint/record-field";
import type { BlueprintField } from "../blueprint/types/blueprint.interface";
import { EntityClock, EntityUniqueKeys } from "../entity/abstract-entity";
import { isEntity, isEntityClass } from "../entity/entity";
import {
	type EnvironmentDependencies,
	isEnvironment,
	type MergedEnvironment,
} from "../environment/environment";
import { ExceptionLayers } from "../exception/enums/exception-layers";
import { guard } from "../exception/guard";
import { resolveLogger, writeLog } from "../logger/logger";
import {
	type RecordDataOptions,
	recordDataOf,
	recordFieldDataOf,
} from "../record/abstract-record";
import { recordNameOf } from "../record/name";
import { Kind } from "../symbols/kind";
import { type ExecutionScope, ScopeKey } from "../use-case/scope";
import { decodeCursor, encodeCursor } from "./cursor";
import {
	InvalidRepositoryDeclaration,
	InvalidRepositoryEntity,
	InvalidRepositoryQuery,
	RepositoryEntityNotFound,
} from "./exceptions";
import { inMemoryProvider } from "./in-memory";
import { planQuery } from "./plan";
import { prepareQuery } from "./query";
import { parseEntity, relationsOf, resolveReferences } from "./references";
import {
	assertUnbound,
	contextOf,
	declareRepository,
	type RepositoryState,
	stateOf,
	states,
} from "./state";
import type {
	ProviderQuery,
	RepositoryIndex,
	RepositoryPlan,
	RepositoryQuery,
	RepositoryScans,
} from "./types/query.interface";
import type {
	AnyRepository,
	AnyRepositoryEntity,
	EntityInstanceOf,
	EntityKeyOf,
	IRepositoryProvider,
	ProviderKeyset,
	RepositoryAction,
	RepositoryContext,
	RepositoryData,
	RepositoryOf as RepositoryType,
} from "./types/repository.interface";

/** What `repositoryOf` takes. */
export interface RepositorySettings<
	Entity extends AnyRepositoryEntity,
	Actions extends readonly RepositoryAction<Entity>[],
	Environment extends EnvironmentDependencies | undefined,
	Provider extends
		| IRepositoryProvider<MergedEnvironment<Environment>>
		| undefined = IRepositoryProvider<MergedEnvironment<Environment>>,
> {
	/** The entity class whose entities it holds. */
	readonly entity: Entity;
	/** Its methods, e.g. `["findById", "findByEmail", "findManyByName", "create"]`. */
	readonly actions: Actions;
	/** Physically remove rows (default), or retain them with `deletedAt`. */
	readonly deletion?: "hard" | "soft";
	/**
	 * How it reads and writes; a new `inMemoryProvider()` by default. Without
	 * `capabilities.keyset`, the repository has no `findCursor`.
	 */
	readonly provider?: Provider;
	/** The environments the provider gets, merged, as `context.env`. */
	readonly environmentDependencies?: Environment;
	/**
	 * The repositories of the entities its entities hold, at any depth, one for
	 * each entity class (or a subclass of it). They are stored by their ids and
	 * loaded when read.
	 */
	readonly relations?: readonly AnyRepository[];
	/**
	 * Its access patterns, by name, e.g.
	 * `{ byTypeStatus: { where: ["type", "status"], orderBy: "publishedAt" } }`:
	 * a query that matches one reads through it, and the provider gets its
	 * name as `query.index` and every index as `context.indexes`.
	 */
	readonly indexes?: Readonly<
		Record<string, RepositoryIndex<EntityKeyOf<Entity>>>
	>;
	/**
	 * What a query only a scan serves does: runs (`"allow"`, the default),
	 * logs `repository-scan` and runs (`"warn"`), or throws
	 * `InvalidRepositoryQuery` (`"reject"`).
	 */
	readonly scans?: RepositoryScans;
}

/** Stores each entity a record holds as its id. */
const REFERENCES: RecordDataOptions = {
	reference: (record) =>
		isEntity(record) ? (record as unknown as { id: string }).id : undefined,
};

/**
 * A repository: the base of every class `repositoryOf` makes. Its methods are
 * the actions it was declared with; extend it, through `RepositoryOf`, to add
 * methods, which can use the protected `provider`, `context` and `env`.
 */
export abstract class AbstractRepository<
	Entity extends AnyRepositoryEntity,
	Actions extends readonly RepositoryAction<Entity>[],
	Environment,
> {
	get [Kind](): "repository" {
		return "repository";
	}

	/** The entity class whose entities it holds. */
	get entity(): Entity {
		return stateOf(this).entity as Entity;
	}

	/** The methods it was declared with. */
	get actions(): Actions {
		return stateOf(this).actions as unknown as Actions;
	}

	/** How it reads and writes. */
	protected get provider(): IRepositoryProvider<Environment> {
		return stateOf(this).provider as IRepositoryProvider<Environment>;
	}

	/** What the provider gets with every call. */
	protected get context(): RepositoryContext<Environment> {
		return contextOf(stateOf(this)) as RepositoryContext<Environment>;
	}

	/** The variables of its `environmentDependencies`, merged. */
	protected get env(): Environment {
		return this.context.env;
	}

	/**
	 * The entity of a stored value, with the entities it holds loaded by their
	 * ids; throws `InvalidRepositoryData` when rejected or when one is missing.
	 */
	protected async hydrate(
		data: RepositoryData,
	): Promise<EntityInstanceOf<Entity>> {
		return (await this.hydrateMany([data]))[0] as EntityInstanceOf<Entity>;
	}

	/** The entities of stored values, loading what they hold in one batch. */
	protected async hydrateMany(
		list: readonly RepositoryData[],
	): Promise<EntityInstanceOf<Entity>[]> {
		const state = stateOf(this);
		const scope = (this as { [ScopeKey]?: ExecutionScope })[ScopeKey];
		const resolved = await resolveReferences(state, list, new Map(), scope);
		return resolved.map((data) =>
			parseEntity(state, data),
		) as EntityInstanceOf<Entity>[];
	}

	/** The value of `entity` as the provider stores it. */
	protected dataOf(entity: EntityInstanceOf<Entity>): RepositoryData {
		if (!(entity instanceof stateOf(this).entity)) {
			throw new InvalidRepositoryEntity({ source: stateOf(this).name });
		}
		return recordDataOf(entity as object, REFERENCES);
	}
}

type Method = (
	this: AbstractRepository<never, never, unknown>,
	...args: never[]
) => Promise<unknown>;
type Internal = {
	readonly provider: IRepositoryProvider;
	readonly context: RepositoryContext;
	hydrate(data: RepositoryData): Promise<object>;
	hydrateMany(list: readonly RepositoryData[]): Promise<object[]>;
	dataOf(entity: unknown): RepositoryData;
};

/** `method` run in the layer of repositories, as `this` gives it access to them. */
function action(
	method: (self: Internal, ...args: never[]) => Promise<unknown>,
): Method {
	return function (this: object, ...args: never[]) {
		const state = stateOf(this);
		return guard(
			{ layer: ExceptionLayers.Repository, source: state.name },
			async () => {
				assertUnbound(state);
				return method(this as unknown as Internal, ...args);
			},
		);
	} as Method;
}

/** A value to look up `key` by: a record as its plain value, an entity as its id. */
function queryValueOf(context: RepositoryContext, key: string, value: unknown) {
	const properties = context.entity.blueprint.properties as Readonly<
		Record<string, BlueprintField | undefined>
	>;
	return recordFieldDataOf(properties[key], value, REFERENCES);
}

/**
 * A query validated and normalized for the provider: records as plain data,
 * entities as ids (also inside `in`), and `withDeleted` set by the policy.
 */
function queryOf(self: Internal, query: unknown): RepositoryQuery {
	const prepared = prepareQuery(self.context, query, (key, value) =>
		queryValueOf(self.context, key, value),
	);
	return {
		...prepared,
		withDeleted: prepared.withDeleted ?? stateOf(self).deletion === "hard",
	};
}

const equals = (self: Internal, key: string, value: unknown) =>
	queryOf(self, { where: { [key]: value } });

/**
 * `query` with the index that serves it, after the scan policy: a scan logs
 * `repository-scan` with `scans: "warn"`, and throws `InvalidRepositoryQuery`
 * (reason `scan`) with `"reject"`, before the provider is called.
 */
function planned<Query extends RepositoryQuery>(
	self: Internal,
	method: string,
	query: Query,
	orderBy: RepositoryQuery["orderBy"] = query.orderBy,
): Query & ProviderQuery {
	const state = stateOf(self);
	const plan = planQuery(self.context, { where: query.where, orderBy });
	if (plan.access === "scan" && state.scans !== "allow") {
		const fields = {
			repository: state.name,
			method,
			where: Object.keys(query.where ?? {}),
			orderBy: (orderBy ?? []).map(({ key }) => key),
		};
		if (state.scans === "reject") {
			throw new InvalidRepositoryQuery({
				source: state.name,
				details: {
					reason: `"${method}" matches no index of ${state.name} and would read every row (scans: "reject").`,
					scan: true,
					...fields,
				} as { reason: string },
			});
		}
		const scope = (self as { [ScopeKey]?: ExecutionScope })[ScopeKey];
		writeLog(
			resolveLogger(scope?.logger ?? state.logger, undefined),
			"warn",
			"repository-scan",
			fields,
		);
	}
	return plan.index === undefined ? query : { ...query, index: plan.index };
}

const findBy = (key: string): Method =>
	action(async (self, value: unknown) => {
		const data = await self.provider.findOne(
			self.context,
			equals(self, key, value),
		);
		return data === undefined ? undefined : await self.hydrate(data);
	});

const findManyBy = (key: string): Method =>
	action(async (self, value: unknown) =>
		self.hydrateMany(
			await self.provider.findMany(
				self.context,
				planned(self, `findManyBy${capitalize(key)}`, equals(self, key, value)),
			),
		),
	);

const findMany = action(async (self, query: unknown) =>
	self.hydrateMany(
		await self.provider.findMany(
			self.context,
			planned(self, "findMany", queryOf(self, query)),
		),
	),
);

const exists = action(
	async (self, query: unknown) =>
		(await self.provider.findOne(
			self.context,
			planned(self, "exists", queryOf(self, query)),
		)) !== undefined,
);

/** The options of a query `explain` takes: those of `findMany` and of `findCursor`. */
const EXPLAIN_OPTIONS = [
	"where",
	"orderBy",
	"limit",
	"offset",
	"withDeleted",
	"after",
];

const explain = action(
	async (self, query: unknown = {}): Promise<RepositoryPlan> => {
		const prepared = prepareQuery(
			self.context,
			query,
			(key, value) => queryValueOf(self.context, key, value),
			EXPLAIN_OPTIONS,
		);
		return planQuery(self.context, prepared);
	},
);

const findPage = action(async (self, query: unknown) => {
	const {
		orderBy,
		where,
		withDeleted,
		limit = 20,
		offset = 0,
		index,
	} = planned(self, "findPage", queryOf(self, query));
	const [rows, total] = await Promise.all([
		self.provider.findMany(self.context, {
			where,
			orderBy,
			withDeleted,
			limit,
			offset,
			...(index === undefined ? {} : { index }),
		}),
		self.provider.count(self.context, {
			where,
			withDeleted,
			...(index === undefined ? {} : { index }),
		}),
	]);
	return { items: await self.hydrateMany(rows), total, limit, offset };
});

/** The options of the query of `findCursor`. */
const CURSOR_OPTIONS = ["where", "orderBy", "limit", "withDeleted", "after"];

const findCursor = action(async (self, query: unknown = {}) => {
	const { context } = self;
	const fail = (reason: string): never => {
		throw new InvalidRepositoryQuery({
			source: context.name,
			details: { reason },
		});
	};
	const prepared = prepareQuery(
		context,
		query,
		(key, value) => queryValueOf(context, key, value),
		CURSOR_OPTIONS,
	);
	const { after } = query as { readonly after?: unknown };
	const { where, limit = 20 } = prepared;
	if (limit < 1) fail("Expected a positive integer for limit.");
	const withDeleted = prepared.withDeleted ?? stateOf(self).deletion === "hard";
	// The id breaks ties, so every row has one position in the order.
	const declared = prepared.orderBy ?? [];
	const orderBy = declared.some(({ key }) => key === "id")
		? declared
		: [...declared, { key: "id", direction: "asc" as const }];
	for (const { key } of orderBy) {
		// A cursor carries the values of its order keys, readable by whoever has it.
		if (context.entity.options.sensitive.includes(key))
			fail(`"${key}" is sensitive and cannot order a cursor.`);
	}
	if (self.provider.capabilities?.keyset !== true)
		fail("The provider does not read by cursor (capabilities.keyset).");
	const { index } = planned(self, "findCursor", { where }, declared);

	const rows = await self.provider.findMany(context, {
		where,
		orderBy,
		withDeleted,
		limit: limit + 1,
		...(index === undefined ? {} : { index }),
		...(after === undefined
			? {}
			: { after: decodeCursor(context.name, orderBy, after) }),
	});
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: await self.hydrateMany(page),
		limit,
		next:
			rows.length > limit && last !== undefined
				? encodeCursor(orderBy, last)
				: undefined,
	};
});

const create = action(async (self, input: unknown) => {
	const { entity: Entity } = self.context;
	const entity =
		input instanceof Entity
			? input
			: new (Entity as unknown as new (value: unknown) => object)(input);
	await self.provider.insert(self.context, self.dataOf(entity));
	return entity;
});

const update = action(async (self, entity: unknown) => {
	await self.provider.update(self.context, self.dataOf(entity));
	return entity;
});

const remove = action(async (self, target: unknown) => {
	const { context } = self;
	let entity = target;
	if (typeof target === "string") {
		const data = await self.provider.findOne(
			context,
			equals(self, "id", target),
		);
		if (data === undefined) {
			throw new RepositoryEntityNotFound({
				source: context.name,
				details: { id: target },
			});
		}
		entity = await self.hydrate(data);
	}
	const data = self.dataOf(entity);
	const destroyable = entity as {
		readonly isDeleted: boolean;
		destroy(): void;
	};
	if (!destroyable.isDeleted) destroyable.destroy();
	if (stateOf(self).deletion === "soft") {
		await self.provider.update(context, self.dataOf(entity));
	} else {
		await self.provider.remove(context, data.id as string);
	}
	return entity;
});

const restore = action(async (self, target: unknown) => {
	const { context } = self;
	const id =
		typeof target === "string" ? target : (self.dataOf(target).id as string);
	const data = await self.provider.findOne(context, {
		...equals(self, "id", id),
		withDeleted: true,
	});
	if (data === undefined) {
		throw new RepositoryEntityNotFound({
			source: context.name,
			details: { id },
		});
	}
	if (data.deletedAt === undefined) return self.hydrate(data);
	const { deletedAt: _deletedAt, ...alive } = data;
	const restored = {
		...alive,
		updatedAt: (
			context.entity as unknown as {
				readonly [EntityClock]: { now(): string };
			}
		)[EntityClock].now(),
	};
	await self.provider.update(context, restored);
	return self.hydrate(restored);
});

const count = action(async (self, query: unknown) => {
	const prepared = queryOf(self, query);
	// The order does not change a count, so it does not keep an index out.
	return self.provider.count(
		self.context,
		planned(self, "count", prepared, []),
	);
});

/** The provider methods each action calls. */
const NEEDS: Readonly<Record<string, readonly (keyof IRepositoryProvider)[]>> =
	{
		findBy: ["findOne"],
		findManyBy: ["findMany"],
		create: ["insert"],
		update: ["update"],
		delete: ["findOne", "remove"],
		restore: ["findOne", "update"],
		count: ["count"],
		findMany: ["findMany"],
		exists: ["findOne"],
		findPage: ["findMany", "count"],
		findCursor: ["findMany"],
		explain: [],
	};

function capitalize(key: string): string {
	return `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

/** Why `action` is not one of `methods`, pointing to the find of the other kind. */
function unknownAction(
	entity: string,
	action: string,
	methods: ReadonlyMap<string, unknown>,
): string {
	const many = /^findManyBy(.+)$/.exec(action)?.[1];
	const one = many === undefined ? /^findBy(.+)$/.exec(action)?.[1] : undefined;
	const suffix = many ?? one;
	const key =
		suffix === undefined
			? undefined
			: `${suffix.charAt(0).toLowerCase()}${suffix.slice(1)}`;
	if (one !== undefined && methods.has(`findManyBy${one}`)) {
		return `"${action}" requires "${key}" to be a unique key of ${entity}.`;
	}
	if (many !== undefined && methods.has(`findBy${many}`)) {
		return `"${action}" is not available for the unique key "${key}" of ${entity}; use "findBy${many}".`;
	}
	return `"${action}" is not an action of ${entity}.`;
}

function invalid(source: string, reason: string): never {
	throw new InvalidRepositoryDeclaration({ source, details: { reason } });
}

const INDEX_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The indexes of `settings.indexes`, checked against `entity` and frozen:
 * each holds known, distinct, non-sensitive `where` keys, at least one, and
 * an optional scalar `orderBy`; two indexes on the same keys and order throw.
 */
function indexesOf(
	name: string,
	entity: AnyRepositoryEntity,
	declared: unknown,
): Readonly<Record<string, RepositoryIndex>> {
	if (declared === undefined) return Object.freeze({});
	if (
		typeof declared !== "object" ||
		declared === null ||
		Array.isArray(declared)
	) {
		invalid(name, "Expected indexes to be an object of indexes by name.");
	}
	const properties = entity.blueprint.properties as Readonly<
		Record<string, BlueprintField | undefined>
	>;
	const sensitive = entity.options.sensitive as readonly string[];
	const keyOf = (index: string, key: unknown): string => {
		if (typeof key !== "string" || !Object.hasOwn(properties, key)) {
			invalid(
				name,
				`The index "${index}" names "${String(key)}", which is not a key of ${recordNameOf(entity)}.`,
			);
		}
		if (sensitive.includes(key)) {
			invalid(
				name,
				`The index "${index}" names "${key}", which is sensitive and cannot be indexed.`,
			);
		}
		return key;
	};
	const seen = new Map<string, string>();
	const indexes: Record<string, RepositoryIndex> = {};
	for (const [index, value] of Object.entries(declared)) {
		if (!INDEX_NAME.test(index) || index === "__proto__") {
			invalid(
				name,
				`Expected the index "${index}" to be named by an identifier.`,
			);
		}
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			Object.keys(value).some((key) => key !== "where" && key !== "orderBy") ||
			!Array.isArray(value.where) ||
			value.where.length === 0
		) {
			invalid(
				name,
				`Expected the index "${index}" to be { where: [keys], orderBy?: key }.`,
			);
		}
		const where = (value.where as unknown[]).map((key) => keyOf(index, key));
		if (new Set(where).size !== where.length) {
			invalid(name, `The index "${index}" names a key twice in where.`);
		}
		const orderBy =
			value.orderBy === undefined ? undefined : keyOf(index, value.orderBy);
		if (orderBy !== undefined) {
			const field = properties[orderBy];
			if (
				isBlueprint(field) ||
				isBlueprintList(field) ||
				recordFieldOf(field)
			) {
				invalid(
					name,
					`The index "${index}" orders by "${orderBy}", which is not scalar.`,
				);
			}
		}
		const signature = JSON.stringify([[...where].sort(), orderBy ?? null]);
		const other = seen.get(signature);
		if (other !== undefined) {
			invalid(name, `The indexes "${other}" and "${index}" are the same.`);
		}
		seen.set(signature, index);
		indexes[index] = Object.freeze({
			where: Object.freeze(where),
			...(orderBy === undefined ? {} : { orderBy }),
		});
	}
	return Object.freeze(indexes);
}

/**
 * A repository of `entity` with the methods of `actions`: `findBy<Key>` for a
 * unique key (`id`, `options.unique`, a `unique` property), giving the entity
 * or `undefined`; `findManyBy<Key>` for any other key, giving a list;
 * `create`, `update`, `delete`, `restore` (soft deletion only), `count`, and the queries `findMany`,
 * `exists`, `findPage` and `findCursor`. Every method is async and reads and writes through `provider`
 * (a new `inMemoryProvider()` by default), which gets the variables of
 * `environmentDependencies` as `context.env`. The repository can be a
 * dependency of a use case, and `RepositoryOf` extends it with a class.
 */
export function repositoryOf<
	Entity extends AnyRepositoryEntity,
	const Actions extends readonly RepositoryAction<Entity>[],
	const Environment extends EnvironmentDependencies | undefined = undefined,
	Provider extends
		| IRepositoryProvider<MergedEnvironment<Environment>>
		| undefined = undefined,
>(
	settings: RepositorySettings<Entity, Actions, Environment, Provider>,
): RepositoryType<
	Entity,
	Actions,
	MergedEnvironment<Environment>,
	ProviderKeyset<Provider>
> {
	const { entity, actions, environmentDependencies } = settings ?? {};
	if (!isEntityClass(entity) || !(EntityUniqueKeys in entity)) {
		invalid("repositoryOf", "Expected an entity class made by entityOf.");
	}
	const name = `${recordNameOf(entity)}Repository`;
	const deletion = settings.deletion ?? "hard";
	if (deletion !== "hard" && deletion !== "soft") {
		invalid(name, 'Expected deletion to be "hard" or "soft".');
	}
	const scans = settings.scans ?? "allow";
	if (scans !== "allow" && scans !== "warn" && scans !== "reject") {
		invalid(name, 'Expected scans to be "allow", "warn" or "reject".');
	}
	const provider = (settings.provider ??
		inMemoryProvider()) as IRepositoryProvider;
	if (!Array.isArray(actions) || actions.length === 0) {
		invalid(name, "Expected a list of actions.");
	}
	if (
		environmentDependencies !== undefined &&
		!isEnvironment(environmentDependencies) &&
		!(
			Array.isArray(environmentDependencies) &&
			environmentDependencies.every(isEnvironment)
		)
	) {
		invalid(name, "Expected environments made by environmentOf.");
	}

	const relations = relationsOf(name, entity, settings.relations);
	const indexes = indexesOf(name, entity, settings.indexes);
	const unique = entity[EntityUniqueKeys];
	const methods = new Map<string, readonly [string, Method]>();
	for (const key of Object.keys(entity.blueprint.properties)) {
		const suffix = capitalize(key);
		if (unique.includes(key)) {
			methods.set(`findBy${suffix}`, ["findBy", findBy(key)]);
		} else {
			methods.set(`findManyBy${suffix}`, ["findManyBy", findManyBy(key)]);
		}
	}
	methods.set("create", ["create", create]);
	methods.set("update", ["update", update]);
	methods.set("delete", ["delete", remove]);
	methods.set("restore", ["restore", restore]);
	methods.set("count", ["count", count]);
	methods.set("findMany", ["findMany", findMany]);
	methods.set("exists", ["exists", exists]);
	methods.set("findPage", ["findPage", findPage]);
	methods.set("findCursor", ["findCursor", findCursor]);
	methods.set("explain", ["explain", explain]);

	class DeclaredRepository extends AbstractRepository<
		Entity,
		Actions,
		MergedEnvironment<Environment>
	> {}

	for (const name_ of new Set<unknown>(actions)) {
		const method = typeof name_ === "string" ? methods.get(name_) : undefined;
		if (!method)
			invalid(
				name,
				unknownAction(recordNameOf(entity), String(name_), methods),
			);
		const [kind, implementation] = method;
		if (kind === "restore" && deletion !== "soft") {
			invalid(name, '"restore" needs deletion to be "soft".');
		}
		// A provider of `providersOf` may only exist once an application starts.
		if (
			kind === "findCursor" &&
			settings.provider !== undefined &&
			(provider as { readonly [Kind]?: unknown })[Kind] !== "provider-slot" &&
			provider.capabilities?.keyset !== true
		) {
			invalid(
				name,
				'"findCursor" needs a provider that reads by cursor (capabilities.keyset).',
			);
		}
		const needs =
			deletion === "soft" && kind === "delete"
				? (["findOne", "update"] as const)
				: (NEEDS[kind] ?? []);
		for (const need of needs) {
			if (typeof provider?.[need] !== "function") {
				invalid(name, `The provider has no "${need}" for "${name_}".`);
			}
		}
		Object.defineProperty(DeclaredRepository.prototype, name_ as string, {
			value: implementation,
			writable: true,
			configurable: true,
		});
	}
	Object.defineProperty(DeclaredRepository, "name", { value: name });
	const state: RepositoryState = {
		name,
		entity,
		actions: Object.freeze([...new Set(actions as readonly string[])]),
		deletion,
		provider,
		explicitProvider: settings.provider !== undefined,
		environment: environmentDependencies,
		relations,
		indexes,
		scans,
	};
	states.set(DeclaredRepository, state);
	const repository = Object.freeze(new DeclaredRepository());
	declareRepository(state, repository);

	return repository as unknown as RepositoryType<
		Entity,
		Actions,
		MergedEnvironment<Environment>,
		ProviderKeyset<Provider>
	>;
}

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
> = RepositoryType<Entity, Actions, Environment, Keyset>;

/**
 * The class of `repository`, to extend: its instances share the entity,
 * actions, provider and environment of `repository`, e.g.
 * `class UsersRepository extends RepositoryOf(Users) { findActive() {...} }`,
 * where `super.create(user)` calls the action of `Users`.
 */
export function RepositoryOf<Repository extends AnyRepository>(
	repository: Repository,
): new () => Repository {
	if (!isRepository(repository)) {
		invalid("RepositoryOf", "Expected a repository made by repositoryOf.");
	}
	return repository.constructor as new () => Repository;
}

/** Whether `value` is a repository, made by `repositoryOf` or extending one. */
export function isRepository(value: unknown): value is AnyRepository {
	return value instanceof AbstractRepository;
}
