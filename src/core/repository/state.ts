import { EntityUniqueKeys } from "../entity/abstract-entity";
import {
	type EnvironmentDependencies,
	loadEnvironments,
} from "../environment/environment";
import type { ILogger } from "../logger/logger";
import { RepositoryUsedOutsideApplication } from "./exceptions";
import type { RepositoryIndex, RepositoryScans } from "./types/query.interface";
import type {
	AnyRepositoryEntity,
	IRepositoryProvider,
	RepositoryContext,
} from "./types/repository.interface";

/** What a repository class holds, shared by the classes extending it. */
export interface RepositoryState {
	readonly name: string;
	readonly entity: AnyRepositoryEntity;
	readonly actions: readonly string[];
	readonly deletion: "hard" | "soft";
	readonly provider: IRepositoryProvider;
	/** Whether `settings.provider` was given, and not the default one. */
	readonly explicitProvider: boolean;
	readonly environment: EnvironmentDependencies | undefined;
	/** The repository of each entity class its entities hold, at any depth. */
	readonly relations: ReadonlyMap<object, RepositoryState>;
	/** Its declared indexes, normalized and frozen. */
	readonly indexes: Readonly<Record<string, RepositoryIndex>>;
	/** What it does with a query only a scan serves. */
	readonly scans: RepositoryScans;
	/** The logger of the application that bound it, for `scans: "warn"`. */
	readonly logger?: ILogger;
	context?: RepositoryContext;
}

export const states = new WeakMap<object, RepositoryState>();

/** The state of the repository class of `repository`, or of a class it extends; `undefined` for anything else. */
export function findState(repository: unknown): RepositoryState | undefined {
	if (typeof repository !== "object" || repository === null) return undefined;
	for (
		let Class: unknown = repository.constructor;
		typeof Class === "function";
		Class = Object.getPrototypeOf(Class)
	) {
		const state = states.get(Class);
		if (state) return state;
	}
	return undefined;
}

/** The state of the repository class of `repository`, or of a class it extends. */
export function stateOf(repository: object): RepositoryState {
	const state = findState(repository);
	if (!state) throw new TypeError("Expected a repository made by repositoryOf");
	return state;
}

/** The context of the provider, with the environment read on first use. */
export function contextOf(state: RepositoryState): RepositoryContext {
	state.context ??= Object.freeze({
		entity: state.entity,
		name: state.name,
		unique: state.entity[EntityUniqueKeys],
		indexes: state.indexes,
		env: loadEnvironments(state.environment),
	});
	return state.context;
}

/** What an application reads from a repository, without reaching its state. */
export interface RepositoryInspection {
	readonly entity: AnyRepositoryEntity;
	readonly actions: readonly string[];
	readonly deletion: "hard" | "soft";
	readonly indexes: Readonly<Record<string, RepositoryIndex>>;
	readonly scans: RepositoryScans;
	readonly explicitProvider: boolean;
	/** The provider, only when the repository declared it. */
	readonly provider: IRepositoryProvider | undefined;
	readonly environments: readonly object[];
	/** The repository state of each related entity class; compare with `inspect(...).state`. */
	readonly relations: readonly object[];
	/** Identifies the declaration, shared by every repository that extends or is bound from it. */
	readonly state: object;
}

/** The declaration of `repository`; `undefined` when it is not one. */
export function inspectRepository(
	repository: unknown,
): RepositoryInspection | undefined {
	const state = findState(repository);
	if (!state) return undefined;
	const { environment } = state;
	return {
		entity: state.entity,
		actions: state.actions,
		deletion: state.deletion,
		indexes: state.indexes,
		scans: state.scans,
		explicitProvider: state.explicitProvider,
		provider: state.explicitProvider ? state.provider : undefined,
		environments:
			environment === undefined
				? []
				: Array.isArray(environment)
					? environment
					: [environment],
		relations: [...state.relations.values()].map(declarationOf),
		state: declarationOf(state),
	};
}

/** The state a bound copy comes from, or the state itself. */
const origins = new WeakMap<RepositoryState, RepositoryState>();

function declarationOf(state: RepositoryState): RepositoryState {
	return origins.get(state) ?? state;
}

/** The repository `repositoryOf` made for each declaration. */
const declared = new WeakMap<RepositoryState, object>();

/** Keeps `repository` as the one `repositoryOf` made for `state`. */
export function declareRepository(
	state: RepositoryState,
	repository: object,
): void {
	declared.set(state, repository);
}

/**
 * The repository `repositoryOf` made for the entity class `Entity` that the
 * entities of `repository` hold; `undefined` when it has no such relation.
 *
 * @internal
 */
export function relatedRepositoryOf(
	repository: object,
	Entity: object,
): object | undefined {
	const related = findState(repository)?.relations.get(Entity);
	return related ? declared.get(declarationOf(related)) : undefined;
}

/**
 * `state` reading and writing through `provider`, unless it declared its own;
 * a provider it declared that is a key of `instances` (a slot of
 * `providersOf`) is replaced by its value. Its relations are bound the same
 * way. The original is left as it is.
 */
function bindState(
	state: RepositoryState,
	provider: IRepositoryProvider | undefined,
	instances: ReadonlyMap<object, IRepositoryProvider> | undefined,
	logger: ILogger | undefined,
	bound = new Map<RepositoryState, RepositoryState>(),
): RepositoryState {
	const done = bound.get(state);
	if (done) return done;
	const copy: RepositoryState = {
		...state,
		logger,
		provider: state.explicitProvider
			? (instances?.get(state.provider) ?? state.provider)
			: (provider ?? state.provider),
		context: undefined,
		relations: new Map(
			[...state.relations].map(([target, related]) => [
				target,
				bindState(related, provider, instances, logger, bound),
			]),
		),
	};
	origins.set(copy, declarationOf(state));
	bound.set(state, copy);
	return copy;
}

/** Who bound each declaration: the application and its key for the repository. */
const owners = new WeakMap<
	RepositoryState,
	{ readonly application: string; readonly repository: string }
>();

/**
 * Throws `RepositoryUsedOutsideApplication` when `state` is a declaration an
 * application bound to its provider: its calls would read another store.
 */
export function assertUnbound(state: RepositoryState): void {
	const owner = owners.get(state);
	if (owner) {
		throw new RepositoryUsedOutsideApplication({
			source: state.name,
			details: owner,
		});
	}
}

/** Where the application binding a repository comes from. */
export interface RepositoryBinding {
	/** The name of the application. */
	readonly application: string;
	/** The key of the repository in the application. */
	readonly key: string;
	/** The logger of the application, for `scans: "warn"`. */
	readonly logger?: ILogger;
}

/**
 * A repository sharing the declaration of `repository` that reads and writes
 * through `provider`, unless it declared a provider of its own; a declared
 * provider found in `instances` is replaced by its value. With `binding`,
 * the declaration (made by `repositoryOf`) throws
 * `RepositoryUsedOutsideApplication` from then on.
 */
export function bindRepository<Repository extends object>(
	repository: Repository,
	provider: IRepositoryProvider | undefined,
	instances?: ReadonlyMap<object, IRepositoryProvider>,
	binding?: RepositoryBinding,
): Repository {
	const state = stateOf(repository);
	const Declared = repository.constructor as new () => object;
	class Bound extends Declared {}
	Object.defineProperty(Bound, "name", { value: Declared.name });
	states.set(Bound, bindState(state, provider, instances, binding?.logger));
	if (binding) {
		owners.set(declarationOf(state), {
			application: binding.application,
			repository: binding.key,
		});
	}
	return Object.freeze(new Bound()) as Repository;
}

/** The provider `repository` reads and writes through. @internal */
export function providerOfRepository(
	repository: unknown,
): IRepositoryProvider | undefined {
	return findState(repository)?.provider;
}
