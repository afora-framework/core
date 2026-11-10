# Changelog

## Unreleased

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
