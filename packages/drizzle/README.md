# @afora/drizzle

A repository provider for [`@afora/core`](../../README.md) on [Drizzle ORM](https://orm.drizzle.team). It implements the provider v2 contract (queries with `where` equality and `in`, `orderBy`, `limit` / `offset`, `withDeleted`, `count`, unique keys, transactions) and passes the `providerContract` kit of `@afora/core/testing` on SQLite (`bun:sqlite`) and Postgres (PGlite). The contract and the kit are described in [docs/repositories.md](../../docs/repositories.md) and [Testing a provider](../../docs/repositories.md#testing-a-provider).

```bash
bun add @afora/core typebox drizzle-orm @afora/drizzle
```

`@afora/core` and `drizzle-orm` (`^0.45.4`) are peer dependencies. SQLite and Postgres databases are supported, with any Drizzle driver. MySQL is not (the provider relies on `RETURNING` and `NULLS FIRST/LAST`).

## Example

```ts
// schema.ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	createdAt: text("createdAt").notNull(),
	updatedAt: text("updatedAt"),
	deletedAt: text("deletedAt"),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	age: integer("age"),
	address: text("address", { mode: "json" }),
});
export const tables = { User: users };

// db.ts
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

export const db = drizzle(new Database("app.db"));

// app.ts
import {
	applicationOf,
	blueprintOf,
	entityOf,
	repositoryOf,
} from "@afora/core";
import { drizzleProvider } from "@afora/drizzle";
import { db } from "./db";
import { tables } from "./schema";

class User extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.string,
		email: ctx.email,
		age: ctx.optionalOf(ctx.integer),
		address: ctx.optionalOf(blueprintOf((c) => ({ city: c.string }))),
	})),
	{ unique: ["email"] },
) {}

const provider = drizzleProvider({ db, tables });
export const Users = repositoryOf({
	entity: User,
	provider,
	deletion: "soft",
	actions: [
		"create",
		"findById",
		"findByEmail",
		"findMany",
		"findPage",
		"update",
		"delete",
	],
});

export const App = applicationOf({
	name: "app",
	provider,
	repositories: [Users],
});

await Users.create(
	new User({ name: "Ana", email: "ana@example.com", age: 30 }),
);
await Users.findPage({
	where: { age: { in: [30, 31] } },
	orderBy: [{ key: "name" }],
	limit: 20,
});
```

`findCursor` works too: the provider reads by cursor (`capabilities.keyset`), turning the position into a keyset condition (`WHERE (name, id) > (...)`, written out with the null order and collation of `orderBy`) instead of an `OFFSET`, so a deep page costs the same as the first when the order keys are indexed.

`tables` maps a repository to its Drizzle table: by the name of the repository (`UserRepository`) and, failing that, by the name of the entity (`User`). Without more, both come from the name of the entity class, which a bundler that minifies (without `keepNames`) changes, so the table is no longer found. Declare the name to make it independent of the class: `class User extends entityOf(blueprint, { name: "User" }) {}` (`@afora/core` 0.0.6 or later; `@afora/codegen` generates it). Create the schema with `drizzle-kit` or your own migrations; the provider never changes it.

## Mapping rules

- Column property names must equal the entity keys (`createdAt`, not `created_at`; the SQL name is free). The table needs an `id` column; `createdAt`, `updatedAt` and `deletedAt` are columns like the others, and `deletedAt` makes `withDeleted` and soft deletion work. A stored key with no column throws `InvalidRepositoryDeclaration`.
- Missing values (`undefined`) are `NULL`, so make optional keys nullable. An update replaces the whole row.
- Nested records and lists are stored in JSON columns (`text({ mode: "json" })` on SQLite, `jsonb` on Postgres; not `json`, which has no equality). Nested entities are stored by id and loaded through `relations`. Filtering a structure compares the serialized JSON, so key order matters on SQLite.
- Dates and timestamps: a stored date is an ISO 8601 string. Use a `text` column, or a timestamp with `{ mode: "date" }` (converted both ways; on Postgres use `withTimezone: true`). A Postgres `timestamp` in `mode: "string"` returns a non-ISO string that the entity rejects.
- Booleans and numbers use the driver's column types (`integer({ mode: "boolean" })` on SQLite).

## Queries

- `where`: equality (`eq`; `undefined`/`null` is `IS NULL`) and `{ in: [...] }`, ANDed across keys. An empty `in` matches nothing.
- `orderBy`: ascending puts missing values first and descending last (`NULLS FIRST` / `NULLS LAST`). Strings compare by code point: SQLite's default `BINARY` collation does, and on Postgres the provider adds `COLLATE "C"` to `text`, `varchar` and `char` columns. Ties keep insertion order: by `rowid` on SQLite (the table must not be `WITHOUT ROWID`) and, on Postgres, which has no stable physical order, by `id`, which is creation order for UUID v7 ids (the default `Id`).
- `limit` / `offset`, `withDeleted` (rows with `deletedAt IS NULL` unless true) and `count` (ignores order and pagination) as in the contract.

## Unique keys

`context.unique` (`id` and the entity's `unique` keys) is checked before every `insert` and `update` with a query, so a violation is reported as `RepositoryUniqueViolation` with `details.key` even without a unique index, and soft-deleted rows keep occupying their values. The check does not close the race between concurrent writers: also declare unique indexes. The provider translates the database's unique errors (SQLite `UNIQUE constraint failed`, Postgres `23505`, including a driver error's `cause`) into the same exception, naming the key from the column. `update` and `remove` of an unknown id throw `RepositoryEntityNotFound`.

## Transactions

`capabilities.transactions` is true. `provider.transaction(run)` uses `db.transaction`, and a nested one a savepoint. Synchronous SQLite drivers (`bun:sqlite`, `better-sqlite3`) cannot run an asynchronous `db.transaction` callback, so there the provider issues `BEGIN` / `SAVEPOINT` itself and makes the other operations wait for the transaction, since there is one connection. The scoped provider throws once its callback ends. Use it with `commandOf({ transaction: true })`.

## Codegen and extraction

The package exports the catalog entry for `@afora/codegen`:

```ts
export const providers = [
	{ name: "drizzle", module: "@afora/drizzle", export: "drizzleProvider" },
];
```

so `afora-codegen generate --providers @afora/drizzle` accepts

```json
{
	"provider": {
		"use": "drizzle",
		"options": {
			"db": { "import": "./db.ts#db" },
			"tables": { "import": "./schema.ts#tables" }
		}
	}
}
```

and generates `drizzleProvider({ db, tables })`. A Drizzle provider is an opaque provider: `db` and `tables` are not JSON, so `drizzleProvider` does not register a descriptor, and `extractSpec` needs an import mapping for it (`--import provider=./db.ts#provider`) instead of guessing options.

## Tests

`bun run test:drizzle` runs `providerContract` against in-memory `bun:sqlite` and PGlite, plus repository-level tests (relations, soft deletion, `findPage`, `findCursor`, a command with a transaction).
