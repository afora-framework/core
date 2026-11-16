import type {
	AnyEnvironment,
	EnvironmentValue,
} from "../environment/environment";
import type { ILogger } from "../logger/logger";
import { Kind } from "../symbols/kind";
import type { Principal } from "./types/access.interface";
import { InvalidUseCaseDeclaration } from "./use-case";

/** Carries the type of the value of a service; never set at run time. */
declare const ServiceValue: unique symbol;

/**
 * A service a use case depends on by name, made by {@link serviceOf}: a
 * cache, a storage, a client of another API. An application gives its value
 * per call (`applicationOf({ services })`); `execute` can replace it.
 */
export interface ServiceDeclaration<Value = unknown> {
	readonly [Kind]: "service";
	/** The name the application binds it under. */
	readonly name: string;
	/** @internal The type of its value. */
	readonly [ServiceValue]?: Value;
}

/** Any service made by {@link serviceOf}. */
export type AnyService = ServiceDeclaration<unknown>;

/** The value a service gives a use case. */
export type ServiceValueOf<Service> =
	Service extends ServiceDeclaration<infer Value> ? Value : never;

/**
 * What the factory of a service gets, once per call: the name of the
 * service, the context of the call and who calls, its logger, the variables
 * of an environment, and what the sink that received the call gives as
 * `native` (the Hono context, a Request), if any.
 */
export interface ServiceScope {
	/** The name of the service being made. */
	readonly name: string;
	/** The context of the call: that of the command, else that of the use case. */
	readonly context: unknown;
	/** Who calls, as the sink authenticated it; `null` or `undefined` without one. */
	readonly principal: Principal | null | undefined;
	/** The logger of the call. */
	readonly logger: ILogger;
	/** The native request of the sink that received the call (e.g. the Hono context), if any. */
	readonly native: unknown;
	/** The variables of `environment` for this call. */
	environment<Environment extends AnyEnvironment>(
		environment: Environment,
	): EnvironmentValue<Environment>;
}

/** Makes the value of a service for a call; may be async. */
export type ServiceFactory<Value = unknown> = (
	scope: ServiceScope,
) => Value | Promise<Value>;

/** The factories of the services of an application, by service name. */
export type ServiceFactories = Readonly<Record<string, ServiceFactory>>;

/**
 * Key of the factories an application binds to its use cases. Not exported
 * by the package: only the core sets it.
 */
export const ApplicationServicesKey: unique symbol = Symbol(
	"afora.application.services",
);

/** The service factories `owner` (a use case class bound by an application) carries. */
export function serviceFactoriesOf(
	owner: unknown,
): ServiceFactories | undefined {
	return (owner as { readonly [ApplicationServicesKey]?: ServiceFactories })?.[
		ApplicationServicesKey
	];
}

const SERVICE_NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * Declares a service named `name`, a dependency of use cases whose value an
 * application gives per call: `dependencies: { cache: Cache }` makes
 * `this.dependencies.cache` a `Value`. A use case reads it as it is (no
 * `await`): the factories of the services it declares run before its
 * `execute`, once per call.
 *
 * @throws {@link InvalidUseCaseDeclaration} when `name` is not an identifier.
 *
 * @example
 * ```ts
 * import { serviceOf } from "@afora/core";
 *
 * interface CacheClient {
 * 	get(key: string): Promise<string | null>;
 * }
 * const Cache = serviceOf<CacheClient>("cache");
 * ```
 */
export function serviceOf<Value>(name: string): ServiceDeclaration<Value> {
	if (typeof name !== "string" || !SERVICE_NAME.test(name)) {
		throw new InvalidUseCaseDeclaration({
			source: "serviceOf",
			details: {
				reason: "Expected the name of a service to be an identifier.",
			},
		});
	}
	return Object.freeze({ [Kind]: "service" as const, name });
}

/** Whether `value` is a service made by {@link serviceOf}. */
export function isService(value: unknown): value is AnyService {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "service" &&
		typeof (value as { name?: unknown }).name === "string"
	);
}
