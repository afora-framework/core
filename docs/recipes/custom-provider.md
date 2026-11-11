# A custom provider

Your data lives somewhere afora has no provider for, or you want to wrap one, to count, cache or log what the repositories ask of it.

```ts
import { inMemoryProvider, providerOf } from "@afora/core";
import type { IRepositoryProvider } from "@afora/core/adapters";

// A provider is an object with six methods. This one wraps another and counts
// the calls; a real one would turn each method into a query of its store.
export function countingProvider(
	inner: IRepositoryProvider = inMemoryProvider(),
) {
	const calls: Record<string, number> = {};
	const seen =
		<Args extends unknown[], Result>(
			name: string,
			run: (...args: Args) => Result,
		) =>
		(...args: Args): Result => {
			calls[name] = (calls[name] ?? 0) + 1;
			return run(...args);
		};
	const provider = providerOf({
		name: "counting",
		options: {},
		create: (): IRepositoryProvider => ({
			...inner, // capabilities, increment, transaction, close: as the store has them
			findOne: seen("findOne", (...args) => inner.findOne(...args)),
			findMany: seen("findMany", (...args) => inner.findMany(...args)),
			insert: seen("insert", (...args) => inner.insert(...args)),
			update: seen("update", (...args) => inner.update(...args)),
			remove: seen("remove", (...args) => inner.remove(...args)),
			count: seen("count", (...args) => inner.count(...args)),
		}),
	});
	return { provider, calls };
}
```

A provider is an object with `findOne`, `findMany`, `insert`, `update`, `remove` and `count`, each called with the `context` of the repository (its entity, `unique` keys, name) and the query; `capabilities` says what else it does (`transactions`, `keyset`, `indexes`, `versioning`, `atomic`, `expiry`). `providerOf` gives it a name and JSON options, so the application can describe it.

This one delegates to `inMemoryProvider()`. A real provider turns each method into a query of its store, throws `RepositoryUniqueViolation` for a unique key already held and `RepositoryEntityNotFound` for an unknown id on `update` and `remove`, and keeps one table per `recordNameOf(context.entity)`. To check it, run `providerContract` of `@afora/core/testing` against it, as `recipes.test.ts` does for this one.

More: [Repositories](../repositories.md) (the provider interface, testing a provider), [Testing](../testing.md), [API tiers](../api-tiers.md).
