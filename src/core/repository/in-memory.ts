import {
	RepositoryEntityNotFound,
	RepositoryUniqueViolation,
} from "./exceptions";
import type {
	IRepositoryProvider,
	RepositoryContext,
	RepositoryData,
} from "./types/repository.interface";

/** Whether two stored values are the same, plain objects and lists by content. */
function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	return (
		typeof a === "object" &&
		typeof b === "object" &&
		a !== null &&
		b !== null &&
		JSON.stringify(a) === JSON.stringify(b)
	);
}

/** The id of a stored value. */
function idOf(data: RepositoryData): string {
	return data.id as string;
}

/**
 * A provider that keeps the values in memory, one table per entity class,
 * enforcing its unique keys. Each `repositoryOf` without a provider gets its
 * own; repositories given the same one share the tables of their entities.
 */
export function inMemoryProvider(): IRepositoryProvider {
	const tables = new WeakMap<object, Map<string, RepositoryData>>();

	const tableOf = (context: RepositoryContext): Map<string, RepositoryData> => {
		let table = tables.get(context.entity);
		if (!table) {
			table = new Map();
			tables.set(context.entity, table);
		}
		return table;
	};

	const assertUnique = (
		context: RepositoryContext,
		data: RepositoryData,
	): void => {
		for (const stored of tableOf(context).values()) {
			if (idOf(stored) === idOf(data)) continue;
			const key = context.unique.find(
				(key) => data[key] !== undefined && same(stored[key], data[key]),
			);
			if (key !== undefined) {
				throw new RepositoryUniqueViolation({
					source: context.name,
					details: { key },
				});
			}
		}
	};

	return Object.freeze({
		async findOne(context, key, value) {
			for (const data of tableOf(context).values()) {
				if (same(data[key], value)) return data;
			}
			return undefined;
		},
		async findMany(context, key, value) {
			return [...tableOf(context).values()].filter((data) =>
				same(data[key], value),
			);
		},
		async findIn(context, key, values) {
			return [...tableOf(context).values()].filter((data) =>
				values.some((value) => same(data[key], value)),
			);
		},
		async insert(context, data) {
			const table = tableOf(context);
			if (table.has(idOf(data))) {
				throw new RepositoryUniqueViolation({
					source: context.name,
					details: { key: "id" },
				});
			}
			assertUnique(context, data);
			table.set(idOf(data), data);
		},
		async update(context, data) {
			const table = tableOf(context);
			if (!table.has(idOf(data))) {
				throw new RepositoryEntityNotFound({
					source: context.name,
					details: { id: idOf(data) },
				});
			}
			assertUnique(context, data);
			table.set(idOf(data), data);
		},
		async remove(context, id) {
			if (!tableOf(context).delete(id)) {
				throw new RepositoryEntityNotFound({
					source: context.name,
					details: { id },
				});
			}
		},
		async count(context) {
			return tableOf(context).size;
		},
	} satisfies IRepositoryProvider);
}
