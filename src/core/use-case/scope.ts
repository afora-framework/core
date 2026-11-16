import type { ILogger } from "../logger/logger";
import type { IRepositoryProvider } from "../repository/types/repository.interface";
import type { ITracer, ITraceSpan } from "../tracing/tracing";
import type { Principal } from "./types/access.interface";

/**
 * What the caller of a command gives beyond its input and context: who calls
 * and the native request of the sink. Read by the factories of services.
 */
export interface CallOrigin {
	readonly principal?: Principal | null;
	readonly native?: unknown;
}

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
	/** The logger of the application running the call, given by its command. */
	readonly logger?: ILogger;
	/** The tracer of the application running the call, given by its command. */
	readonly tracer?: ITracer;
	/** The span of the caller (a command, a use case): the parent of the next. */
	readonly span?: ITraceSpan;
	/**
	 * The values of the services of the call, by service name, made once and
	 * shared by every use case the call runs.
	 */
	readonly services?: Map<string, Promise<unknown>>;
	/** The context of the call (that of the command), for the factories of services. */
	readonly context?: unknown;
	/** Who calls and the native request, for the factories of services. */
	readonly origin?: CallOrigin;
}

/**
 * Key of the constructor options (and of the repository view) that carries
 * the `ExecutionScope`. Not exported by the package: only the core passes it.
 */
export const ScopeKey: unique symbol = Symbol("afora.use-case.scope");

/**
 * Key of the options of `command.run` (and `execute`) that carries the
 * `CallOrigin` an output gives. Not exported by the package.
 */
export const OriginKey: unique symbol = Symbol("afora.call.origin");

/**
 * Key of the options of `command.run` that takes a function to call with
 * the status the use case chose with `withStatus`, if it chose one: how an
 * output learns it. Not exported by the package.
 */
export const StatusKey: unique symbol = Symbol("afora.call.status");

/** The provider `scope` gives the call in place of `provider`. */
export function scopedProvider<Provider extends IRepositoryProvider>(
	scope: ExecutionScope | undefined,
	provider: Provider,
): Provider {
	return (scope?.providers.get(provider) as Provider | undefined) ?? provider;
}
