import type { IRepositoryProvider } from "../repository/types/repository.interface";

/**
 * What a call carries to its repositories, internal: the providers that
 * replace the ones the repositories declared (e.g. one inside a transaction).
 */
export interface ExecutionScope {
	/** Provider used by the call for each provider the repositories declared. */
	readonly providers: ReadonlyMap<IRepositoryProvider, IRepositoryProvider>;
	/**
	 * The variables a command gives the call in place of those an environment
	 * loads, by environment: a use case that declares it gets these.
	 */
	readonly environments?: ReadonlyMap<
		object,
		Readonly<Record<string, unknown>>
	>;
}

/**
 * Key of the constructor options (and of the repository view) that carries
 * the `ExecutionScope`. Not exported by the package: only the core passes it.
 */
export const ScopeKey: unique symbol = Symbol("afora.use-case.scope");

/** The provider `scope` gives the call in place of `provider`. */
export function scopedProvider<Provider extends IRepositoryProvider>(
	scope: ExecutionScope | undefined,
	provider: Provider,
): Provider {
	return (scope?.providers.get(provider) as Provider | undefined) ?? provider;
}
