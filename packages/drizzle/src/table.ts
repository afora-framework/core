import {
	EntityIdStrategy,
	EntitySettings,
	EntityUniqueKeys,
	InvalidRepositoryDeclaration,
	isEntityClass,
	jsonSchemaOf,
} from "@afora/core";
import { ENTITY_IDENTITY_KEYS } from "@afora/core/adapters";
import { ColumnBuilder, is } from "drizzle-orm";
import {
	bigint,
	boolean,
	doublePrecision,
	jsonb,
	type PgTableWithColumns,
	index as pgIndex,
	pgTable,
	text as pgText,
} from "drizzle-orm/pg-core";
import {
	integer,
	real,
	type SQLiteTableWithColumns,
	index as sqliteIndex,
	sqliteTable,
	text as sqliteText,
} from "drizzle-orm/sqlite-core";
import { snakeCaseOf } from "./migrate";
import { entityNameOf } from "./provider";

/** The SQL dialects `drizzleTableOf` builds a table for. */
export type DrizzleDialect = "sqlite" | "postgres";

/** A repository index, as `repositoryOf({ indexes })` declares it. */
export interface DrizzleTableIndex {
	/** The keys the query matches by equality, at least one. */
	readonly where: readonly string[];
	/** The key the rows are read in order of. */
	readonly orderBy?: string;
}

/**
 * A column of the table as given in `overrides`: a Drizzle column of the
 * dialect, which replaces the derived one, or `{ name }`, the SQL name of
 * the derived one.
 */
export type DrizzleColumnOverride =
	| { readonly name: string }
	// biome-ignore lint/suspicious/noExplicitAny: a column builder of either dialect
	| ColumnBuilder<any, any, any, any>;

export interface DrizzleTableOptions<Dialect extends DrizzleDialect> {
	readonly dialect: Dialect;
	/** The SQL name of the table. Defaults to the name of the entity in snake_case (`BlogPost`: `blog_post`). */
	readonly name?: string;
	/** Columns by key, for an existing database: a SQL name, or a Drizzle column of your own. */
	readonly overrides?: Readonly<Record<string, DrizzleColumnOverride>>;
	/**
	 * The indexes of the repository (its `indexes` option): each one an SQL
	 * index named `<table>_<name in snake_case>` on its `where` keys, then
	 * its `orderBy` key.
	 */
	readonly indexes?: Readonly<Record<string, DrizzleTableIndex>>;
	/**
	 * The SQL name of the column of the schema version, for an entity
	 * declared with `schemaVersion`. Defaults to `schema_version`, as the
	 * provider does (`schemaVersionColumn`).
	 */
	readonly schemaVersionColumn?: string;
}

/** The table `drizzleTableOf` gives, by dialect. */
export type DrizzleTableOf<Dialect extends DrizzleDialect> =
	Dialect extends "postgres"
		? // biome-ignore lint/suspicious/noExplicitAny: the columns are known at runtime
			PgTableWithColumns<any>
		: // biome-ignore lint/suspicious/noExplicitAny: the columns are known at runtime
			SQLiteTableWithColumns<any>;

/** What a key is stored as. */
type Kind = "text" | "integer" | "real" | "boolean" | "json";

type Schema = Readonly<Record<string, unknown>>;

const SOURCE = "drizzleTableOf";

function invalid(reason: string): never {
	throw new InvalidRepositoryDeclaration({
		source: SOURCE,
		details: { reason },
	});
}

const isObject = (value: unknown): value is Schema =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The kind of a JSON value, for `const` and `enum`. */
function kindOfValue(value: unknown): Kind {
	if (typeof value === "string") return "text";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "number")
		return Number.isInteger(value) ? "integer" : "real";
	return "json";
}

/** One kind for all of `kinds`: the scalar they share, JSON otherwise. */
function joined(kinds: readonly (Kind | undefined)[]): Kind | undefined {
	if (kinds.includes(undefined)) return undefined;
	const [first] = kinds;
	if (first === undefined) return "json";
	if (kinds.every((kind) => kind === first)) return first;
	if (kinds.every((kind) => kind === "integer" || kind === "real"))
		return "real";
	return "json";
}

/**
 * What a value of `schema` (a JSON Schema of `jsonSchemaOf`) is stored as:
 * a string as text, an integer as an integer, a number as a real, a boolean
 * as a boolean and anything else (objects, lists, variants, any JSON) as
 * JSON. A binary value (a file) has no SQL mapping: `undefined`.
 */
function kindOf(
	schema: Schema,
	defs: Readonly<Record<string, Schema>>,
	seen: ReadonlySet<string> = new Set(),
): Kind | undefined {
	const ref = schema.$ref;
	if (typeof ref === "string") {
		const name = ref.replace(/^#\/\$defs\//, "");
		const def = defs[name];
		if (def === undefined || seen.has(name)) return "json";
		return kindOf(def, defs, new Set([...seen, name]));
	}
	if (schema.format === "binary") return undefined;
	if ("const" in schema) return kindOfValue(schema.const);
	if (Array.isArray(schema.enum)) return joined(schema.enum.map(kindOfValue));
	for (const combinator of ["oneOf", "anyOf"] as const) {
		const branches = schema[combinator];
		if (Array.isArray(branches)) {
			return joined(
				branches.map((branch) =>
					isObject(branch) ? kindOf(branch, defs, seen) : "json",
				),
			);
		}
	}
	const types = (
		Array.isArray(schema.type) ? schema.type : [schema.type]
	).filter((type) => type !== "null" && type !== undefined);
	return joined(types.map(kindOfType));
}

/** The kind of a JSON Schema `type`; `undefined` for one that is not JSON (`bigint`). */
function kindOfType(type: unknown): Kind | undefined {
	switch (type) {
		case "string":
			return "text";
		case "integer":
			return "integer";
		case "number":
			return "real";
		case "boolean":
			return "boolean";
		case "object":
		case "array":
			return "json";
		default:
			return undefined;
	}
}

// biome-ignore lint/suspicious/noExplicitAny: a column builder of either dialect
type Builder = any;

/** The Drizzle column of a kind, by dialect. */
function builderOf(dialect: DrizzleDialect, kind: Kind, name: string): Builder {
	if (dialect === "postgres") {
		switch (kind) {
			case "text":
				return pgText(name);
			case "integer":
				return bigint(name, { mode: "number" });
			case "real":
				return doublePrecision(name);
			case "boolean":
				return boolean(name);
			case "json":
				return jsonb(name);
		}
	}
	switch (kind) {
		case "text":
			return sqliteText(name);
		case "integer":
			return integer(name);
		case "real":
			return real(name);
		case "boolean":
			return integer(name, { mode: "boolean" });
		case "json":
			return sqliteText(name, { mode: "json" });
	}
}

/** The entity class a field of a blueprint holds (by reference), if any. */
function referencedEntityOf(field: unknown): object | undefined {
	if (isEntityClass(field)) return field as object;
	const record = isObject(field) ? field.record : undefined;
	return isEntityClass(record) ? (record as object) : undefined;
}

/**
 * The Drizzle table of `entity` in `options.dialect`, by the mapping rules of
 * the provider: a column per stored key, named as the key (`overrides` gives
 * another SQL name, or a column of your own); the `id` primary key (an
 * integer the database assigns for `Serial`: `AUTOINCREMENT` on SQLite, an
 * identity on Postgres); `createdAt`, `updatedAt`, `deletedAt`, `version`
 * (versioned) and `expiresAt` (`expires: { after }`) as the entity has
 * them; strings and dates as `text`, integers as `integer` (`bigint` on
 * Postgres), numbers as `real` (`doublePrecision`), booleans as
 * `integer({ mode: "boolean" })` (`boolean`), nested records, lists and
 * variants as JSON (`text({ mode: "json" })`, `jsonb`), and a nested entity
 * as the column of its id; `NOT NULL` unless the key is optional; unique keys
 * `.unique()`; `schema_version` for an entity with `schemaVersion`; and an
 * index for each of `options.indexes`.
 *
 * @throws {@link InvalidRepositoryDeclaration} when `entity` is not an
 * entity, a key has no SQL mapping (a file) and no override, or an override
 * or an index names a key the table does not have.
 */
export function drizzleTableOf<Dialect extends DrizzleDialect>(
	entity: object,
	options: DrizzleTableOptions<Dialect>,
): DrizzleTableOf<Dialect> {
	if (!isEntityClass(entity))
		invalid("Expected an entity class, made by entityOf.");
	if (!isObject(options))
		invalid('Expected options, e.g. { dialect: "sqlite" }.');
	const { dialect } = options;
	if (dialect !== "sqlite" && dialect !== "postgres")
		invalid('Expected dialect to be "sqlite" or "postgres".');
	const entityName = entityNameOf(entity);
	const tableName = options.name ?? snakeCaseOf(entityName);
	if (typeof tableName !== "string" || tableName.length === 0)
		invalid("Expected name to be a non-empty string.");
	const overrides = options.overrides ?? {};
	if (!isObject(overrides)) invalid("Expected overrides to be an object.");

	const typed = entity as {
		readonly blueprint?: {
			readonly properties?: Readonly<Record<string, unknown>>;
		};
		readonly [EntityIdStrategy]?: { readonly generatedBy?: string };
		readonly [EntityUniqueKeys]?: readonly string[];
		readonly [EntitySettings]?: { readonly schemaVersioned?: boolean };
	};
	const document = jsonSchemaOf(entity as never) as Schema;
	const properties = (document.properties ?? {}) as Readonly<
		Record<string, Schema>
	>;
	const defs = (document.$defs ?? {}) as Readonly<Record<string, Schema>>;
	const required = new Set(
		Array.isArray(document.required) ? (document.required as string[]) : [],
	);
	const fields = typed.blueprint?.properties ?? {};
	const unique = new Set(typed[EntityUniqueKeys] ?? []);
	const identity = new Set<string>(ENTITY_IDENTITY_KEYS);
	const serial = typed[EntityIdStrategy]?.generatedBy === "database";

	/** The kind of `key`: of the id of the entity it references, or of its value. */
	const kindOfKey = (key: string, schema: Schema): Kind | undefined => {
		const target = referencedEntityOf(fields[key]);
		if (target === undefined) return kindOf(schema, defs);
		const ref = typeof schema.$ref === "string" ? schema.$ref : undefined;
		const def = ref ? defs[ref.replace(/^#\/\$defs\//, "")] : undefined;
		const id = (def?.properties as Record<string, Schema> | undefined)?.id;
		return id ? kindOf(id, defs) : "text";
	};

	const columns: Record<string, Builder> = {};
	/** The column of `key`: its override, or `derive` with its SQL name. */
	const declare = (
		key: string,
		name: string,
		derive: (name: string) => Builder,
	) => {
		const override = overrides[key];
		if (override === undefined) {
			columns[key] = derive(name);
		} else if (is(override, ColumnBuilder)) {
			columns[key] = override;
		} else {
			const renamed = isObject(override) ? override.name : undefined;
			if (typeof renamed !== "string" || renamed.length === 0) {
				invalid(
					`The override of "${key}" must be a Drizzle column or { name } with its SQL name.`,
				);
			}
			columns[key] = derive(renamed);
		}
	};

	for (const [key, schema] of Object.entries(properties)) {
		declare(key, key, (name) => {
			if (key === "id") {
				if (serial) {
					return dialect === "postgres"
						? bigint(name, { mode: "number" })
								.primaryKey()
								.generatedAlwaysAsIdentity()
						: integer(name).primaryKey({ autoIncrement: true });
				}
				const kind = kindOf(schema, defs) ?? "text";
				return builderOf(
					dialect,
					kind === "json" ? "text" : kind,
					name,
				).primaryKey();
			}
			const kind = kindOfKey(key, schema);
			if (kind === undefined) {
				return invalid(
					`"${key}" of ${entityName} has no SQL mapping (its value is not JSON): give it a column in overrides.`,
				);
			}
			let column = builderOf(dialect, kind, name);
			// Always written: createdAt, version; the other identity keys and
			// expiresAt may be missing, and so may an optional key.
			const notNull =
				key === "createdAt" ||
				key === "version" ||
				(!identity.has(key) && schema.readOnly !== true && required.has(key));
			if (notNull) column = column.notNull();
			if (unique.has(key)) column = column.unique();
			return column;
		});
	}

	if (typed[EntitySettings]?.schemaVersioned === true) {
		const key = "schemaVersion";
		if (key in properties)
			invalid(
				`${entityName} declares "${key}" and a schema version, whose column the table keeps under that key: rename the key.`,
			);
		declare(key, options.schemaVersionColumn ?? "schema_version", (name) =>
			builderOf(dialect, "integer", name),
		);
	}

	for (const key of Object.keys(overrides)) {
		if (!(key in columns))
			invalid(`The override of "${key}" is not a key of ${entityName}.`);
	}

	const indexes = Object.entries(options.indexes ?? {});
	for (const [name, declared] of indexes) {
		const keys = isObject(declared)
			? [
					...(Array.isArray(declared.where) ? declared.where : []),
					...(declared.orderBy === undefined ? [] : [declared.orderBy]),
				]
			: [];
		if (
			!isObject(declared) ||
			!Array.isArray(declared.where) ||
			declared.where.length === 0
		)
			invalid(`The index "${name}" must have where, a list of keys.`);
		for (const key of keys) {
			if (typeof key !== "string" || !(key in columns))
				invalid(
					`The index "${name}" names "${String(key)}", not a key of ${entityName}.`,
				);
		}
	}
	const extra = (table: Record<string, unknown>) =>
		indexes.map(([name, { where, orderBy }]) => {
			const make = dialect === "postgres" ? pgIndex : sqliteIndex;
			const keys = [...where, ...(orderBy === undefined ? [] : [orderBy])];
			return make(`${tableName}_${snakeCaseOf(name)}`).on(
				...(keys.map((key) => table[key]) as [never, ...never[]]),
			);
		});
	const table =
		dialect === "postgres"
			? pgTable(tableName, columns, extra as never)
			: sqliteTable(tableName, columns, extra as never);
	return table as DrizzleTableOf<Dialect>;
}
