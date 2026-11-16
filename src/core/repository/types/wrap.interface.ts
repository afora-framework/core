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

/** What each operation of a provider gives, once awaited. */
export type ProviderResults = {
	readonly [Operation in ProviderOperation]: Awaited<
		ReturnType<NonNullable<IRepositoryProvider[Operation]>>
	>;
};

/**
 * One call to a provider, as `around` gets it: the `operation`, its
 * `context` and the arguments after it (`args`), typed by operation, so a
 * `switch` on `operation` narrows `args`.
 */
export type ProviderCall<
	Environment = unknown,
	Operation extends ProviderOperation = ProviderOperation,
> = {
	readonly [Key in Operation]: {
		readonly operation: Key;
		readonly context: RepositoryContext<Environment>;
		readonly args: ProviderArgsOf<
			NonNullable<IRepositoryProvider<Environment>[Key]>
		>;
	};
}[Operation];

/** What `wrapProvider` runs around each operation of a provider. */
export interface ProviderInterceptor<Environment = unknown> {
	/**
	 * Runs around one operation: `next()` calls the provider and gives what
	 * it gives, which `around` must return (a missing `return` is a type
	 * error). `Operation` stands for the operation being called, so only the
	 * value of `next()` has its type: replacing it takes a cast to
	 * `Awaited<ReturnType<typeof next>>` (the value must be a
	 * `ProviderResults[call.operation]`). `call` is a plain union, so a
	 * `switch` on `call.operation` narrows `call.args`. An error of `next()`
	 * rejects the operation unless `around` catches it.
	 */
	around<Operation extends ProviderOperation>(
		call: ProviderCall<Environment>,
		next: () => Promise<ProviderResults[Operation]>,
	): Promise<ProviderResults[Operation]>;
}

/** The `Environment` of a provider type. */
export type ProviderEnvironmentOf<Provider> =
	Provider extends IRepositoryProvider<infer Environment>
		? Environment
		: unknown;
