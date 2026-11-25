import type { Clock } from "./clock";

/** Hashes and checks passwords. `verifySync` is optional. */
export interface PasswordHasher {
	hash(plain: string): Promise<string>;
	verify(plain: string, hash: string): Promise<boolean>;
	verifySync?(plain: string, hash: string): boolean;
}

/** Makes a new id, as a UUID v7 string. */
export type IdGenerator = () => string;

/** The runtime services afora uses; each is replaceable. */
export interface RuntimeServices {
	hasher?: PasswordHasher;
	idGenerator?: IdGenerator;
	/** The current time in epoch milliseconds; `manualClock()` of `@afora/core/testing` is one. */
	clock?: Clock;
}

/**
 * The services in force for the code running now: those of `withRuntime`
 * (`scoped`, the inner call winning each service) over those of the
 * application running the call (`application`), resolved once per scope.
 * @internal
 */
export interface RuntimeFrame {
	readonly scoped: RuntimeServices | undefined;
	readonly application: RuntimeServices | undefined;
	readonly hasher: PasswordHasher | undefined;
	readonly idGenerator: IdGenerator | undefined;
	readonly clock: Clock | undefined;
}

/**
 * Key of the use case classes an application binds that carries its runtime
 * services. Not exported by the package.
 */
export const ApplicationRuntimeKey: unique symbol = Symbol(
	"afora.application.runtime",
);

/** What may carry the runtime services of an application. @internal */
export type RuntimeHolder = {
	readonly [ApplicationRuntimeKey]?: RuntimeServices;
};

/** The slice of `AsyncLocalStorage` afora uses. @internal */
export interface AsyncContextStorage<Store> {
	run<Value>(store: Store, fn: () => Value): Value;
	getStore(): Store | undefined;
	enterWith(store: Store): void;
}
type AsyncStorage = AsyncContextStorage<RuntimeFrame>;

/** Whether a scope was ever entered: until then, no read looks for one. */
let used = false;
/** The storage that carries the scope across awaits; `null` where the runtime has none, `undefined` until looked up. */
let storage: AsyncStorage | null | undefined;
/** The scope of the synchronous code running now, where there is no storage. */
let current: RuntimeFrame | undefined;

/**
 * A new `AsyncLocalStorage` of `node:async_hooks`, looked up when it is
 * first needed and not at import, so that afora loads where there is none;
 * `null` where the runtime has none.
 * @internal
 */
export function newAsyncStorage<Store>(): AsyncContextStorage<Store> | null {
	const process = (
		globalThis as {
			process?: { getBuiltinModule?: (id: string) => unknown };
		}
	).process;
	const hooks = process?.getBuiltinModule?.("node:async_hooks") as
		| { AsyncLocalStorage?: new () => AsyncContextStorage<Store> }
		| undefined;
	return typeof hooks?.AsyncLocalStorage === "function"
		? new hooks.AsyncLocalStorage()
		: null;
}

/**
 * The services in force for the code running now, or `undefined` outside
 * any `withRuntime` and any application with a `runtime`. A single check
 * until the first scope is entered.
 * @internal
 */
export function activeRuntime(): RuntimeFrame | undefined {
	if (!used) return undefined;
	return storage ? storage.getStore() : current;
}

/** Runs `fn` in `frame`, and gives back the scope that was in force once it returns or throws. */
function enter<Value>(frame: RuntimeFrame, fn: () => Value): Value {
	if (storage === undefined) storage = newAsyncStorage<RuntimeFrame>();
	used = true;
	if (storage) return storage.run(frame, fn);
	const previous = current;
	current = frame;
	try {
		return fn();
	} finally {
		current = previous;
	}
}

function frameOf(
	scoped: RuntimeServices | undefined,
	application: RuntimeServices | undefined,
): RuntimeFrame {
	return {
		scoped,
		application,
		hasher: scoped?.hasher ?? application?.hasher,
		idGenerator: scoped?.idGenerator ?? application?.idGenerator,
		clock: scoped?.clock ?? application?.clock,
	};
}

const SERVICES: Readonly<Record<keyof RuntimeServices, string>> = {
	hasher: "object",
	idGenerator: "function",
	clock: "function",
};

/**
 * Why `services` is not a set of runtime services, or `undefined` when it
 * is: an object whose keys are among `hasher`, `idGenerator` and `clock`.
 * @internal
 */
export function runtimeServicesProblem(services: unknown): string | undefined {
	if (typeof services !== "object" || services === null) {
		return "Expected the runtime services as an object.";
	}
	for (const key of Reflect.ownKeys(services)) {
		const value = (services as Record<PropertyKey, unknown>)[key];
		if (typeof key !== "string" || !Object.hasOwn(SERVICES, key)) {
			return `Unknown runtime service "${String(key)}"; expected hasher, idGenerator or clock.`;
		}
		if (value === undefined) continue;
		if (key === "hasher") {
			const hasher = value as Partial<PasswordHasher> | null;
			if (
				typeof hasher !== "object" ||
				hasher === null ||
				typeof hasher.hash !== "function" ||
				typeof hasher.verify !== "function"
			) {
				return "Expected hasher to be an object with hash and verify.";
			}
		} else if (typeof value !== SERVICES[key as keyof RuntimeServices]) {
			return `Expected ${key} to be a function.`;
		}
	}
	return undefined;
}

/** The services of `services` that are given, frozen. */
function given(services: RuntimeServices): RuntimeServices {
	const kept: RuntimeServices = {};
	if (services.hasher !== undefined) kept.hasher = services.hasher;
	if (services.idGenerator !== undefined)
		kept.idGenerator = services.idGenerator;
	if (services.clock !== undefined) kept.clock = services.clock;
	return Object.freeze(kept);
}

/**
 * Runs `fn` with `services` in place of those of the application running
 * the call and of `configure`: the hasher, the id generator and the clock
 * that `fn` and what it calls read, entities and repositories included. A
 * service it is not given stays as it was. Calls nest, the inner one winning
 * each service it gives, and the services in force before come back when
 * `fn` returns or throws. Gives what `fn` returns, a promise included.
 *
 * Where the runtime has `AsyncLocalStorage` (Bun, Node, Deno, Workers with
 * `nodejs_compat`), the services follow `fn` across awaits; elsewhere they
 * cover only its synchronous part, up to its first `await`.
 *
 * @throws {TypeError} when `services` holds something other than a hasher, an id generator or a clock.
 *
 * @example
 * ```ts
 * import { blueprintOf, entityOf, withRuntime } from "@afora/core";
 *
 * class Note extends entityOf(blueprintOf((ctx) => ({ title: ctx.string }))) {}
 *
 * const note = withRuntime(
 * 	{ idGenerator: () => "01890000-0000-7000-8000-000000000001" },
 * 	() => new Note({ title: "a" }),
 * );
 * note.id; // "01890000-0000-7000-8000-000000000001"
 * ```
 */
export function withRuntime<Value>(
	services: RuntimeServices,
	fn: () => Value,
): Value {
	const problem = runtimeServicesProblem(services);
	if (problem !== undefined) throw new TypeError(problem);
	if (typeof fn !== "function") {
		throw new TypeError("Expected withRuntime to be given a function to run.");
	}
	const outer = activeRuntime();
	const scoped = outer?.scoped
		? Object.freeze({ ...outer.scoped, ...given(services) })
		: given(services);
	return enter(frameOf(scoped, outer?.application), fn);
}

/**
 * Runs `fn` with the runtime services of an application, under those of any
 * `withRuntime` around it; runs it as it is when they are already in force.
 * @internal
 */
export function withApplicationRuntime<Value>(
	services: RuntimeServices,
	fn: () => Value,
): Value {
	const outer = activeRuntime();
	if (outer?.application === services) return fn();
	return enter(frameOf(outer?.scoped, services), fn);
}

/**
 * The runtime services an application gives: `settings` checked, over
 * those it inherits, frozen; `undefined` when it gives none.
 * @internal
 */
export function applicationRuntimeOf(
	inheritedServices: readonly (RuntimeServices | undefined)[],
	settings: RuntimeServices | undefined,
): RuntimeServices | undefined {
	const merged: RuntimeServices = {};
	for (const services of [...inheritedServices, settings]) {
		if (services !== undefined) Object.assign(merged, given(services));
	}
	return Object.keys(merged).length === 0 ? undefined : Object.freeze(merged);
}

/**
 * Forgets every scope and, with `asyncContext: false`, acts as a runtime
 * without `AsyncLocalStorage`. For the tests of afora.
 * @internal
 */
export function resetRuntimeScopes(
	options: { readonly asyncContext?: boolean } = {},
): void {
	used = false;
	current = undefined;
	storage = options.asyncContext === false ? null : undefined;
}
