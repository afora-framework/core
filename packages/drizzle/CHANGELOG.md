# Changelog

## Unreleased

### Schema evolution (#28, phase 4)

- `migrations?: "apply" | { file }`, opt-in: with it the provider has `migrate(context, plan)`, which turns the structural changes of a `SchemaPlan` into DDL for SQLite and Postgres from the Drizzle table (`ADD COLUMN` of an added key, nullable unless its column is `notNull` with a plain default; `RENAME COLUMN` of a renamed one; `DROP COLUMN` of a removed one only when `plan.destructive`; a unique index of a new unique key; the schema version column) against the columns the table has, so it can run again. `"apply"` runs it in a transaction; `{ file }` writes a drizzle-kit compatible SQL migration file instead. Without the option there is no `migrate`, as before.
- With `{ file }`, `migrate` returns `{ deferred: true }` when it wrote statements, so `app.migrate` skips the backfill until the file is applied and `app.migrate` runs again; with `"apply"`, or nothing to write, it returns nothing. A plan for an entity the current run has seen already starts the file over, so a second `app.migrate` in the same process no longer adds to the first run's file.
- A renamed key whose column has another SQL name (`fullName` stored in `full_name`) is renamed from the column named as the old key or as its snake_case; with neither, `"apply"` throws `InvalidRepositoryDeclaration` instead of skipping the rename, and a file adds the new column with a comment.
- A removed unique key on Postgres also drops the constraint drizzle-kit creates for `.unique()` (`DROP CONSTRAINT IF EXISTS`, then `DROP INDEX IF EXISTS`).
- The `$v` key of an entity with `schemaVersion` (`context.schema.key`) is mapped to a `schema_version` column (`schemaVersionColumn` to name another) when the table has one, so rows round-trip it.

### Optimistic concurrency and atomic increment (#44, #34)

- `capabilities.versioning`: `update(context, data, { expectedVersion })` writes with `WHERE id = ? AND version = ?` and throws `RepositoryConcurrencyConflict` when no row matched while the id exists, so versioned entities of `@afora/core` work over it (a `version` column).
- `capabilities.atomic`: `increment(context, id, deltas, { set?, create? })` adds with `SET x = coalesce(x, 0) + ?` in one statement, and with `create` upserts with `INSERT ... ON CONFLICT (id) DO UPDATE`, on SQLite and Postgres. Soft-deleted rows are left alone.
- Needs the `@afora/core` that has versioned entities and `increment` for those actions; older versions are unaffected.

### Added

- Records that expire (#35): `capabilities.expiry`. For an entity declared with `expires`, reads add `"<key>" IS NULL OR "<key>" > now` unless `withExpired`, on a text (ISO 8601) or timestamp column; unique keys still count expired rows. Needs the `@afora/core` that has records that expire; older versions are unaffected.

## 0.0.1 — unreleased (draft: dated when it is published)

### Added

- First version. `drizzleProvider({ db, tables })`, an `IRepositoryProvider` v2 over Drizzle ORM (`drizzle-orm` `^0.45.4`) for SQLite (any driver) and Postgres (any driver): equality and `in` filters, `orderBy` (missing values first when ascending, last when descending; strings by code point), `limit` / `offset`, `withDeleted`, `count` without pagination, unique violations (`context.unique` checked before every write, and the database's own unique errors translated), `RepositoryEntityNotFound`, transactions (`db.transaction` with savepoints, or `BEGIN` / `SAVEPOINT` on synchronous SQLite drivers).
- `providers`, the `@afora/codegen` catalog entry `{ name: "drizzle", module: "@afora/drizzle", export: "drizzleProvider" }`.
- Reads by cursor: `capabilities.keyset`, so `findCursor` of a repository works over it. `after` becomes a keyset condition with the comparisons of `orderBy` (strings by code point, missing values first when ascending and last when descending), not an `OFFSET`. Needs `@afora/core` 0.0.6 or later for the action; older versions are unaffected.
- A table is found by the declared name of the entity (`entityOf(blueprint, { name: "User" })`, `@afora/core` 0.0.6 or later) before the name of its class, so `tables: { User: users }` keeps working when a bundler renames the class.
- Verified by `providerContract` on `bun:sqlite` and on PGlite, and by `repositoryOf` tests (relations, soft deletion, `findPage`, a `commandOf` with `transaction: true`).
