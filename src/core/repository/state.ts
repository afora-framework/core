import {
	EntitySettings,
	EntityUniqueKeys,
	EXPIRES_AT,
	SCHEMA_VERSION_KEY,
} from "../entity/abstract-entity";
import type { EntityStorageSettings } from "../entity/types/entity.interface";
import {
	type EnvironmentDependencies,
	loadEnvironments,
} from "../environment/environment";
import type { ILogger } from "../logger/logger";
import {
	type AsyncContextStorage,
	newAsyncStorage,
	type RuntimeServices,
} from "../runtime-scope";
import {
	RepositoryUsedOutsideApplication,
	RepositoryWrittenOutsideApplication,
} from "./exceptions";
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
	/**
	 * Its declared parents, by the key of its entity that holds the id of the
	 * parent: the state of the declaration of the parent repository, and what
	 * a delete of the parent does to its entities.
	 */
	readonly parents: Readonly<Record<string, RepositoryParentState>>;
	/**
	 * The repositories that declare this one their parent, set by the
	 * application that bound it (only on a bound state): what its `delete`
	 * cascades to or is restricted by.
	 */
	children?: readonly RepositoryChild[];
	/** The logger of the application that bound it, for `scans: "warn"`. */
	readonly logger?: ILogger;
	/** The runtime services of the application that bound it, in force for its calls. */
	readonly runtime?: RuntimeServices;
	/** The variables an application made by `app.with` gives in place of its environments. */
	readonly environments?: ReadonlyMap<
		object,
		Readonly<Record<string, unknown>>
	>;
	context?: RepositoryContext;
}

/** A parent of a repository, as its state holds it. */
export interface RepositoryParentState {
	/** The state of the declaration of the parent repository. */
	readonly state: RepositoryState;
	readonly onDelete: "cascade" | "restrict";
}

/** A repository that declares another its parent, as the bound state of the parent holds it. */
export interface RepositoryChild {
	/** The child repository, as the application bound it. */
	readonly repository: object;
	/** The key of its entity that holds the id of the parent. */
	readonly key: string;
	readonly onDelete: "cascade" | "restrict";
}

/** The getters that give the actions of a repository, which are not members of it a caller defines. */
export const actionGetters = new WeakSet<object>();

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

/** The key holding the date at which the entities of `entity` expire, if they do. */
function expiryKeyOf(entity: object): string | undefined {
	const expires = (
		entity as { readonly [EntitySettings]?: EntityStorageSettings }
	)[EntitySettings]?.expires;
	if (expires === undefined) return undefined;
	return "at" in expires ? expires.at : EXPIRES_AT;
}

export { SCHEMA_VERSION_KEY };

/** `RepositoryContext.schema` of `entity`, when it declares `schemaVersion`. */
function schemaOf(entity: object): RepositoryContext["schema"] {
	const settings = (
		entity as { readonly [EntitySettings]?: EntityStorageSettings }
	)[EntitySettings];
	if (!settings?.schemaVersioned) return undefined;
	return Object.freeze({
		version: settings.schemaVersion,
		key: SCHEMA_VERSION_KEY,
		previousNames: settings.previousNames,
	});
}

/** The context of the provider, with the environment read on first use. */
export function contextOf(state: RepositoryState): RepositoryContext {
	if (state.context) return state.context;
	const key = expiryKeyOf(state.entity);
	const schema = schemaOf(state.entity);
	state.context = Object.freeze({
		entity: state.entity,
		name: state.name,
		unique: state.entity[EntityUniqueKeys],
		indexes: state.indexes,
		...(key === undefined ? {} : { expiry: Object.freeze({ key }) }),
		...(schema === undefined ? {} : { schema }),
		env: loadEnvironments(state.environment, state.environments),
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
	/** Its parents by key: the declaration of the parent repository (compare with `inspect(...).state`) and `onDelete`. */
	readonly parents: Readonly<
		Record<
			string,
			{ readonly repository: object; readonly onDelete: "cascade" | "restrict" }
		>
	>;
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
		parents: Object.fromEntries(
			Object.entries(state.parents).map(([key, parent]) => [
				key,
				{ repository: declarationOf(parent.state), onDelete: parent.onDelete },
			]),
		),
		state: declarationOf(state),
	};
}

/** The state a bound copy comes from, or the state itself. */
const origins = new WeakMap<RepositoryState, RepositoryState>();

/** The state a bound copy comes from, or `state` itself: its declaration. @internal */
export function declarationOf(state: RepositoryState): RepositoryState {
	return origins.get(state) ?? state;
}

/**
 * What identifies the declaration of `repository`, shared by every
 * repository that extends or is bound from it (as `inspectRepository(...).state`),
 * without the rest of the inspection; `undefined` when it is not one.
 */
export function repositoryDeclarationOf(
	repository: unknown,
): object | undefined {
	const state = findState(repository);
	return state === undefined ? undefined : declarationOf(state);
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
	runtime: RuntimeServices | undefined,
	environments:
		| ReadonlyMap<object, Readonly<Record<string, unknown>>>
		| undefined,
	bound = new Map<RepositoryState, RepositoryState>(),
): RepositoryState {
	const done = bound.get(state);
	if (done) return done;
	const copy: RepositoryState = {
		...state,
		logger,
		runtime,
		environments,
		provider: state.explicitProvider
			? (instances?.get(state.provider) ?? state.provider)
			: (provider ?? state.provider),
		context: undefined,
		children: undefined,
		relations: new Map(
			[...state.relations].map(([target, related]) => [
				target,
				bindState(
					related,
					provider,
					instances,
					logger,
					runtime,
					environments,
					bound,
				),
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

/** A strict test application: the declarations it binds, and whether it runs. */
interface StrictScope {
	readonly application: string;
	readonly declarations: Set<object>;
	running: boolean;
}

/** The check of strict writes, for `testApplicationOf(app, { strict: true })`. @internal */
export interface StrictWrites {
	/** Runs `fn` with the check, where the runtime has `AsyncLocalStorage` and it runs. */
	run<Value>(fn: () => Value): Value;
	/** Starts the check, `declarations` (the states of `inspectRepository`) being those the application binds. */
	start(declarations: Iterable<object>): void;
	/** Ends the check. */
	stop(): void;
}

/**
 * Key of the use case classes a strict test application binds: gives the
 * check of the run of the application, so that its use cases run with it.
 * @internal
 */
export const StrictWritesKey: unique symbol = Symbol(
	"afora.application.strict",
);

/** What may carry the check of a strict test application. @internal */
export type StrictWritesHolder = {
	readonly [StrictWritesKey]?: () => StrictWrites | undefined;
};

/** Whether a strict application was ever started: until then, no write looks for one. */
let strictUsed = false;
/** The storage carrying the strict applications across awaits; `null` without `AsyncLocalStorage`, `undefined` until looked up. */
let strictStorage:
	| AsyncContextStorage<readonly StrictScope[]>
	| null
	| undefined;
/** The strict applications running, the latest last, where there is no storage: process-wide. */
const processStrict: StrictScope[] = [];

/** The declarations an application registers without binding them: their writes are its own. */
const registeredDeclarations = new WeakSet<object>();

/**
 * Keeps `declaration` (the state of `inspectRepository`) as registered by
 * an application, which strict mode leaves alone unless the strict
 * application binds it too.
 * @internal
 */
export function markRegisteredRepository(declaration: object): void {
	registeredDeclarations.add(declaration);
}

/**
 * The check of writes of a strict test application named `application`.
 * Where the runtime has `AsyncLocalStorage`, it covers the async context
 * of the code calling this function (a test, and what it calls) once
 * started; elsewhere it covers the whole process while it runs. To be called
 * synchronously by what the test calls, so that the context is the test's.
 * @internal
 */
export function strictWritesOf(application: string): StrictWrites {
	const scope: StrictScope = {
		application,
		declarations: new Set(),
		running: false,
	};
	if (strictStorage === undefined) {
		strictStorage = newAsyncStorage<readonly StrictScope[]>();
	}
	strictUsed = true;
	if (strictStorage) {
		strictStorage.enterWith([...(strictStorage.getStore() ?? []), scope]);
	}
	return {
		run(fn) {
			if (!strictStorage || !scope.running) return fn();
			const store = strictStorage.getStore() ?? [];
			if (store.includes(scope)) return fn();
			return strictStorage.run([...store, scope], fn);
		},
		start(declarations) {
			for (const declaration of declarations) {
				scope.declarations.add(declaration);
			}
			if (scope.running) return;
			scope.running = true;
			if (!strictStorage) processStrict.push(scope);
		},
		stop() {
			if (!scope.running) return;
			scope.running = false;
			const index = processStrict.lastIndexOf(scope);
			if (index !== -1) processStrict.splice(index, 1);
		},
	};
}

/**
 * Forgets every strict application and, with `asyncContext: false`, acts as
 * a runtime without `AsyncLocalStorage`. For the tests of afora.
 * @internal
 */
export function resetStrictWrites(
	options: { readonly asyncContext?: boolean } = {},
): void {
	strictUsed = false;
	processStrict.length = 0;
	strictStorage = options.asyncContext === false ? null : undefined;
}

/**
 * Throws `RepositoryWrittenOutsideApplication` when a strict test
 * application runs (in this async context, where there is one) and
 * `state` is a declaration, not a repository an application bound: one
 * the strict application binds, or one no application registers. Its rows
 * would outlive the test.
 */
export function assertWritable(state: RepositoryState): void {
	if (!strictUsed || origins.has(state)) return;
	const scopes = strictStorage
		? (strictStorage.getStore() ?? [])
		: processStrict;
	let latest: StrictScope | undefined;
	let claimed: StrictScope | undefined;
	for (const scope of scopes) {
		if (!scope.running) continue;
		latest = scope;
		if (scope.declarations.has(state)) claimed = scope;
	}
	if (latest === undefined) return;
	if (claimed === undefined && registeredDeclarations.has(state)) return;
	throw new RepositoryWrittenOutsideApplication({
		source: state.name,
		details: { application: (claimed ?? latest).application },
	});
}

/** Where the application binding a repository comes from. */
export interface RepositoryBinding {
	/** The name of the application. */
	readonly application: string;
	/** The key of the repository in the application. */
	readonly key: string;
	/** The logger of the application, for `scans: "warn"`. */
	readonly logger?: ILogger;
	/**
	 * Whether the declaration throws `RepositoryUsedOutsideApplication` from
	 * then on; `true` by default, `false` for a test application, which
	 * leaves the declarations as they were.
	 */
	readonly claim?: boolean;
}

/**
 * A repository sharing the declaration of `repository` that reads and writes
 * through `provider`, unless it declared a provider of its own; a declared
 * provider found in `instances` is replaced by its value. With `binding`
 * (unless `binding.claim` is `false`), the declaration (made by `repositoryOf`) throws
 * `RepositoryUsedOutsideApplication` from then on. With `runtime`, its calls
 * run with those services. With `environments`, its provider reads those
 * variables in place of the environments they replace.
 */
export function bindRepository<Repository extends object>(
	repository: Repository,
	provider: IRepositoryProvider | undefined,
	instances?: ReadonlyMap<object, IRepositoryProvider>,
	binding?: RepositoryBinding,
	runtime?: RuntimeServices,
	environments?: ReadonlyMap<object, Readonly<Record<string, unknown>>>,
): Repository {
	const state = stateOf(repository);
	const Declared = repository.constructor as new () => object;
	class Bound extends Declared {}
	Object.defineProperty(Bound, "name", { value: Declared.name });
	states.set(
		Bound,
		bindState(
			state,
			provider,
			instances,
			binding?.logger,
			runtime,
			environments,
		),
	);
	if (binding && binding.claim !== false) {
		owners.set(declarationOf(state), {
			application: binding.application,
			repository: binding.key,
		});
	}
	return Object.freeze(new Bound()) as Repository;
}

/**
 * Gives `repository`, a repository an application bound, the repositories
 * that declare it their parent, which its `delete` cascades to or is
 * restricted by. Only an application calls it, on the copies it bound.
 * @internal
 */
export function setRepositoryChildren(
	repository: object,
	children: readonly RepositoryChild[],
): void {
	const state = stateOf(repository);
	if (!origins.has(state)) {
		throw new TypeError("Expected a repository bound by an application");
	}
	state.children = Object.freeze([...children]);
}

/** The provider `repository` reads and writes through. @internal */
export function providerOfRepository(
	repository: unknown,
): IRepositoryProvider | undefined {
	return findState(repository)?.provider;
}
