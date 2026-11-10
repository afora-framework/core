import type {
	RepositoryIndex,
	RepositoryOrder,
	RepositoryPlan,
} from "./types/query.interface";

/** What the planner reads of a query: its conditions and its orders. */
export interface PlannedQuery {
	readonly where?: Readonly<Record<string, unknown>>;
	readonly orderBy?: readonly RepositoryOrder[];
}

/** What the planner reads of a repository: its unique keys and its indexes. */
export interface PlannedRepository {
	readonly unique: readonly string[];
	readonly indexes?: Readonly<Record<string, RepositoryIndex>>;
}

const ID: RepositoryPlan = Object.freeze({ access: "id" });
const UNIQUE: RepositoryPlan = Object.freeze({ access: "unique" });
const SCAN: RepositoryPlan = Object.freeze({ access: "scan" });

function isMembership(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === 1 &&
		Array.isArray((value as { in?: unknown }).in)
	);
}

/**
 * How `query` reaches its rows. A condition on `id`, or on another unique
 * key, by equality or `in` (a batch of key lookups) gives `id` or `unique`.
 * An index whose `where` keys all hold a condition by equality, and whose
 * `orderBy` is the first order of the query (when it has one), gives
 * `index`: the one with the most keys, the first declared on a tie. The rest
 * is a `scan`. It reads nothing, and expects a query `prepareQuery` checked.
 */
export function planQuery(
	repository: PlannedRepository,
	query: PlannedQuery = {},
): RepositoryPlan {
	const where = query.where ?? {};
	const keys = Object.keys(where);
	if (keys.includes("id")) return ID;
	if (keys.some((key) => repository.unique.includes(key))) return UNIQUE;
	const equal = new Set(keys.filter((key) => !isMembership(where[key])));
	const first = query.orderBy?.[0]?.key;
	let best: [string, RepositoryIndex] | undefined;
	for (const entry of Object.entries(repository.indexes ?? {})) {
		const [, index] = entry;
		if (!index.where.every((key) => equal.has(key))) continue;
		if (first !== undefined && index.orderBy !== first) continue;
		if (best === undefined || index.where.length > best[1].where.length)
			best = entry;
	}
	return best === undefined
		? SCAN
		: Object.freeze({ access: "index", index: best[0] });
}
