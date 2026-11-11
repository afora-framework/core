import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { recordFieldOf } from "../blueprint/record-field";
import { isBlueprintVariant } from "../blueprint/variant";
import { InvalidRepositoryQuery } from "./exceptions";
import type {
	ProviderQuery,
	RepositoryOrder,
	RepositoryQuery,
} from "./types/query.interface";
import type {
	RepositoryContext,
	RepositoryData,
} from "./types/repository.interface";

function plain(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	);
}

function isMembership(
	value: unknown,
): value is { readonly in: readonly unknown[] } {
	return (
		plain(value) && Object.keys(value).length === 1 && Array.isArray(value.in)
	);
}

/** The options of a `RepositoryQuery`. */
const QUERY_OPTIONS = [
	"where",
	"orderBy",
	"limit",
	"offset",
	"withDeleted",
	"withExpired",
];

/** Validates query structure and optionally normalizes domain values for storage. */
export function prepareQuery(
	context: RepositoryContext,
	input: unknown = {},
	map: (key: string, value: unknown) => unknown = (_key, value) => value,
	options: readonly string[] = QUERY_OPTIONS,
): RepositoryQuery {
	const fail = (reason: string): never => {
		throw new InvalidRepositoryQuery({
			source: context.name,
			details: { reason },
		});
	};
	if (!plain(input)) return fail("Expected a query object.");
	for (const key of Object.keys(input))
		if (!options.includes(key)) fail(`Unknown query option "${key}".`);
	const properties = context.entity.blueprint.properties;
	const keyOf = (key: string) => {
		if (!Object.hasOwn(properties, key)) fail(`Unknown query field "${key}".`);
	};
	for (const name of ["limit", "offset"] as const) {
		const value = input[name];
		if (
			value !== undefined &&
			(typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		)
			fail(`Expected a nonnegative integer for ${name}.`);
	}
	if (input.withDeleted !== undefined && typeof input.withDeleted !== "boolean")
		fail("Expected withDeleted to be boolean.");
	if (input.withExpired !== undefined && typeof input.withExpired !== "boolean")
		fail("Expected withExpired to be boolean.");
	let where: Record<string, unknown> | undefined;
	if (input.where !== undefined) {
		if (!plain(input.where)) return fail("Expected where to be an object.");
		where = Object.fromEntries(
			Object.entries(input.where).map(([key, value]) => {
				keyOf(key);
				return [
					key,
					isMembership(value)
						? { in: value.in.map((item) => map(key, item)) }
						: map(key, value),
				];
			}),
		);
	}
	if (input.orderBy !== undefined) {
		if (!Array.isArray(input.orderBy))
			return fail("Expected orderBy to be an array.");
		for (const order of input.orderBy) {
			if (
				!plain(order) ||
				typeof order.key !== "string" ||
				Object.keys(order).some((key) => key !== "key" && key !== "direction")
			)
				return fail("Expected an order with key and optional direction.");
			keyOf(order.key);
			if (
				order.direction !== undefined &&
				order.direction !== "asc" &&
				order.direction !== "desc"
			)
				fail("Expected order direction asc or desc.");
			const field = properties[order.key];
			if (
				isBlueprint(field) ||
				isBlueprintList(field) ||
				isBlueprintVariant(field) ||
				recordFieldOf(field)
			)
				fail("Only scalar fields may be ordered.");
		}
	}
	return { ...input, ...(where ? { where } : {}) } as RepositoryQuery;
}

/** Structural JSON/data equality without depending on object key insertion order. */
export function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a instanceof Date || b instanceof Date)
		return (
			a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
		);
	if (Array.isArray(a) || Array.isArray(b))
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, index) => sameValue(value, b[index]))
		);
	if (!plain(a) || !plain(b)) return false;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
	);
}

/**
 * Whether the date of `value` is at or before `now`; a missing or unreadable
 * date never expires.
 */
function isExpired(value: unknown, now: number): boolean {
	if (value === undefined || value === null) return false;
	const at =
		value instanceof Date
			? value.getTime()
			: typeof value === "string"
				? Date.parse(value)
				: Number.NaN;
	return !Number.isNaN(at) && at <= now;
}

/** The time of `query.now`, or the current one. */
export function nowOf(query: ProviderQuery): number {
	const now = query.now === undefined ? Number.NaN : Date.parse(query.now);
	return Number.isNaN(now) ? Date.now() : now;
}

/**
 * Whether `data` is a row of `query`: alive unless `withDeleted`, not expired
 * by `expiry` (the key of `context.expiry`) unless `withExpired`, and matching
 * `where`.
 */
export function matchesQuery(
	data: RepositoryData,
	query: ProviderQuery,
	expiry?: string,
	now: number = expiry === undefined ? 0 : nowOf(query),
): boolean {
	return (
		(query.withDeleted === true || data.deletedAt === undefined) &&
		(expiry === undefined ||
			query.withExpired === true ||
			!isExpired(data[expiry], now)) &&
		Object.entries(query.where ?? {}).every(([key, value]) =>
			isMembership(value)
				? value.in.some((candidate) => sameValue(data[key], candidate))
				: sameValue(data[key], value),
		)
	);
}

function codePoints(text: string): number[] {
	return Array.from(text, (char) => char.codePointAt(0) as number);
}

function rank(value: unknown): number {
	return value instanceof Date
		? 1
		: ({ number: 0, bigint: 0, string: 2, boolean: 3 }[
				typeof value as string
			] ?? 4);
}

/** Orders two present scalars: numbers numerically, strings by code point. */
function compareScalars(a: unknown, b: unknown): number {
	const [left, right] = [rank(a), rank(b)];
	if (left !== right) return left - right;
	if (typeof a === "string" && typeof b === "string") {
		const [x, y] = [codePoints(a), codePoints(b)];
		for (let index = 0; index < Math.min(x.length, y.length); index++) {
			const difference = (x[index] as number) - (y[index] as number);
			if (difference !== 0) return difference;
		}
		return x.length - y.length;
	}
	const [x, y] = [
		a instanceof Date ? a.getTime() : Number(a),
		b instanceof Date ? b.getTime() : Number(b),
	];
	return x < y ? -1 : x > y ? 1 : 0;
}

/** Where `a` goes relative to `b` in `orders`: missing values first when ascending, last when descending. */
function compareRows(
	orders: readonly RepositoryOrder[],
	a: RepositoryData,
	b: RepositoryData,
): number {
	for (const { key, direction } of orders) {
		const [x, y] = [a[key], b[key]];
		const [missingX, missingY] = [
			x === undefined || x === null,
			y === undefined || y === null,
		];
		let result =
			missingX || missingY
				? Number(!missingX) - Number(!missingY)
				: compareScalars(x, y);
		if (direction === "desc") result = -result;
		if (result !== 0) return result;
	}
	return 0;
}

/** Sorts `rows` by `query.orderBy`; stable. */
function orderRows(
	rows: readonly RepositoryData[],
	query: RepositoryQuery,
): RepositoryData[] {
	const orders = query.orderBy ?? [];
	return [...rows].sort((a, b) => compareRows(orders, a, b));
}

/** The rows that come strictly after the values of `after`, one for each order. */
function rowsAfter(
	rows: readonly RepositoryData[],
	orders: readonly RepositoryOrder[],
	after: readonly unknown[],
): RepositoryData[] {
	const position = Object.fromEntries(
		orders.map(({ key }, index) => [key, after[index]]),
	);
	return rows.filter((row) => compareRows(orders, row, position) > 0);
}

/** The rows of `query` after ordering, `after`, offset and limit. */
export function selectRows(
	rows: Iterable<RepositoryData>,
	query: ProviderQuery,
	expiry?: string,
): RepositoryData[] {
	const now = expiry === undefined ? 0 : nowOf(query);
	const ordered = orderRows(
		[...rows].filter((data) => matchesQuery(data, query, expiry, now)),
		query,
	);
	const matched =
		query.after === undefined
			? ordered
			: rowsAfter(ordered, query.orderBy ?? [], query.after);
	const start = query.offset ?? 0;
	return matched.slice(
		start,
		query.limit === undefined ? undefined : start + query.limit,
	);
}
