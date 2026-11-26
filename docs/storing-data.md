# Storing data: Drizzle and DynamoDB

An application starts on `inMemoryProvider()`, and moving it to a database changes one line: the `provider`. The entities, repositories, use cases and outputs stay as they are, because a repository talks to its provider through one contract ([Repositories](repositories.md)). This guide moves a small application to SQL with [`@afora/drizzle`](../packages/drizzle/README.md), then to DynamoDB with [`@afora/dynamodb`](../packages/dynamodb/README.md), and says what each one can and cannot do.

## 1. Pick a provider

| Provider                                                                 | Stores in                                   | Transactions | Ids the database assigns (`Serial`) | Reads by cursor | Schema changes (`app.migrate`)        |
| ------------------------------------------------------------------------ | ------------------------------------------- | ------------ | ----------------------------------- | --------------- | ------------------------------------- |
| `inMemoryProvider()` (`@afora/core`)                                     | The memory of the process                   | yes          | yes                                 | yes             | backfill                              |
| `drizzleProvider` ([`@afora/drizzle`](../packages/drizzle/README.md))    | SQLite or Postgres, with any Drizzle driver | yes          | yes                                 | keyset          | DDL (applied or written) and backfill |
| `dynamoDbProvider` ([`@afora/dynamodb`](../packages/dynamodb/README.md)) | One DynamoDB table for every repository     | no           | no                                  | yes             | backfill only (no schema)             |

A repository declares what it needs, and the provider says what it can (`capabilities`): a repository that needs something its provider lacks fails when it is declared or when the application binds it, not on the first request. Two examples are below: `Serial` ids on DynamoDB (`UnsupportedIdentity`), and `commandOf({ transaction: true })` on a provider without transactions.

## 2. SQL with Drizzle

```bash
bun add @afora/drizzle drizzle-orm
# or: npm install @afora/drizzle drizzle-orm
```

The table is a Drizzle table whose column names are the keys of the entity, identity keys included. The provider maps a repository to its table by the name of the entity, so declare that name: a bundler that minifies renames classes.

```ts
import { Database } from "bun:sqlite";
import {
	applicationOf,
	blueprintOf,
	entityOf,
	recordNameOf,
	repositoryOf,
	Serial,
	wrapProvider,
} from "@afora/core";
import { drizzleProvider, drizzleTableOf } from "@afora/drizzle";
import { drizzle } from "drizzle-orm/bun-sqlite";

class Ticket extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text, code: ctx.string })),
	{ name: "Ticket", id: Serial, unique: ["code"] },
) {}

// The Drizzle table, derived from the entity; drizzle-kit reads it as any other.
const tickets = drizzleTableOf(Ticket, { dialect: "sqlite", name: "tickets" });

const Tickets = repositoryOf({
	entity: Ticket,
	deletion: "soft",
	actions: ["create", "findById", "findByCode", "findPage", "update", "delete"],
});

const db = drizzle(new Database(":memory:")); // a file, or Postgres with another driver
const provider = drizzleProvider({ db, tables: { Ticket: tickets } });

export const App = applicationOf({
	name: "helpdesk",
	entities: { Ticket },
	repositories: { Tickets },
	provider,
});
```

- **The table.** `drizzleTableOf(Ticket, { dialect: "sqlite" })` builds the Drizzle table from the entity, by the mapping rules of the provider: a column for each key, the identity columns, `NOT NULL` unless the key is optional, `.unique()` for the unique keys, and `schema_version` for an entity with `schemaVersion`. `dialect: "postgres"` gives the Postgres table of the same entity, and `overrides` maps a key to the column an existing database has. A table written by hand works the same, as long as it follows the [mapping rules](../packages/drizzle/README.md#mapping-rules).
- **Ids.** `id: Serial` lets the database assign the id: `create` inserts the row without it and sets the one `RETURNING` gives back. Leave it out for UUID v7 ids (a `text` column), or use `Uuid` for existing UUIDs of any version and `Key` for a natural key ([Entities](entities.md#ids)).
- **Unique keys.** The provider checks `unique` keys before it writes, so a duplicate is a `RepositoryUniqueViolation` (a 409) with the key named. That check does not close the race between two writers: declare the unique index too, as the derived table does with `.unique()`, and the provider translates the database's error into the same exception.
- **Nested values.** A nested record or list goes in a JSON column (`text({ mode: "json" })` on SQLite, `jsonb` on Postgres). An entity held by another is stored by its id and loaded through `relations`.
- **Transactions.** `commandOf({ transaction: true })` runs every use case of a call in one database transaction, and rolls it back when the call fails ([Commands](commands.md)).

Create the tables with drizzle-kit (point it at the module that exports them) or your own migrations: the provider changes no schema unless you opt in (step 5). `@afora/codegen` can write that module from `afora.json` ([Codegen and extraction](../packages/drizzle/README.md#codegen-and-extraction)). The [package README](../packages/drizzle/README.md#mapping-rules) has the rest of the mapping rules: dates, booleans, versions and increments.

## 3. Seeing what the database does

`wrapProvider` runs a function around every operation of a provider, without writing one by hand: a log line per query, a span per operation, a count for a test. Wrap the provider before you give it to the application:

<!-- docs:code continue -->
```ts
const logged = wrapProvider(provider, {
	async around({ operation, context }, next) {
		const started = performance.now();
		try {
			return await next();
		} finally {
			const ms = (performance.now() - started).toFixed(1);
			console.debug(`${recordNameOf(context.entity)}.${operation} ${ms} ms`);
		}
	},
});
```

`logged` is typed as the provider it wraps, so it goes anywhere `provider` went, and a transaction it opens is wrapped too. See [Wrapping a provider](repositories.md#wrapping-a-provider). In tests, `spyProvider` from `@afora/core/testing` is the same idea with a record of the calls ([Spying on the database](testing.md#spying-on-the-database)).

## 4. DynamoDB

```bash
bun add @afora/dynamodb @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
# or: npm install @afora/dynamodb @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

Every repository lives in one table with a string partition key `pk` and sort key `sk`. The table name usually comes from the environment, so the provider is made when the application starts, with `providerFrom`:

```ts
import {
	applicationOf,
	blueprintOf,
	entityOf,
	environmentOf,
	providerFrom,
	repositoryOf,
} from "@afora/core";
import { dynamoDbProvider } from "@afora/dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

class Ticket extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text, code: ctx.string })),
	{ name: "Ticket", unique: ["code"] }, // UUID v7 ids: DynamoDB assigns none
) {}

const Tickets = repositoryOf({
	entity: Ticket,
	actions: ["create", "findById", "findByCode", "findCursor", "update"],
});

const Env = environmentOf(blueprintOf((ctx) => ({ TABLE_NAME: ctx.string })));

export const App = applicationOf({
	name: "helpdesk",
	environments: { Env },
	entities: { Ticket },
	repositories: { Tickets },
	provider: providerFrom(Env, (env) =>
		dynamoDbProvider({ table: env.TABLE_NAME, client: new DynamoDBClient({}) }),
	),
});

await App.start(); // validates TABLE_NAME, then makes the provider
```

What changes from SQL:

- **Unique keys** are marker items written in the same `TransactWriteItems` as the entity, so they hold under concurrent writers without an index.
- **Reads.** By id and by a unique key, a read is a direct lookup. Any other `where` reads the partition of the repository and filters in memory, which suits thousands of items, not millions. `findCursor` by id pages in DynamoDB.
- **No transactions**, and **no `Serial` ids**: a command with `transaction: true`, or a repository with `create` over a `Serial` entity, is refused when it is declared or bound.

The table definition, its limits (400 KB per item, 100 items per write) and the retry options are in the [package README](../packages/dynamodb/README.md#single-table-layout).

## 5. Changing the shape later

A blueprint change meets the rows written before it. The entity declares what the change needs (`fill`, `renamedFrom`, `upgrade`), `afora-codegen schema check` in CI catches a change that declares nothing, and `app.migrate` rewrites the stored rows. With Drizzle, `drizzleProvider({ db, tables, migrations: "apply" })` also adds and renames the columns, and keeps a journal of the plans it applied so a run applies each once, or `migrations: { file }` writes the SQL for drizzle-kit to apply; DynamoDB has no schema, so only the rows are rewritten. The steps, from commit to production, are in [Schema evolution](schema-evolution.md#from-commit-to-production).

## 6. Testing against the real thing

Unit tests run on `inMemoryProvider()`, which has every capability, so they need no database. To check that a provider of your own behaves as the others do, run `providerContract` of `@afora/core/testing` against it: both packages pass it, on SQLite and Postgres (PGlite) and on DynamoDB Local ([Testing a provider](repositories.md#testing-a-provider)). For a provider of your own, see the [recipe](recipes/custom-provider.md).
