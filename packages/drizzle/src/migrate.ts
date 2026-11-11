import {
	InvalidRepositoryDeclaration,
	type RepositoryContext,
} from "@afora/core";
import { type Column, getTableColumns, getTableName, sql } from "drizzle-orm";
import {
	type DrizzleProviderOptions,
	type Settings,
	tableOf,
	versionPropertyOf,
} from "./provider";

/**
 * The part of a `SchemaPlan` of `@afora/core` the provider reads, written out
 * so the package keeps building against versions of the core without it.
 */
export interface MigrationPlan {
	readonly entity: string;
	readonly changes: readonly {
		readonly key?: string;
		readonly change: string;
		readonly from?: string;
	}[];
	readonly destructive: boolean;
}

/**
 * What `migrate` gives `app.migrate`: `{ deferred: true }` when the DDL was
 * not run on the database (written to a file), so the backfill waits for it.
 * Written out like `MigrationPlan`, for versions of the core without it.
 */
export type MigrationResult = undefined | { readonly deferred: true };

/** The DDL of a plan, and notes on what it leaves to a migration of your own. */
interface Migration {
	readonly statements: readonly string[];
	readonly notes: readonly string[];
}

/** The input of `migrationOf`: one table as declared and as the database has it. */
interface MigrationInput {
	readonly table: string;
	readonly postgres: boolean;
	/** The columns of the Drizzle table, by key. */
	readonly columns: Readonly<Record<string, Column>>;
	/** The SQL names of the columns the table has in the database. */
	readonly existing: readonly string[];
	readonly plan: MigrationPlan;
	/** Whether the DDL goes to a file (notes) rather than the database (errors). */
	readonly file: boolean;
	/** The key of the Drizzle table holding the schema version, when `context.schema` is set. */
	readonly schemaVersion?: { readonly column?: string; readonly name: string };
}

function invalid(reason: string): never {
	throw new InvalidRepositoryDeclaration({
		source: "drizzle",
		details: { reason },
	});
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** `key` in snake_case, as Drizzle's `casing: "snake_case"` names its column. */
function snakeCaseOf(key: string): string {
	const words = key.match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? [];
	return words.map((word) => word.toLowerCase()).join("_");
}

/** A default of a Drizzle column as an SQL literal, when it is a plain value. */
function literalOf(value: unknown, postgres: boolean): string | undefined {
	if (typeof value === "number" || typeof value === "bigint")
		return String(value);
	if (typeof value === "boolean")
		return postgres ? String(value) : value ? "1" : "0";
	if (value instanceof Date) return `'${value.toISOString()}'`;
	if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
	if (Array.isArray(value) || (typeof value === "object" && value !== null))
		return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
	return undefined;
}

/**
 * The definition of an added column: its SQL type, nullable unless it is
 * `notNull` with a plain `default` that fills the rows already stored.
 */
function definitionOf(column: Column, postgres: boolean): string {
	const type = column.getSQLType();
	const fill = column.hasDefault
		? literalOf(column.default, postgres)
		: undefined;
	if (fill === undefined) return type;
	return column.notNull
		? `${type} NOT NULL DEFAULT ${fill}`
		: `${type} DEFAULT ${fill}`;
}

/**
 * The DDL of the structural changes of `plan` on one table, against the
 * columns it has: an added key is an `ADD COLUMN` of its Drizzle column, a
 * renamed one a `RENAME COLUMN` from its previous key, a removed one a
 * `DROP COLUMN` only when `plan.destructive`, a new unique key a unique index
 * (and a removed one drops it, as an index or, on Postgres, a constraint),
 * and the schema version gets its column. The column of a renamed key is
 * found by the previous key as it is or in snake_case; when the table has
 * neither, the new column is added empty with a note in a file, and the
 * migration is refused when applied, since the values would be lost. What is applied already is
 * skipped, so it can run again. Nested keys live in JSON columns and other
 * changes (types, constraints) in the data: the upgrade on read and the
 * backfill handle them.
 */
function migrationOf(input: MigrationInput): Migration {
	const { columns, plan, postgres } = input;
	const table = quote(input.table);
	const existing = new Set(input.existing);
	const statements: string[] = [];
	const notes: string[] = [];
	const skip = (change: string) =>
		notes.push(
			`${change} is left to the upgrade on read and the backfill, or a migration of your own.`,
		);
	const nameOf = (key: string) => columns[key]?.name ?? key;
	const add = (key: string) => {
		const column = columns[key];
		if (!column) {
			return invalid(
				`"${key}" was added to ${plan.entity}, but its Drizzle table has no column for it: declare the column first.`,
			);
		}
		if (existing.has(column.name)) return;
		statements.push(
			`ALTER TABLE ${table} ADD COLUMN ${quote(column.name)} ${definitionOf(column, postgres)};`,
		);
		existing.add(column.name);
	};
	for (const change of plan.changes) {
		const { key } = change;
		if (key === undefined || key.includes(".")) {
			if (change.change !== "metadata")
				skip(`${change.change}${key ? ` of "${key}"` : ""}`);
			continue;
		}
		switch (change.change) {
			case "added-required":
			case "added-optional":
				add(key);
				break;
			case "renamed": {
				const from = change.from;
				const to = nameOf(key);
				if (from === undefined) {
					skip(`renamed "${key}"`);
					break;
				}
				if (existing.has(to)) break;
				const candidates = [...new Set([from, snakeCaseOf(from)])];
				const source = candidates.find((name) => existing.has(name));
				if (source !== undefined) {
					statements.push(
						`ALTER TABLE ${table} RENAME COLUMN ${quote(source)} TO ${quote(to)};`,
					);
					existing.delete(source);
					existing.add(to);
					break;
				}
				const missing = candidates.map((name) => `"${name}"`).join(" or ");
				if (!input.file) {
					invalid(
						`"${key}" of ${plan.entity} was renamed from "${from}", but the table "${input.table}" has no column ${missing} to rename: rename it with a migration of your own, or use migrations: { file } to add "${to}" empty.`,
					);
				}
				notes.push(
					`renamed "${key}" from "${from}": the table has no column ${missing}, so "${to}" is added empty; move the values with a migration of your own.`,
				);
				add(key);
				break;
			}
			case "removed": {
				const name = nameOf(key);
				if (!plan.destructive) skip(`removed "${key}" (destructive)`);
				else if (existing.has(name)) {
					statements.push(`ALTER TABLE ${table} DROP COLUMN ${quote(name)};`);
					existing.delete(name);
				}
				break;
			}
			case "unique-added": {
				const name = nameOf(key);
				statements.push(
					`CREATE UNIQUE INDEX IF NOT EXISTS ${quote(`${input.table}_${name}_unique`)} ON ${table} (${quote(name)});`,
				);
				break;
			}
			case "unique-removed": {
				// drizzle-kit declares `.unique()` as a constraint on Postgres.
				const name = quote(`${input.table}_${nameOf(key)}_unique`);
				if (postgres)
					statements.push(
						`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name};`,
					);
				statements.push(`DROP INDEX IF EXISTS ${name};`);
				break;
			}
			case "metadata":
			case "made-optional":
			case "loosened":
				break;
			default:
				skip(`${change.change} of "${key}"`);
		}
	}
	const version = input.schemaVersion;
	if (version !== undefined) {
		if (version.column === undefined) {
			invalid(
				`${plan.entity} has a schema version, but its Drizzle table has no "${version.name}" column to hold it: declare one (an integer).`,
			);
		}
		add(version.column);
	}
	return { statements, notes };
}

/** The rows of a query, whatever the driver gives. */
function rowsOf(result: unknown): Record<string, unknown>[] {
	if (Array.isArray(result)) return result;
	const rows = (result as { rows?: unknown } | undefined)?.rows;
	return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** The SQL names of the columns `table` has in the database. */
async function existingColumns(
	// biome-ignore lint/suspicious/noExplicitAny: dialect specific database
	db: any,
	table: string,
	postgres: boolean,
): Promise<string[]> {
	if (postgres) {
		const result = await db.execute(
			sql`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${table}`,
		);
		return rowsOf(result).map((row) => String(row.column_name));
	}
	const result = await db.all(sql.raw(`PRAGMA table_info(${quote(table)})`));
	return rowsOf(result).map((row) => String(row.name));
}

/** Runs `statements` in one transaction. */
async function apply(
	// biome-ignore lint/suspicious/noExplicitAny: dialect specific database
	db: any,
	statements: readonly string[],
	postgres: boolean,
): Promise<void> {
	if (postgres) {
		// biome-ignore lint/suspicious/noExplicitAny: dialect specific transaction
		await db.transaction(async (tx: any) => {
			for (const statement of statements) await tx.execute(sql.raw(statement));
		});
		return;
	}
	if (db.resultKind !== "sync") {
		// biome-ignore lint/suspicious/noExplicitAny: dialect specific transaction
		await db.transaction(async (tx: any) => {
			for (const statement of statements) await tx.run(sql.raw(statement));
		});
		return;
	}
	db.run(sql`BEGIN`);
	try {
		for (const statement of statements) db.run(sql.raw(statement));
		db.run(sql`COMMIT`);
	} catch (error) {
		db.run(sql`ROLLBACK`);
		throw error;
	}
}

/** drizzle-kit runs the statements of a migration file split by this line. */
const BREAKPOINT = "\n--> statement-breakpoint\n";

/**
 * The `migrate` of a provider with `migrations`: the DDL of the plan, run on
 * `db` (`"apply"`) or written to `file`, which gives `{ deferred: true }` so
 * `app.migrate` leaves the backfill for after the file is applied.
 *
 * One `app.migrate` calls `migrate` once per entity, so the file gathers the
 * plans of distinct entities, and a plan for an entity the run has seen
 * already is the next run: it starts the file over instead of adding to it.
 */
export function migrateOf(
	settings: Settings,
	// biome-ignore lint/suspicious/noExplicitAny: dialect specific database
	db: any,
	migrations: NonNullable<DrizzleProviderOptions["migrations"]>,
): (
	context: RepositoryContext,
	plan: MigrationPlan,
) => Promise<MigrationResult> {
	let run = new Set<string>();
	let written = false;
	return async (context, plan) => {
		if (run.has(plan.entity)) {
			run = new Set();
			written = false;
		}
		run.add(plan.entity);
		const table = tableOf(settings, context);
		const columns = getTableColumns(table) as Record<string, Column>;
		const postgres = Object.values(columns).some((column) =>
			column.columnType.startsWith("Pg"),
		);
		const name = getTableName(table);
		const existing = await existingColumns(db, name, postgres);
		if (existing.length === 0) {
			invalid(
				`The table "${name}" of ${plan.entity} does not exist: create it first (drizzle-kit, or a migration of your own).`,
			);
		}
		const schema = (context as { readonly schema?: unknown }).schema;
		const { statements, notes } = migrationOf({
			table: name,
			postgres,
			file: migrations !== "apply",
			columns,
			existing,
			plan,
			...(schema === undefined
				? {}
				: {
						schemaVersion: {
							column: versionPropertyOf(columns, settings.schemaVersionColumn),
							name: settings.schemaVersionColumn,
						},
					}),
		});
		if (migrations === "apply") {
			if (statements.length > 0) await apply(db, statements, postgres);
			return;
		}
		// Nothing to write: the table is up to date, the backfill can run.
		if (statements.length === 0) return;
		const comments = notes.map((note) => `-- ${plan.entity}: ${note}\n`);
		const text = `${comments.join("")}${statements.join(BREAKPOINT)}`;
		const { appendFile, mkdir, writeFile } = await import("node:fs/promises");
		const { dirname } = await import("node:path");
		await mkdir(dirname(migrations.file), { recursive: true });
		if (written)
			await appendFile(migrations.file, `${BREAKPOINT.trimStart()}${text}\n`);
		else await writeFile(migrations.file, `${text}\n`);
		written = true;
		return { deferred: true };
	};
}
