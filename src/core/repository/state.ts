import { EntityUniqueKeys } from "../entity/abstract-entity";
import {
	type EnvironmentDependencies,
	loadEnvironments,
} from "../environment/environment";
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
		env: loadEnvironments(state.environment),
	});
	return state.context;
}

/** What an application reads from a repository, without reaching its state. */
export interface RepositoryInspection {
	readonly entity: AnyRepositoryEntity;
	readonly actions: readonly string[];
	readonly deletion: "hard" | "soft";
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

/**
 * `state` reading and writing through `provider`, unless it declared its own;
 * its relations are bound the same way. The original is left as it is.
 */
function bindState(
	state: RepositoryState,
	provider: IRepositoryProvider,
	bound = new Map<RepositoryState, RepositoryState>(),
): RepositoryState {
	const done = bound.get(state);
	if (done) return done;
	const copy: RepositoryState = {
		...state,
		provider: state.explicitProvider ? state.provider : provider,
		context: undefined,
		relations: new Map(
			[...state.relations].map(([target, related]) => [
				target,
				bindState(related, provider, bound),
			]),
		),
	};
	origins.set(copy, declarationOf(state));
	bound.set(state, copy);
	return copy;
}

/**
 * A repository sharing the declaration of `repository` that reads and writes
 * through `provider`, unless it declared a provider of its own.
 */
export function bindRepository<Repository extends object>(
	repository: Repository,
	provider: IRepositoryProvider,
): Repository {
	const state = stateOf(repository);
	const Declared = repository.constructor as new () => object;
	class Bound extends Declared {}
	Object.defineProperty(Bound, "name", { value: Declared.name });
	states.set(Bound, bindState(state, provider));
	return Object.freeze(new Bound()) as Repository;
}
