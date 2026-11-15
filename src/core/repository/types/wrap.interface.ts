import type {
	IRepositoryProvider,
	RepositoryContext,
} from "./repository.interface";

/**
 * The operations of an `IRepositoryProvider` that take a `RepositoryContext`
 * first: the ones `wrapProvider` hands to `around`. `transaction` and `close`
 * take none and are not intercepted (the provider a transaction gives is
 * wrapped with the same interceptor).
 */
export type ProviderOperation =
	| "findOne"
	| "findMany"
	| "insert"
	| "update"
	| "remove"
	| "count"
	| "increment"
	| "migrate";

type ProviderArgsOf<Fn> = Fn extends (
	context: never,
	...args: infer Args
) => unknown
	? Readonly<Args>
	: never;

/**
 * One call to a provider, as `around` gets it: the `operation`, its
 * `context` and the arguments after it (`args`), typed by operation, so a
 * `switch` on `operation` narrows `args`.
 */
export type ProviderCall<Environment = unknown> = {
	readonly [Operation in ProviderOperation]: {
		readonly operation: Operation;
		readonly context: RepositoryContext<Environment>;
		readonly args: ProviderArgsOf<
			NonNullable<IRepositoryProvider<Environment>[Operation]>
		>;
	};
}[ProviderOperation];

/** What `wrapProvider` runs around each operation of a provider. */
export interface ProviderInterceptor<Environment = unknown> {
	/**
	 * Runs around one operation: `next()` calls the provider and gives what
	 * it gives, which `around` returns (or replaces); an error of `next()`
	 * rejects the operation unless `around` catches it.
	 */
	around(
		call: ProviderCall<Environment>,
		next: () => Promise<unknown>,
	): Promise<unknown>;
}

/** The `Environment` of a provider type. */
export type ProviderEnvironmentOf<Provider> =
	Provider extends IRepositoryProvider<infer Environment>
		? Environment
		: unknown;
