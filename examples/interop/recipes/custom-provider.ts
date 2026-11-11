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
