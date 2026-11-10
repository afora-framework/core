# Changelog

## 0.0.1 — unreleased (draft: dated when it is published)

### Added

- First version. `drizzleProvider({ db, tables })`, an `IRepositoryProvider` v2 over Drizzle ORM (`drizzle-orm` `^0.45.4`) for SQLite (any driver) and Postgres (any driver): equality and `in` filters, `orderBy` (missing values first when ascending, last when descending; strings by code point), `limit` / `offset`, `withDeleted`, `count` without pagination, unique violations (`context.unique` checked before every write, and the database's own unique errors translated), `RepositoryEntityNotFound`, transactions (`db.transaction` with savepoints, or `BEGIN` / `SAVEPOINT` on synchronous SQLite drivers).
- `providers`, the `@afora/codegen` catalog entry `{ name: "drizzle", module: "@afora/drizzle", export: "drizzleProvider" }`.
- Reads by cursor: `capabilities.keyset`, so `findCursor` of a repository works over it. `after` becomes a keyset condition with the comparisons of `orderBy` (strings by code point, missing values first when ascending and last when descending), not an `OFFSET`. Needs `@afora/core` 0.0.6 or later for the action; older versions are unaffected.
- A table is found by the declared name of the entity (`entityOf(blueprint, { name: "User" })`, `@afora/core` 0.0.6 or later) before the name of its class, so `tables: { User: users }` keeps working when a bundler renames the class.
- Verified by `providerContract` on `bun:sqlite` and on PGlite, and by `repositoryOf` tests (relations, soft deletion, `findPage`, a `commandOf` with `transaction: true`).
