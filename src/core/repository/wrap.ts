import { Kind } from "../symbols/kind";
import { InvalidRepositoryDeclaration } from "./exceptions";
import { inheritProviderDescription } from "./provider";
import type { IRepositoryProvider } from "./types/repository.interface";
import type {
	ProviderEnvironmentOf,
	ProviderInterceptor,
	ProviderOperation,
} from "./types/wrap.interface";

/** The operations taking a context, in the order of `IRepositoryProvider`. */
export const PROVIDER_OPERATIONS = [
	"findOne",
	"findMany",
	"insert",
	"update",
	"remove",
	"count",
	"increment",
	"migrate",
] as const satisfies readonly ProviderOperation[];

/** Members handled one by one, never copied as they are. */
const HANDLED = new Set<PropertyKey>([
	...PROVIDER_OPERATIONS,
	"transaction",
	"close",
	"capabilities",
	"constructor",
]);

type Callable = (...args: unknown[]) => unknown;

/** The members of `provider` and of its prototypes, but not of `Object.prototype`. */
function membersOf(provider: object): Map<PropertyKey, PropertyDescriptor> {
	const members = new Map<PropertyKey, PropertyDescriptor>();
	for (
		let current: object | null = provider;
		current && current !== Object.prototype;
		current = Object.getPrototypeOf(current)
	) {
		for (const key of Reflect.ownKeys(current)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (descriptor && !members.has(key)) members.set(key, descriptor);
		}
	}
	return members;
}

/**
 * Defines on `target` the members of a provider forwarding to `provider`:
 * each operation `provider` has (through `interceptor`, when given), its
 * `transaction` (whose provider is wrapped the same way) and `close`, a live
 * `capabilities`, and its other members (methods bound to it, values read
 * live, unless `members` is false). A key `target` already has is left as
 * it is.
 * @internal
 */
export function forwardProvider(
	target: Record<PropertyKey, unknown>,
	provider: IRepositoryProvider,
	interceptor?: ProviderInterceptor<never>,
	members = true,
): void {
	const inner = provider as unknown as Record<PropertyKey, unknown>;
	const define = (key: PropertyKey, descriptor: PropertyDescriptor) => {
		if (!Object.hasOwn(target, key))
			Object.defineProperty(target, key, { enumerable: true, ...descriptor });
	};
	for (const [key, descriptor] of members ? membersOf(provider) : []) {
		if (HANDLED.has(key)) continue;
		const value = descriptor.get ? undefined : descriptor.value;
		define(
			key,
			typeof value === "function"
				? { value: value.bind(provider), enumerable: descriptor.enumerable }
				: { get: () => inner[key], enumerable: descriptor.enumerable },
		);
	}
	for (const operation of PROVIDER_OPERATIONS) {
		if (typeof inner[operation] !== "function") continue;
		define(operation, {
			value: interceptor
				? async (context: unknown, ...args: unknown[]) =>
						interceptor.around(
							{
								operation,
								context,
								args: Object.freeze(args),
							} as never,
							(async () =>
								(inner[operation] as Callable).call(
									provider,
									context,
									...args,
								)) as never,
						)
				: (...args: unknown[]) =>
						(inner[operation] as Callable).apply(provider, args),
		});
	}
	if (typeof provider.transaction === "function") {
		define("transaction", {
			value: interceptor
				? (run: (child: IRepositoryProvider) => Promise<unknown>) =>
						provider.transaction?.((child) =>
							run(wrapProvider(child, interceptor)),
						)
				: (run: (child: IRepositoryProvider) => Promise<unknown>) =>
						provider.transaction?.(run),
		});
	}
	if (typeof provider.close === "function") {
		define("close", { value: () => provider.close?.() });
	}
	define("capabilities", { get: () => provider.capabilities });
}

/**
 * A provider that runs `interceptor.around` around each operation of
 * `provider` taking a context (`ProviderOperation`), for logs, traces or
 * spies. It has the operations `provider` has and no other (`increment`,
 * `migrate`, `transaction` and `close` stay absent when it has none), its
 * `capabilities` (read live) and its other members; the provider a
 * `transaction` gives is wrapped with the same interceptor; `close` is
 * forwarded as it is. Wraps compose: the last one runs first.
 *
 * The wrapper is a plain frozen object (`instanceof` the class of
 * `provider` is false) and the other members are bound when it is made.
 * `around` must give what `next()` gives (or another value of the
 * operation's result, `ProviderResults[operation]`).
 *
 * @example
 * import { inMemoryProvider, wrapProvider } from "@afora/core";
 *
 * const logged = wrapProvider(inMemoryProvider(), {
 *   async around({ operation, context }, next) {
 *     try {
 *       return await next();
 *     } catch (error) {
 *       console.error(`${context.name}.${operation} failed`, error);
 *       throw error;
 *     }
 *   },
 * });
 * @throws {@link InvalidRepositoryDeclaration} when `provider` is not an object or is a provider of `providersOf`, or `interceptor.around` is not a function.
 */
export function wrapProvider<Provider extends IRepositoryProvider>(
	provider: Provider,
	interceptor: ProviderInterceptor<ProviderEnvironmentOf<Provider>>,
): Provider {
	if (typeof provider !== "object" || provider === null)
		throw new InvalidRepositoryDeclaration({
			source: "wrapProvider",
			details: { reason: "Expected a repository provider." },
		});
	if ((provider as { readonly [Kind]?: unknown })[Kind] === "provider-slot")
		throw new InvalidRepositoryDeclaration({
			source: "wrapProvider",
			details: {
				reason:
					"A provider of providersOf cannot be wrapped: wrap the provider before giving it to providersOf, or the one providerFrom's create gives.",
			},
		});
	if (typeof interceptor?.around !== "function")
		throw new InvalidRepositoryDeclaration({
			source: "wrapProvider",
			details: { reason: "Expected an interceptor with an around function." },
		});
	const wrapped: Record<PropertyKey, unknown> = {};
	forwardProvider(wrapped, provider, interceptor);
	Object.freeze(wrapped);
	inheritProviderDescription(provider, wrapped as never);
	return wrapped as unknown as Provider;
}
