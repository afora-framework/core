import { recordNameOf } from "../core/record/name";
import { InvalidRepositoryDeclaration } from "../core/repository/exceptions";
import { inheritProviderDescription } from "../core/repository/provider";
import type {
	AnyRepositoryEntity,
	IRepositoryProvider,
} from "../core/repository/types/repository.interface";
import type {
	ProviderInterceptor,
	ProviderOperation,
} from "../core/repository/types/wrap.interface";
import { forwardProvider } from "../core/repository/wrap";
import { Kind } from "../core/symbols/kind";

/** One call a `spyProvider` recorded. */
export interface SpiedCall {
	/** The operation of the provider, as `wrapProvider` names it. */
	readonly operation: ProviderOperation;
	/** The name of the entity, `recordNameOf(context.entity)`. */
	readonly entity: string;
	/** The arguments after the context. */
	readonly args: readonly unknown[];
}

/** The members `spyProvider` adds to the provider it wraps. */
export interface ProviderSpy {
	/**
	 * The calls recorded since the spy was made or reset, in order (those of
	 * a transaction too, and the ones `fail` rejected), for `entity` (its
	 * name or its class) and `operation` when given.
	 */
	calls(
		entity?: string | AnyRepositoryEntity,
		operation?: ProviderOperation,
	): readonly SpiedCall[];
	/**
	 * Makes `operation` of `entity` reject with `error` instead of calling
	 * the provider: the next `times` calls, or every call until `reset`.
	 * The latest `fail` for an operation replaces the previous one. Throws
	 * `InvalidRepositoryDeclaration` when `times` is not a positive integer
	 * or the provider has no `operation`.
	 */
	fail(
		entity: string | AnyRepositoryEntity,
		operation: ProviderOperation,
		error: unknown,
		options?: { readonly times?: number },
	): void;
	/** Forgets the calls and the failures. */
	reset(): void;
}

const nameOf = (entity: string | AnyRepositoryEntity): string =>
	typeof entity === "string" ? entity : recordNameOf(entity);

/**
 * A provider for tests that forwards to `provider` and records each call
 * of an operation taking a context (`{ operation, entity, args }`, read
 * with `calls`), and can make one fail (`fail`). It is the provider itself
 * (the same type, with the members of `ProviderSpy`), so it goes where a
 * provider goes: `applicationOf({ provider })` or `repositoryOf({ provider })`.
 * Repositories are frozen, so this is how a test sees what reaches the
 * database, also behind an HTTP sink. Built on `wrapProvider`.
 *
 * @example
 * import { inMemoryProvider } from "@afora/core";
 * import { spyProvider } from "@afora/core/testing";
 *
 * const spy = spyProvider(inMemoryProvider());
 * // applicationOf({ ..., provider: spy }), then a request
 * const reads = spy.calls("Project", "findMany").length;
 * spy.fail("Setting", "count", new Error("down"), { times: 1 });
 * @throws {@link InvalidRepositoryDeclaration} when `provider` is not an object, is a provider of `providersOf`, or has its own `calls`, `fail` or `reset`.
 */
export function spyProvider<Provider extends IRepositoryProvider>(
	provider: Provider,
): Provider & ProviderSpy {
	if (
		typeof provider !== "object" ||
		provider === null ||
		(provider as { readonly [Kind]?: unknown })[Kind] === "provider-slot"
	)
		throw new InvalidRepositoryDeclaration({
			source: "spyProvider",
			details: {
				reason:
					"Expected a repository provider (not a provider of providersOf).",
			},
		});
	for (const member of ["calls", "fail", "reset"])
		if (member in provider)
			throw new InvalidRepositoryDeclaration({
				source: "spyProvider",
				details: {
					reason: `The provider already has a \`${member}\` member, which the spy would hide.`,
				},
			});
	const recorded: SpiedCall[] = [];
	const failures = new Map<string, { error: unknown; left: number }>();
	const keyOf = (entity: string, operation: string) =>
		`${entity}\u0000${operation}`;

	const interceptor: ProviderInterceptor<unknown> = {
		async around(call, next) {
			const entity = recordNameOf(call.context.entity);
			recorded.push(
				Object.freeze({
					operation: call.operation,
					entity,
					args: call.args as readonly unknown[],
				}),
			);
			const key = keyOf(entity, call.operation);
			const failure = failures.get(key);
			if (failure) {
				failure.left -= 1;
				if (failure.left <= 0) failures.delete(key);
				throw failure.error;
			}
			return next();
		},
	};

	const spy: ProviderSpy = {
		calls(entity, operation) {
			const name = entity === undefined ? undefined : nameOf(entity);
			return recorded.filter(
				(call) =>
					(name === undefined || call.entity === name) &&
					(operation === undefined || call.operation === operation),
			);
		},
		fail(entity, operation, error, options = {}) {
			const { times = Number.POSITIVE_INFINITY } = options;
			if (
				!(
					times === Number.POSITIVE_INFINITY ||
					(Number.isInteger(times) && times > 0)
				)
			)
				throw new InvalidRepositoryDeclaration({
					source: "spyProvider",
					details: {
						reason: "Expected `times` to be a positive integer.",
					},
				});
			if (
				typeof (provider as unknown as Record<string, unknown>)[operation] !==
				"function"
			)
				throw new InvalidRepositoryDeclaration({
					source: "spyProvider",
					details: {
						reason: `The provider has no \`${operation}\` operation, so it is never called.`,
					},
				});
			failures.set(keyOf(nameOf(entity), operation), { error, left: times });
		},
		reset() {
			recorded.length = 0;
			failures.clear();
		},
	};
	const target = { ...spy } as Record<PropertyKey, unknown>;
	forwardProvider(target, provider, interceptor as never);
	Object.freeze(target);
	inheritProviderDescription(provider, target as never);
	return target as unknown as Provider & ProviderSpy;
}
