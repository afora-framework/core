import {
	InvalidRepositoryDeclaration,
	RepositoryConcurrencyConflict,
	RepositoryEntityNotFound,
	RepositoryUniqueViolation,
} from "./exceptions";
import { providerOf } from "./provider";
import { matchesQuery, nowOf, sameValue, selectRows } from "./query";
import type {
	IRepositoryProvider,
	RepositoryContext,
	RepositoryData,
} from "./types/repository.interface";

type Table = Map<string, RepositoryData>;
type Tables = Map<object, Table>;

/** The id of a stored value. */
function idOf(data: RepositoryData): string {
	return data.id as string;
}

/** Stored rows are private and replaced, never mutated, so copying the maps isolates a snapshot. */
function snapshotOf(tables: Tables): Tables {
	return new Map([...tables].map(([key, table]) => [key, new Map(table)]));
}

const copy = (data: RepositoryData): RepositoryData => structuredClone(data);

/** A scope over `initial`: the provider, and how to end it. */
function scopeOf(initial: Tables, root: boolean) {
	let tables = initial;
	let held: Promise<void> | undefined;
	let closed = false;

	const tableOf = (context: RepositoryContext): Table => {
		let table = tables.get(context.entity);
		if (!table) {
			table = new Map();
			tables.set(context.entity, table);
		}
		return table;
	};

	/** Runs `work` once no transaction of this scope is active, with no gap in between. */
	const whenIdle = async <Result>(work: () => Result): Promise<Result> => {
		while (held) await held;
		if (closed) {
			throw new InvalidRepositoryDeclaration({
				source: "inMemory",
				details: {
					reason: "The transaction has ended; its provider cannot be used.",
				},
			});
		}
		return work();
	};

	const assertUnique = (
		context: RepositoryContext,
		data: RepositoryData,
	): void => {
		for (const stored of tableOf(context).values()) {
			if (idOf(stored) === idOf(data)) continue;
			const key = context.unique.find(
				(key) => data[key] !== undefined && sameValue(stored[key], data[key]),
			);
			if (key !== undefined) {
				throw new RepositoryUniqueViolation({
					source: context.name,
					details: { key },
				});
			}
		}
	};

	const provider: IRepositoryProvider = {
		capabilities: Object.freeze({
			transactions: true,
			keyset: true,
			versioning: true,
			atomic: true,
			expiry: true,
		}),
		findOne: (context, query = {}) =>
			whenIdle(() => {
				const [first] = selectRows(
					tableOf(context).values(),
					{ ...query, limit: Math.min(query.limit ?? 1, 1) },
					context.expiry?.key,
				);
				return first === undefined ? undefined : copy(first);
			}),
		findMany: (context, query = {}) =>
			whenIdle(() =>
				selectRows(tableOf(context).values(), query, context.expiry?.key).map(
					copy,
				),
			),
		insert: (context, data) =>
			whenIdle(() => {
				const table = tableOf(context);
				if (table.has(idOf(data))) {
					throw new RepositoryUniqueViolation({
						source: context.name,
						details: { key: "id" },
					});
				}
				assertUnique(context, data);
				table.set(idOf(data), copy(data));
			}),
		update: (context, data, options = {}) =>
			whenIdle(() => {
				const table = tableOf(context);
				const stored = table.get(idOf(data));
				if (!stored) {
					throw new RepositoryEntityNotFound({
						source: context.name,
						details: { id: idOf(data) },
					});
				}
				const { expectedVersion: expected } = options;
				if (expected !== undefined && stored.version !== expected) {
					throw new RepositoryConcurrencyConflict({
						source: context.name,
						details: {
							id: idOf(data),
							expected,
							...(typeof stored.version === "number"
								? { actual: stored.version }
								: {}),
						},
					});
				}
				assertUnique(context, data);
				table.set(idOf(data), copy(data));
			}),
		increment: (context, id, deltas, options = {}) =>
			whenIdle(() => {
				const table = tableOf(context);
				const found = table.get(id);
				const expiry = context.expiry?.key;
				// An expired row is gone: created again, or not found.
				const expired =
					found !== undefined &&
					expiry !== undefined &&
					!matchesQuery(found, { withDeleted: true, now: options.now }, expiry);
				const stored = expired ? undefined : found;
				if (!stored || stored.deletedAt != null) {
					if (!options.create) {
						throw new RepositoryEntityNotFound({
							source: context.name,
							details: { id },
						});
					}
					// A soft-deleted row keeps its id, as an insert finds.
					if (stored) {
						throw new RepositoryUniqueViolation({
							source: context.name,
							details: { key: "id" },
						});
					}
					const created = { ...options.create, id };
					assertUnique(context, created);
					// Replaces an expired row.
					table.set(id, copy(created));
					return copy(created);
				}
				const next: Record<string, unknown> = { ...stored, ...options.set };
				for (const [key, delta] of Object.entries(deltas)) {
					const value = stored[key];
					next[key] = (typeof value === "number" ? value : 0) + delta;
				}
				table.set(id, copy(next));
				return copy(next);
			}),
		remove: (context, id) =>
			whenIdle(() => {
				if (!tableOf(context).delete(id)) {
					throw new RepositoryEntityNotFound({
						source: context.name,
						details: { id },
					});
				}
			}),
		count: (context, query = {}) =>
			whenIdle(() => {
				const expiry = context.expiry?.key;
				const now = expiry === undefined ? 0 : nowOf(query);
				let total = 0;
				for (const data of tableOf(context).values()) {
					if (matchesQuery(data, query, expiry, now)) total++;
				}
				return total;
			}),
		async transaction(run) {
			let release!: () => void;
			const child = await whenIdle(() => {
				held = new Promise<void>((resolve) => {
					release = resolve;
				});
				return scopeOf(snapshotOf(tables), false);
			});
			try {
				const result = await run(child.provider);
				tables = child.close();
				return result;
			} finally {
				child.close();
				held = undefined;
				release();
			}
		},
	};

	return {
		provider,
		/** Ends the scope, giving back what it holds. */
		close() {
			if (!root) closed = true;
			return tables;
		},
	};
}

/**
 * A provider that keeps the values in memory, one table per entity class,
 * enforcing its unique keys. Each `repositoryOf` without a provider gets its
 * own; repositories given the same one share the tables of their entities.
 * Its `transaction` works on isolated snapshots: commits on success, discards
 * on rejection, runs one at a time and makes other operations wait; nested
 * transactions are savepoints.
 */
export function inMemoryProvider(): IRepositoryProvider {
	return providerOf({
		name: "inMemory",
		options: {},
		create: () => scopeOf(new Map(), true).provider,
	});
}
