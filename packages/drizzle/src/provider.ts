import {
	InvalidRepositoryDeclaration,
	InvalidRepositoryQuery,
	type IRepositoryProvider,
	RepositoryConcurrencyConflict,
	type RepositoryContext,
	type RepositoryData,
	RepositoryEntityNotFound,
	type RepositoryQuery,
	RepositoryUniqueViolation,
} from "@afora/core";
import {
	and,
	type Column,
	eq,
	getTableColumns,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

/** The Drizzle databases the provider supports: SQLite (any driver) and Postgres (any driver). */
// biome-ignore-start lint/suspicious/noExplicitAny: the generics of Drizzle databases are driver specific
export type DrizzleDatabase =
	| BaseSQLiteDatabase<any, any, any, any>
	| PgDatabase<any, any, any>;
// biome-ignore-end lint/suspicious/noExplicitAny: see above

/** A Drizzle table of either dialect. */
// biome-ignore lint/suspicious/noExplicitAny: tables are checked at runtime
export type DrizzleTable = any;

export interface DrizzleProviderOptions {
	/** The Drizzle database, or a transaction of it. */
	readonly db: DrizzleDatabase;
	/**
	 * The table of each repository: keyed by the name of the repository
	 * (`UserRepository`) or, failing that, by the name of the entity (`User`).
	 * Both come from the `name` option of `entityOf` when it has one, and from
	 * the name of the class otherwise, which a minifier changes.
	 */
	readonly tables: Readonly<Record<string, DrizzleTable>>;
}

/** The query builders shared by a database and its transactions. */
// biome-ignore lint/suspicious/noExplicitAny: dialect specific builders
type Executor = any;

const SOURCE = "drizzle";
/** Beyond any table, for the `OFFSET` that SQLite only accepts after a `LIMIT`. */
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

function invalid(reason: string): never {
	throw new InvalidRepositoryDeclaration({
		source: SOURCE,
		details: { reason },
	});
}

function badQuery(reason: string): never {
	throw new InvalidRepositoryQuery({ source: SOURCE, details: { reason } });
}

/** A query with the `after` of `findCursor`, on any version of `@afora/core`. */
type KeysetQuery = RepositoryQuery & { readonly after?: readonly unknown[] };

interface Mapping {
	readonly table: DrizzleTable;
	readonly columns: Readonly<Record<string, Column>>;
	readonly postgres: boolean;
}

const mappings = new WeakMap<object, Mapping>();

/**
 * The declared name of an entity (`recordName`, from the `name` option of
 * `entityOf`), which a bundler does not rename; the name of the class on a
 * version of `@afora/core` without it.
 */
function entityNameOf(entity: object): string {
	const { recordName, name } = entity as {
		readonly recordName?: unknown;
		readonly name: string;
	};
	return typeof recordName === "string" ? recordName : name;
}

function mappingOf(
	tables: DrizzleProviderOptions["tables"],
	context: RepositoryContext,
): Mapping {
	const entity = entityNameOf(context.entity);
	const table = tables[context.name] ?? tables[entity];
	if (!table) {
		return invalid(
			`No Drizzle table for "${context.name}" (or the entity "${entity}"). Tables are found by name: declare it with entityOf(blueprint, { name }) when the code is minified.`,
		);
	}
	let mapping = mappings.get(table);
	if (!mapping) {
		const columns = getTableColumns(table) as Record<string, Column>;
		if (!columns.id)
			invalid(`The table of "${context.name}" has no "id" column.`);
		mapping = {
			table,
			columns,
			postgres: Object.values(columns).some((column) =>
				column.columnType.startsWith("Pg"),
			),
		};
		mappings.set(table, mapping);
	}
	return mapping;
}

function columnOf(mapping: Mapping, key: string): Column {
	const column = mapping.columns[key];
	if (!column) badQuery(`"${key}" is not a column of the table.`);
	return column;
}

const isMissing = (value: unknown): value is null | undefined =>
	value === undefined || value === null;

/** A stored value to what the column takes. */
function toColumn(column: Column, value: unknown): unknown {
	if (isMissing(value)) return null;
	if (column.dataType === "date" && typeof value === "string")
		return new Date(value);
	return value;
}

/** What the column gives to a stored value. */
function fromColumn(value: unknown): unknown {
	return value instanceof Date ? value.toISOString() : value;
}

function dataOf(
	mapping: Mapping,
	data: RepositoryData,
): Record<string, unknown> {
	for (const key of Object.keys(data)) {
		if (data[key] !== undefined && !(key in mapping.columns))
			invalid(`"${key}" has no column in the table.`);
	}
	const row: Record<string, unknown> = {};
	for (const [key, column] of Object.entries(mapping.columns))
		row[key] = toColumn(column, data[key]);
	return row;
}

function dataFromRow(row: Record<string, unknown>): RepositoryData {
	const data: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (!isMissing(value)) data[key] = fromColumn(value);
	}
	return data;
}

const isIn = (condition: unknown): condition is { in: readonly unknown[] } =>
	typeof condition === "object" &&
	condition !== null &&
	!Array.isArray(condition) &&
	Object.keys(condition).length === 1 &&
	Array.isArray((condition as { in?: unknown }).in);

function equality(column: Column, value: unknown): SQL {
	return isMissing(value)
		? isNull(column)
		: eq(column, toColumn(column, value));
}

function conditionOf(column: Column, condition: unknown): SQL {
	if (!isIn(condition)) return equality(column, condition);
	const present = condition.in
		.filter((value) => !isMissing(value))
		.map((value) => toColumn(column, value));
	const parts: SQL[] = [];
	if (present.length > 0) parts.push(inArray(column, present));
	if (present.length < condition.in.length) parts.push(isNull(column));
	return or(...parts) ?? sql`1 = 0`;
}

function whereOf(
	mapping: Mapping,
	query: RepositoryQuery = {},
): SQL | undefined {
	const parts: (SQL | undefined)[] = [];
	for (const [key, condition] of Object.entries(query.where ?? {}))
		parts.push(conditionOf(columnOf(mapping, key), condition));
	const deleted = mapping.columns.deletedAt;
	if (deleted && query.withDeleted !== true) parts.push(isNull(deleted));
	return and(...parts);
}

/** A text column compared bytewise on Postgres, whose default collation is the database's. */
function collate(mapping: Mapping, column: Column): SQL {
	return mapping.postgres && /^Pg(Text|Varchar|Char)/.test(column.columnType)
		? sql`${column} COLLATE "C"`
		: sql`${column}`;
}

/**
 * Ascending puts missing values first and descending last, strings compare by
 * code point (`COLLATE "C"` on Postgres, the binary collation of SQLite) and
 * ties keep insertion order (`rowid` on SQLite; on Postgres, which has no
 * stable physical order, by id, which is insertion order for UUID v7 ids).
 */
function orderOf(mapping: Mapping, query: RepositoryQuery): SQL[] {
	const order: SQL[] = [];
	for (const { key, direction = "asc" } of query.orderBy ?? []) {
		const column = columnOf(mapping, key);
		const collated = collate(mapping, column);
		order.push(
			direction === "desc"
				? sql`${collated} DESC NULLS LAST`
				: sql`${collated} ASC NULLS FIRST`,
		);
	}
	order.push(
		mapping.postgres ? collate(mapping, columnOf(mapping, "id")) : sql`rowid`,
	);
	return order;
}

/** `column` compared with a value by `operator`, strings by code point as in `orderOf`. */
function compare(
	mapping: Mapping,
	column: Column,
	operator: ">" | "<",
	value: unknown,
): SQL {
	const bound = sql.param(toColumn(column, value), column);
	return operator === ">"
		? sql`${collate(mapping, column)} > ${bound}`
		: sql`${collate(mapping, column)} < ${bound}`;
}

/**
 * The rows strictly after the position `query.after` in `query.orderBy`, one
 * value for each order: a row is after it when, for some order, it equals the
 * position on every order before and comes later on that one. A missing value
 * is first when ascending and last when descending, as `orderOf` sorts it.
 */
function keysetOf(mapping: Mapping, query: KeysetQuery): SQL | undefined {
	const { after, orderBy = [] } = query;
	if (after === undefined) return undefined;
	if (after.length !== orderBy.length)
		badQuery("Expected one value of after for each order.");
	const branches: (SQL | undefined)[] = [];
	const equal: SQL[] = [];
	orderBy.forEach(({ key, direction = "asc" }, index) => {
		const column = columnOf(mapping, key);
		const value = after[index];
		let later: SQL | undefined;
		if (direction === "desc") {
			// Missing values are last: nothing comes after one of them.
			later = isMissing(value)
				? undefined
				: or(compare(mapping, column, "<", value), isNull(column));
		} else {
			later = isMissing(value)
				? isNotNull(column)
				: compare(mapping, column, ">", value);
		}
		if (later) branches.push(and(...equal, later));
		equal.push(equality(column, value));
	});
	return or(...branches) ?? sql`1 = 0`;
}

/** Walks the `cause` chain of a driver error for its message and Postgres detail. */
function causesOf(
	error: unknown,
): { message: string; detail: string; code: string }[] {
	const causes: { message: string; detail: string; code: string }[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
		const fields = current as Error & { detail?: unknown; code?: unknown };
		causes.push({
			message: fields.message,
			detail: typeof fields.detail === "string" ? fields.detail : "",
			code: typeof fields.code === "string" ? fields.code : "",
		});
		current = current.cause;
	}
	return causes;
}

/** The key a unique constraint error names, or `undefined` for any other error. */
function violatedKey(error: unknown, mapping: Mapping): string | undefined {
	const names = (column: string) =>
		Object.entries(mapping.columns).find(([, c]) => c.name === column)?.[0] ??
		column;
	for (const { message, detail, code } of causesOf(error)) {
		const sqlite = /UNIQUE constraint failed: ([^\n]+)/.exec(message);
		if (sqlite?.[1]) {
			const [first = ""] = sqlite[1].split(",");
			return names(first.trim().split(".").pop() ?? first);
		}
		if (code === "23505" || /duplicate key value/.test(message)) {
			const postgres = /Key \(([^)]+?)\)=/.exec(detail);
			if (postgres?.[1]) return names(postgres[1].split(",")[0]?.trim() ?? "");
			return "id";
		}
	}
	return undefined;
}

/** One executor (a database or a transaction) as an `IRepositoryProvider`. */
function providerOver(
	tables: DrizzleProviderOptions["tables"],
	exec: Executor,
	hooks: {
		/** Runs every operation of a root provider once no transaction holds it. */
		guard<Result>(work: () => Promise<Result>): Promise<Result>;
		transaction: IRepositoryProvider["transaction"];
	},
): IRepositoryProvider {
	const select = async (
		context: RepositoryContext,
		query: KeysetQuery,
		one: boolean,
	): Promise<RepositoryData[]> => {
		const mapping = mappingOf(tables, context);
		const limit = one ? Math.min(query.limit ?? 1, 1) : query.limit;
		if (limit === 0) return [];
		let builder = exec
			.select()
			.from(mapping.table)
			.where(and(whereOf(mapping, query), keysetOf(mapping, query)))
			.orderBy(...orderOf(mapping, query));
		if (limit !== undefined || query.offset)
			builder = builder.limit(limit ?? NO_LIMIT);
		if (query.offset) builder = builder.offset(query.offset);
		return ((await builder) as Record<string, unknown>[]).map(dataFromRow);
	};

	/** Throws when another row holds a unique value of `data`. */
	const assertUnique = async (
		context: RepositoryContext,
		mapping: Mapping,
		data: RepositoryData,
		own: boolean,
	): Promise<void> => {
		const id = columnOf(mapping, "id");
		for (const key of context.unique) {
			const value = data[key];
			if (isMissing(value) || !(key in mapping.columns)) continue;
			if (own && key === "id") continue;
			const column = columnOf(mapping, key);
			const others = own ? ne(id, data.id as string) : undefined;
			const [found] = await exec
				.select({ id })
				.from(mapping.table)
				.where(and(eq(column, toColumn(column, value)), others))
				.limit(1);
			if (found) {
				throw new RepositoryUniqueViolation({
					source: context.name,
					details: { key },
				});
			}
		}
	};

	const write = async (
		context: RepositoryContext,
		mapping: Mapping,
		work: () => Promise<unknown>,
	) => {
		try {
			return await work();
		} catch (error) {
			const key = violatedKey(error, mapping);
			if (key === undefined) throw error;
			throw new RepositoryUniqueViolation({
				source: context.name,
				details: { key },
			});
		}
	};

	const notFound = (context: RepositoryContext, id: string) =>
		new RepositoryEntityNotFound({ source: context.name, details: { id } });

	/** The `version` column, which an expected version needs. */
	const versionOf = (context: RepositoryContext, mapping: Mapping): Column =>
		mapping.columns.version ??
		invalid(
			`The table of "${context.name}" has no "version" column, which a versioned entity needs.`,
		);

	/** What `increment` sets: each delta added to its column, and `set` as it is. */
	const incrementOf = (
		context: RepositoryContext,
		mapping: Mapping,
		deltas: Readonly<Record<string, number>>,
		set: RepositoryData = {},
	): Record<string, unknown> => {
		const changes: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(set)) {
			if (value === undefined) continue;
			const column = mapping.columns[key];
			if (!column) invalid(`"${key}" has no column in the table.`);
			changes[key] = toColumn(column, value);
		}
		for (const [key, delta] of Object.entries(deltas)) {
			const column = mapping.columns[key];
			if (!column)
				invalid(`"${key}" has no column in the table of "${context.name}".`);
			changes[key] = sql`coalesce(${column}, 0) + ${delta}`;
		}
		return changes;
	};

	return {
		capabilities: Object.freeze({
			transactions: true,
			keyset: true,
			versioning: true,
			atomic: true,
		}),
		findOne: (context, query = {}) =>
			hooks.guard(async () => (await select(context, query, true))[0]),
		findMany: (context, query = {}) =>
			hooks.guard(() => select(context, query, false)),
		count: (context, query = {}) =>
			hooks.guard(async () => {
				const mapping = mappingOf(tables, context);
				const [found] = await exec
					.select({ total: sql<number>`count(*)` })
					.from(mapping.table)
					.where(whereOf(mapping, { ...query, limit: undefined }));
				return Number(found?.total ?? 0);
			}),
		insert: (context, data) =>
			hooks.guard(async () => {
				const mapping = mappingOf(tables, context);
				const row = dataOf(mapping, data);
				await assertUnique(context, mapping, data, false);
				await write(context, mapping, () =>
					exec.insert(mapping.table).values(row),
				);
			}),
		update: (context, data, options = {}) =>
			hooks.guard(async () => {
				const mapping = mappingOf(tables, context);
				const row = dataOf(mapping, data);
				const id = columnOf(mapping, "id");
				const { expectedVersion: expected } = options;
				const version =
					expected === undefined ? undefined : versionOf(context, mapping);
				const [existing] = await exec
					.select({ id })
					.from(mapping.table)
					.where(eq(id, data.id as string))
					.limit(1);
				if (!existing) throw notFound(context, data.id as string);
				await assertUnique(context, mapping, data, true);
				const updated = (await write(context, mapping, () =>
					exec
						.update(mapping.table)
						.set(row)
						.where(
							and(
								eq(id, data.id as string),
								version === undefined ? undefined : eq(version, expected),
							),
						)
						.returning({ id }),
				)) as unknown[];
				if (version === undefined || updated.length > 0) return;
				// The version checked in the same statement: another write came first.
				const [stored] = await exec
					.select({ version })
					.from(mapping.table)
					.where(eq(id, data.id as string))
					.limit(1);
				if (!stored) throw notFound(context, data.id as string);
				throw new RepositoryConcurrencyConflict({
					source: context.name,
					details: {
						id: data.id as string,
						expected: expected as number,
						...(typeof stored.version === "number"
							? { actual: stored.version }
							: {}),
					},
				});
			}),
		increment: (context, id, deltas, options = {}) =>
			hooks.guard(async () => {
				const mapping = mappingOf(tables, context);
				const idColumn = columnOf(mapping, "id");
				const changes = incrementOf(context, mapping, deltas, options.set);
				const deleted = mapping.columns.deletedAt;
				const alive = deleted ? isNull(deleted) : undefined;
				if (options.create === undefined) {
					const [updated] = (await write(context, mapping, () =>
						exec
							.update(mapping.table)
							.set(changes)
							.where(and(eq(idColumn, id), alive))
							.returning(),
					)) as Record<string, unknown>[];
					if (!updated) throw notFound(context, id);
					return dataFromRow(updated);
				}
				// One statement: inserted, or incremented when a row holds the id.
				const row = dataOf(mapping, { ...options.create, id });
				const [stored] = (await write(context, mapping, () =>
					exec
						.insert(mapping.table)
						.values(row)
						.onConflictDoUpdate({
							target: idColumn,
							set: changes,
							...(alive ? { setWhere: alive } : {}),
						})
						.returning(),
				)) as Record<string, unknown>[];
				// A soft-deleted row keeps its id, as an insert finds.
				if (!stored) {
					throw new RepositoryUniqueViolation({
						source: context.name,
						details: { key: "id" },
					});
				}
				return dataFromRow(stored);
			}),
		remove: (context, id) =>
			hooks.guard(async () => {
				const mapping = mappingOf(tables, context);
				const column = columnOf(mapping, "id");
				const removed = await exec
					.delete(mapping.table)
					.where(eq(column, id))
					.returning({ id: column });
				if (removed.length === 0) throw notFound(context, id);
			}),
		transaction: hooks.transaction,
	};
}

/** Wraps a provider so that it fails once `alive()` is false. */
function whileAlive(alive: () => boolean) {
	return async <Result>(work: () => Promise<Result>): Promise<Result> => {
		if (!alive())
			invalid("The transaction has ended; its provider cannot be used.");
		return work();
	};
}

let savepoints = 0;

/** Transactions of a scope over a SQL executor, as `db.transaction` runs them. */
function nestedTransactions(
	tables: DrizzleProviderOptions["tables"],
	exec: Executor,
): IRepositoryProvider["transaction"] {
	return <Result>(run: (provider: IRepositoryProvider) => Promise<Result>) =>
		exec.transaction(async (tx: Executor) => {
			let alive = true;
			try {
				return await run(scoped(tables, tx, () => alive));
			} finally {
				alive = false;
			}
		}) as Promise<Result>;
}

function scoped(
	tables: DrizzleProviderOptions["tables"],
	tx: Executor,
	alive: () => boolean,
): IRepositoryProvider {
	return providerOver(tables, tx, {
		guard: whileAlive(alive),
		transaction: nestedTransactions(tables, tx),
	});
}

/**
 * Synchronous SQLite drivers (`bun:sqlite`, `better-sqlite3`) run the callback
 * of `db.transaction` to its first `await`, so the transactions of such a
 * database are driven by hand with `BEGIN` and `SAVEPOINT`, and one at a time:
 * the other operations wait for it, as the database has a single connection.
 */
function manualScope(
	tables: DrizzleProviderOptions["tables"],
	db: Executor,
	root: { held: Promise<void> | undefined } | undefined,
	alive: () => boolean,
): IRepositoryProvider {
	const state = root ?? { held: undefined };
	const guard = async <Result>(
		work: () => Promise<Result>,
	): Promise<Result> => {
		if (!alive())
			invalid("The transaction has ended; its provider cannot be used.");
		if (root === undefined) while (state.held) await state.held;
		return work();
	};
	return providerOver(tables, db, {
		guard,
		async transaction<Result>(
			run: (provider: IRepositoryProvider) => Promise<Result>,
		) {
			if (root === undefined) while (state.held) await state.held;
			if (!alive())
				invalid("The transaction has ended; its provider cannot be used.");
			let release: () => void = () => {};
			if (root === undefined) {
				state.held = new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			const name = `afora_sp_${++savepoints}`;
			await db.run(
				root === undefined ? sql`BEGIN` : sql.raw(`SAVEPOINT ${name}`),
			);
			let open = true;
			try {
				const result = await run(
					manualScope(tables, db, state, () => open && alive()),
				);
				open = false;
				await db.run(
					root === undefined ? sql`COMMIT` : sql.raw(`RELEASE ${name}`),
				);
				return result;
			} catch (error) {
				open = false;
				if (root === undefined) await db.run(sql`ROLLBACK`);
				else {
					await db.run(sql.raw(`ROLLBACK TO ${name}`));
					await db.run(sql.raw(`RELEASE ${name}`));
				}
				throw error;
			} finally {
				open = false;
				if (root === undefined) {
					state.held = undefined;
					release();
				}
			}
		},
	});
}

function isSyncSqlite(db: Executor): boolean {
	return db.resultKind === "sync";
}

/**
 * A repository provider over a Drizzle database (SQLite or Postgres) and the
 * table of each repository. See the package README for the mapping rules.
 *
 * The provider is not made with `providerOf`: its `db` and `tables` are not
 * JSON, so it is an opaque provider, and extracting an application that uses
 * it needs an import mapping (`provider` / `repositories.<Name>.provider`) that
 * generates `drizzleProvider({ db, tables })`.
 */
export function drizzleProvider(
	options: DrizzleProviderOptions,
): IRepositoryProvider {
	if (
		!options ||
		typeof options !== "object" ||
		!options.db ||
		typeof options.tables !== "object" ||
		options.tables === null
	)
		invalid("Expected { db, tables } with a Drizzle database and its tables.");
	const { db, tables } = options;
	const alwaysAlive = () => true;
	if (isSyncSqlite(db)) return manualScope(tables, db, undefined, alwaysAlive);
	return providerOver(tables, db, {
		guard: (work) => work(),
		transaction: nestedTransactions(tables, db),
	});
}
