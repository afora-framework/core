import { describe, expect, it } from "bun:test";
import type {
	IRepositoryProvider,
	RepositoryContext,
	RepositoryData,
	RepositoryQuery,
} from "../index";
import {
	inMemoryProvider,
	RepositoryEntityNotFound,
	RepositoryUniqueViolation,
} from "../index";
import { providerContract } from "./provider-contract";

type Tables = Map<object, RepositoryData[]>;

const clone = <T>(value: T): T => structuredClone(value);
const missing = (value: unknown) => value === undefined || value === null;

function compare(a: unknown, b: unknown): number {
	if (typeof a === "string" && typeof b === "string") {
		const [x, y] = [[...a], [...b]];
		for (let i = 0; i < Math.min(x.length, y.length); i++) {
			const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
			if (d !== 0) return d;
		}
		return x.length - y.length;
	}
	return (a as number) - (b as number);
}

function select(
	rows: readonly RepositoryData[],
	query: RepositoryQuery = {},
	paginate = true,
): RepositoryData[] {
	let result = rows.filter((data) => {
		if (!query.withDeleted && data.deletedAt !== undefined) return false;
		return Object.entries(query.where ?? {}).every(([key, condition]) => {
			const isIn =
				typeof condition === "object" &&
				condition !== null &&
				Object.keys(condition).length === 1 &&
				Array.isArray((condition as { in?: unknown }).in);
			const matches = (value: unknown) =>
				JSON.stringify(data[key]) === JSON.stringify(value);
			return isIn
				? (condition as unknown as { in: unknown[] }).in.some(matches)
				: matches(condition);
		});
	});
	if (!paginate) return result;
	for (const { key, direction = "asc" } of [
		...(query.orderBy ?? []),
	].reverse()) {
		const sign = direction === "asc" ? 1 : -1;
		result = result
			.map((data, index) => ({ data, index }))
			.sort((a, b) => {
				const [x, y] = [a.data[key], b.data[key]];
				const d = missing(x)
					? missing(y)
						? 0
						: -1
					: missing(y)
						? 1
						: compare(x, y);
				return d * sign || a.index - b.index;
			})
			.map(({ data }) => data);
	}
	const offset = query.offset ?? 0;
	return result.slice(
		offset,
		query.limit === undefined ? undefined : offset + query.limit,
	);
}

/** Array-based reference provider, correct per docs/plans/T09-design.md. */
function referenceProvider(): IRepositoryProvider {
	let committed: Tables = new Map();
	let queue: Promise<unknown> = Promise.resolve();

	const scope = (
		get: () => Tables,
		set: (tables: Tables) => void,
		wrap: <R>(run: () => Promise<R>) => Promise<R>,
		alive: () => boolean,
	): IRepositoryProvider => {
		const rowsOf = (context: RepositoryContext) => {
			if (!alive()) throw new Error("transaction scope used after it ended");
			const tables = get();
			let rows = tables.get(context.entity);
			if (!rows) {
				rows = [];
				tables.set(context.entity, rows);
			}
			return rows;
		};
		const checkUnique = (context: RepositoryContext, data: RepositoryData) => {
			for (const stored of rowsOf(context)) {
				if (stored.id === data.id) continue;
				const key = context.unique.find(
					(k) =>
						data[k] !== undefined &&
						JSON.stringify(stored[k]) === JSON.stringify(data[k]),
				);
				if (key !== undefined) {
					throw new RepositoryUniqueViolation({
						source: context.name,
						details: { key },
					});
				}
			}
		};
		const notFound = (context: RepositoryContext, id: string) =>
			new RepositoryEntityNotFound({ source: context.name, details: { id } });
		const read = <R>(run: () => R) => wrap(async () => run());
		return {
			capabilities: { transactions: true },
			findOne: (context, query) =>
				read(() => {
					const found = select(rowsOf(context), query)[0];
					return found && clone(found);
				}),
			findMany: (context, query) =>
				read(() => select(rowsOf(context), query).map(clone)),
			count: (context, query) =>
				read(() => select(rowsOf(context), query, false).length),
			insert: (context, data) =>
				read(() => {
					if (rowsOf(context).some((r) => r.id === data.id)) {
						throw new RepositoryUniqueViolation({
							source: context.name,
							details: { key: "id" },
						});
					}
					checkUnique(context, data);
					rowsOf(context).push(clone(data));
				}),
			update: (context, data) =>
				read(() => {
					const rows = rowsOf(context);
					const index = rows.findIndex((r) => r.id === data.id);
					if (index < 0) throw notFound(context, data.id as string);
					checkUnique(context, data);
					rows[index] = clone(data);
				}),
			remove: (context, id) =>
				read(() => {
					const rows = rowsOf(context);
					const index = rows.findIndex((r) => r.id === id);
					if (index < 0) throw notFound(context, id);
					rows.splice(index, 1);
				}),
			// Snapshot of the tables, swapped back in only on success.
			transaction: <R>(run: (provider: IRepositoryProvider) => Promise<R>) =>
				wrap(async () => {
					const snapshot: Tables = new Map(
						[...get()].map(([entity, rows]) => [entity, clone(rows)]),
					);
					let open = true;
					let working = snapshot;
					const inner = scope(
						() => working,
						(tables) => {
							working = tables;
						},
						(task) => task(),
						() => open,
					);
					try {
						const result = await run(inner);
						set(working);
						return result;
					} finally {
						open = false;
					}
				}),
		};
	};

	// Root operations queue behind each other, and so behind a transaction.
	const root = scope(
		() => committed,
		(tables) => {
			committed = tables;
		},
		(task) => {
			const next = queue.then(task, task);
			queue = next.catch(() => {});
			return next;
		},
		() => true,
	);
	return root;
}

providerContract({ describe, it, expect }, referenceProvider);
describe("inMemoryProvider", () => {
	// It ignores indexes, so an indexed query answers as the scan does.
	providerContract({ describe, it, expect }, () => inMemoryProvider(), {
		indexes: true,
	});
});

describe("providerContract options", () => {
	it("skips the transaction cases when told to", () => {
		const calls: string[] = [];
		providerContract(
			{
				describe: (name, body) => {
					calls.push(name);
					body();
				},
				it: () => {},
				expect,
			},
			referenceProvider,
			{ transactions: false },
		);
		expect(calls).toContain("provider contract");
	});
});
