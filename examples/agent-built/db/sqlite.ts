/**
 * The SQLite database of the `--db sqlite` runs, on the afora side: the
 * Drizzle database and tables that `drizzleProvider({ db, tables })` of
 * `@afora/drizzle` is given. An agent cannot write files, so the harness
 * writes `src/db.ts` into each run (`export { db, tables } from ...` this
 * module) and the agent's spec imports it:
 *
 *   "provider": { "use": "drizzle", "options": {
 *     "db": { "import": "../db.ts#db" }, "tables": { "import": "../db.ts#tables" } } }
 *
 * What a developer does with drizzle-kit, `prepareSqlite(App)` does before the
 * application starts: one table per entity of the application, a column per
 * stored key, a primary key on `id` and a unique index on each unique key. The
 * database is the file named by DATABASE_PATH (`:memory:` when unset), as the
 * brief tells the baseline.
 */
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	integer,
	real,
	type SQLiteColumnBuilderBase,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

export const sqlite = new Database(process.env.DATABASE_PATH ?? ":memory:", {
	create: true,
});
export const db = drizzle(sqlite);

/** The Drizzle table of each entity, by entity name; filled by `prepareSqlite`. */
// biome-ignore lint/suspicious/noExplicitAny: Drizzle tables of any shape
export const tables: Record<string, any> = {};

interface JsonSchema {
	readonly type?: string | readonly string[];
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly required?: readonly string[];
	readonly anyOf?: readonly JsonSchema[];
}

interface DescribedEntity {
	readonly fields: Readonly<
		Record<string, { readonly kind: string; readonly unique?: boolean }>
	>;
	readonly options?: { readonly unique?: readonly string[] };
	readonly plugins?: readonly { readonly unique?: readonly string[] }[];
}

/** The parts of an `Application` this module reads. */
export interface SqliteApplication {
	readonly entities: Readonly<Record<string, unknown>>;
	describe(): {
		readonly entities: Readonly<Record<string, DescribedEntity>>;
	};
}

/** The JSON Schema of an entity class: the one of its blueprint. */
function schemaOf(entity: unknown): JsonSchema {
	const schema = (entity as { blueprint?: { schema?: unknown } }).blueprint
		?.schema as (JsonSchema & { _type?: JsonSchema }) | undefined;
	const object = schema?._type ?? schema;
	if (!object?.properties) {
		throw new Error("An entity without a JSON Schema cannot get a table.");
	}
	return object;
}

/** The scalar type of a key, `"json"` for objects and lists. */
function kindOf(
	schema: JsonSchema,
): "text" | "integer" | "real" | "boolean" | "json" {
	const types = [
		...(Array.isArray(schema.type)
			? schema.type
			: schema.type
				? [schema.type]
				: []),
		...(schema.anyOf ?? []).flatMap((option) =>
			typeof option.type === "string" ? [option.type] : [],
		),
	].filter((type) => type !== "null");
	if (types.length !== 1) return types.length === 0 ? "json" : "text";
	switch (types[0]) {
		case "integer":
			return "integer";
		case "number":
			return "real";
		case "boolean":
			return "boolean";
		case "string":
			return "text";
		default:
			return "json";
	}
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const snake = (name: string) =>
	name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * Creates the table of every entity of `app` (once: `IF NOT EXISTS`) and
 * fills `tables`. Called before `App.start()`.
 */
export function prepareSqlite(app: SqliteApplication): void {
	const described = app.describe().entities;
	for (const [name, entity] of Object.entries(app.entities)) {
		const schema = schemaOf(entity);
		const description = described[name];
		const unique = new Set<string>([
			...Object.entries(description?.fields ?? {})
				.filter(([, field]) => field.unique === true)
				.map(([key]) => key),
			...(description?.options?.unique ?? []),
			...(description?.plugins ?? []).flatMap((plugin) => plugin.unique ?? []),
		]);
		const references = new Set(
			Object.entries(description?.fields ?? {})
				.filter(([, field]) => field.kind === "entity")
				.map(([key]) => key),
		);
		const required = new Set(schema.required ?? []);
		const columns: Record<string, SQLiteColumnBuilderBase> = {};
		const ddl: string[] = [];
		for (const [key, property] of Object.entries(schema.properties ?? {})) {
			// a nested entity is stored by its id
			const kind = references.has(key) ? "text" : kindOf(property);
			let column =
				kind === "integer"
					? integer(key)
					: kind === "real"
						? real(key)
						: kind === "boolean"
							? integer(key, { mode: "boolean" })
							: kind === "json"
								? text(key, { mode: "json" })
								: text(key);
			const sqlType =
				kind === "integer" || kind === "boolean"
					? "INTEGER"
					: kind === "real"
						? "REAL"
						: "TEXT";
			let constraint = "";
			if (key === "id") {
				column = column.primaryKey();
				constraint = " PRIMARY KEY";
			} else if (required.has(key)) {
				column = column.notNull();
				constraint = " NOT NULL";
			}
			columns[key] = column;
			ddl.push(`${quote(key)} ${sqlType}${constraint}`);
		}
		const table = `${snake(name)}s`;
		tables[name] = sqliteTable(table, columns);
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${quote(table)} (${ddl.join(", ")})`,
		);
		for (const key of unique) {
			if (key === "id" || !(key in columns)) continue;
			sqlite.run(
				`CREATE UNIQUE INDEX IF NOT EXISTS ${quote(`${table}_${key}_unique`)} ON ${quote(table)} (${quote(key)})`,
			);
		}
	}
}
