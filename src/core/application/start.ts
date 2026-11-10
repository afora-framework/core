import { InvalidCommandDeclaration } from "../command/exceptions";
import {
	type AnyEnvironment,
	type EnvironmentDependencies,
	isEnvironment,
	loadEnvironments,
	type MergedEnvironment,
} from "../environment/environment";
import type { LogSettings } from "../logger/logger";
import type { IRepositoryProvider } from "../repository/types/repository.interface";
import { Kind } from "../symbols/kind";
import {
	ApplicationNotStarted,
	InvalidApplicationDeclaration,
} from "./exceptions";
import type { ApplicationContext } from "./types/application.interface";

/**
 * A provider an application creates when it starts, from the variables of
 * its environments: what `providerFrom` makes.
 */
export interface ProviderFactory<
	Environment extends EnvironmentDependencies = EnvironmentDependencies,
> {
	readonly [Kind]: "provider-factory";
	/** The environments whose variables `create` gets, as a list. */
	readonly environments: readonly AnyEnvironment[];
	readonly create: (
		env: MergedEnvironment<Environment>,
	) => IRepositoryProvider | Promise<IRepositoryProvider>;
	/** Whether `create` takes the context of the application instead of variables. */
	readonly withContext: boolean;
}

/**
 * A provider made on `app.start()`: `create` gets the variables of
 * `environmentDependencies` (one environment or a list, merged in order),
 * read and validated then, e.g.
 * `providerFrom(Database, (env) => drizzleProvider({ db: connect(env.DATABASE_URL), tables }))`.
 */
export function providerFrom<const Environment extends EnvironmentDependencies>(
	environmentDependencies: Environment,
	create: (
		env: MergedEnvironment<Environment>,
	) => IRepositoryProvider | Promise<IRepositoryProvider>,
): ProviderFactory<Environment>;
/**
 * A provider made on `app.start()` from the context of the application:
 * `ctx.env(Database)` gives the variables of a registered environment and
 * `ctx.logger` its logger, e.g.
 * `providerFrom((ctx) => drizzleProvider({ db: connect(ctx.env(Database).DATABASE_URL), tables }))`.
 */
export function providerFrom(
	create: (
		context: ApplicationContext,
	) => IRepositoryProvider | Promise<IRepositoryProvider>,
): ProviderFactory<readonly []>;
export function providerFrom(
	environmentDependencies: unknown,
	create?: unknown,
): ProviderFactory {
	if (typeof environmentDependencies === "function" && create === undefined) {
		return Object.freeze({
			[Kind]: "provider-factory" as const,
			environments: Object.freeze([]),
			create: environmentDependencies as ProviderFactory["create"],
			withContext: true,
		});
	}
	const list: unknown[] = isEnvironment(environmentDependencies)
		? [environmentDependencies]
		: Array.isArray(environmentDependencies)
			? [...environmentDependencies]
			: [null];
	if (
		!list.every(isEnvironment) ||
		new Set(list).size !== list.length ||
		typeof create !== "function"
	) {
		throw new InvalidApplicationDeclaration({
			source: "providerFrom",
			details: {
				reason:
					"Expected distinct environments made by environmentOf and a create function.",
			},
		});
	}
	return Object.freeze({
		[Kind]: "provider-factory" as const,
		environments: Object.freeze(list as AnyEnvironment[]),
		create: create as ProviderFactory["create"],
		withContext: false,
	});
}

/** A `log` an application makes on `app.start()`: what `logFrom` makes. */
export interface LogFactory {
	readonly [Kind]: "log-factory";
	readonly create: (
		context: ApplicationContext,
	) => LogSettings | Promise<LogSettings>;
}

/**
 * A `log` made on `app.start()` from the context of the application, before
 * its provider, e.g. `logFrom((ctx) => ({ level: ctx.env(Logging).LOG_LEVEL,
 * providers: [jsonLogProvider()] }))`. Until then the application logs nothing.
 */
export function logFrom(
	create: (context: ApplicationContext) => LogSettings | Promise<LogSettings>,
): LogFactory {
	if (typeof create !== "function") {
		throw new InvalidApplicationDeclaration({
			source: "logFrom",
			details: { reason: "Expected logFrom to take a create function." },
		});
	}
	return Object.freeze({ [Kind]: "log-factory" as const, create });
}

/** Whether `value` was made by `logFrom`. */
export function isLogFactory(value: unknown): value is LogFactory {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "log-factory"
	);
}

/** Whether `value` was made by `providerFrom`. */
export function isProviderFactory(value: unknown): value is ProviderFactory {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "provider-factory"
	);
}

/** What an application keeps of the provider it makes on start. */
interface Deferred {
	readonly factory: ProviderFactory;
	/** The application that declared the factory, for the messages. */
	readonly application: string;
	provider: IRepositoryProvider | undefined;
	starting: Promise<IRepositoryProvider> | undefined;
}

const deferred = new WeakMap<object, Deferred>();

const METHODS = [
	"findOne",
	"findMany",
	"insert",
	"update",
	"remove",
	"count",
] as const;

/**
 * The provider the repositories of an application are bound to when it was
 * declared with `providerFrom`: each call goes to the provider made on start,
 * and throws `ApplicationNotStarted` before it.
 * @internal
 */
export function deferredProvider(
	factory: ProviderFactory,
	application: string,
): IRepositoryProvider {
	const state: Deferred = {
		factory,
		application,
		provider: undefined,
		starting: undefined,
	};
	const real = (method: string): IRepositoryProvider => {
		const { provider } = state;
		if (!provider) {
			throw new ApplicationNotStarted({
				source: application,
				details: { application },
			});
		}
		if (
			typeof (provider as unknown as Record<string, unknown>)[method] !==
			"function"
		) {
			throw new InvalidApplicationDeclaration({
				source: application,
				details: {
					reason: `The provider made on start has no "${method}".`,
				},
			});
		}
		return provider;
	};
	const proxy: Record<string, unknown> = {};
	for (const method of [...METHODS, "increment"]) {
		proxy[method] = (...args: unknown[]) =>
			(
				real(method) as unknown as Record<
					string,
					(...args: unknown[]) => unknown
				>
			)[method]?.(...args);
	}
	proxy.transaction = (run: (provider: IRepositoryProvider) => unknown) =>
		(
			real("transaction").transaction as NonNullable<
				IRepositoryProvider["transaction"]
			>
		)(run as never);
	Object.defineProperty(proxy, "capabilities", {
		get: () => state.provider?.capabilities,
		enumerable: true,
	});
	Object.freeze(proxy);
	deferred.set(proxy, state);
	return proxy as unknown as IRepositoryProvider;
}

/** Whether `provider` was made by `deferredProvider`. @internal */
export function isDeferredProvider(provider: unknown): boolean {
	return (
		typeof provider === "object" && provider !== null && deferred.has(provider)
	);
}

/** The environments the factory behind `provider` reads, if it is deferred. @internal */
export function deferredEnvironments(
	provider: unknown,
): readonly AnyEnvironment[] {
	return (
		(typeof provider === "object" && provider !== null
			? deferred.get(provider)?.factory.environments
			: undefined) ?? []
	);
}

/**
 * Makes the provider behind `provider` once, from the variables of its
 * environments (already validated by the caller); later calls give the same.
 * @internal
 */
export function startDeferred(
	provider: IRepositoryProvider,
	context: ApplicationContext,
): Promise<IRepositoryProvider> | undefined {
	const state = deferred.get(provider);
	if (!state) return undefined;
	state.starting ??= (async () => {
		const made = await state.factory.create(
			(state.factory.withContext
				? context
				: loadEnvironments(state.factory.environments)) as never,
		);
		if (typeof made !== "object" || made === null) {
			state.starting = undefined;
			throw new InvalidApplicationDeclaration({
				source: state.application,
				details: {
					reason:
						"Expected providerFrom's create to give a repository provider.",
				},
			});
		}
		state.provider = made;
		return made;
	})();
	return state.starting;
}

/**
 * Closes the provider made on start and forgets it, so that calls throw
 * `ApplicationNotStarted` again; a provider that is not deferred is closed.
 * @internal
 */
export async function stopProvider(
	provider: IRepositoryProvider,
): Promise<void> {
	const state = deferred.get(provider);
	if (!state) {
		await provider.close?.();
		return;
	}
	const made = state.provider;
	state.provider = undefined;
	state.starting = undefined;
	await made?.close?.();
}

/**
 * Throws `InvalidCommandDeclaration` when `provider` cannot run the
 * transactions of `commands` (it has no `transaction`, or says it has none).
 * @internal
 */
export function checkTransactions(
	source: string,
	provider: IRepositoryProvider,
	commands: readonly string[],
): void {
	if (commands.length === 0) return;
	if (
		typeof provider.transaction !== "function" ||
		provider.capabilities?.transactions === false
	) {
		throw new InvalidCommandDeclaration({
			source,
			details: {
				reason: `The provider made on start does not support transactions, which ${commands.join(", ")} declare.`,
			},
		});
	}
}

/**
 * Throws `InvalidApplicationDeclaration` when `provider` does not read by
 * cursor (`capabilities.keyset`) and some of `repositories` declare
 * `findCursor`.
 * @internal
 */
export function checkCapabilities(
	source: string,
	provider: IRepositoryProvider,
	repositories: readonly string[],
): void {
	if (repositories.length === 0 || provider.capabilities?.keyset === true)
		return;
	throw new InvalidApplicationDeclaration({
		source,
		details: {
			reason: `The provider made on start does not read by cursor (capabilities.keyset), which the findCursor of ${repositories.join(", ")} needs.`,
		},
	});
}
