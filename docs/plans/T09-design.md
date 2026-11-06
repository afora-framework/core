# T09: provider v2 and typed queries

This design supplies the public query/descriptor types and an inference sandbox.
T10 wires them into the existing runtime, replacing the v1 provider signatures.
T11 supplies runner-independent contract tests; T12 completes JSON integration.

## Queries and actions

`RepositoryQuery<Entity = unknown>` has `where`, `orderBy`, `limit`, `offset`,
and `withDeleted`. A bare query uses stored values and string keys (providers).
A query parameterized by an entity class restricts keys and input values.
Record values normalize to plain data; entity values normalize to ids, including
each member of `in`. Conditions on multiple keys are ANDed. An object with the
single key `in` and an array value denotes membership, including an empty list.
Other objects use structural equality. No raw expressions or SQL enter this API.

`orderBy` is an ordered array of `{ key, direction?: "asc" | "desc" }`; default
direction is asc. Sort lexicographically, missing values first in asc (last in
desc), strings by code point and numbers numerically, stable on ties. Only scalar
fields may be ordered. Reject unknown keys, invalid directions, unsupported
query options and non-integer/negative/nonfinite pagination as
`InvalidRepositoryQuery` in the Repository layer, before calling providers.

Providers implement `findOne(context, query?)`, `findMany(context, query?)`, and
`count(context, query?)`. Remove `findIn`: relations call `findMany` with
`{ where: { id: { in: ids } } }`. `count` ignores order/limit/offset. `findOne`
returns the first result after offset, or undefined (including when limit=0).
Existing named find actions build these queries. Add typed `findMany`, `exists`
and `findPage` actions; count accepts a typed query too. `exists` asks whether
the paginated query has a row. `findPage` returns `{ items, total, limit, offset }`,
defaults 20/0, and counts without pagination. Its two reads are not an atomic
snapshot unless executed inside a provider transaction.

Providers exclude rows with `deletedAt !== undefined` unless `withDeleted` is
true. Repository reads explicitly default this to `deletion === "hard"`, keeping
the T07 hard-view behavior; soft reads default false. Relations use the related
repository's policy. Explicit `withDeleted: true` never restores an entity's
mutability. Writes retain unique values of soft-deleted rows. Invalid query
values must not silently broaden a query.

## Transactions and descriptors

The optional provider method is:

```ts
transaction<Result>(run: (provider: IRepositoryProvider<Environment>) => Promise<Result>): Promise<Result>;
```

The callback receives the scoped provider; all writes through it commit on
success and roll back on rejection. Its provider must not be used after the
callback ends. `capabilities?: ProviderCapabilities` advertises transactions and
extra operators; equality/in are mandatory regardless of this descriptor.

Memory uses isolated table snapshots, serializes transactions and queues root
operations behind active transactions, so rollback cannot discard unrelated
writes. Nested transactions through a scoped provider act as savepoints.
Clone stored data on both write and read to prevent mutation outside operations.

`providerOf({ name, options = {}, create })` calls `create(options)` once and
returns that provider unchanged (preserving methods and `this`). Keep an immutable
deep JSON descriptor in a WeakMap rather than adding members to provider objects.
Reject empty names, non-JSON options, cycles, nonfinite numbers, and nonproviders
as `InvalidRepositoryDeclaration`. `providerDescriptionOf(provider)` gives the
named descriptor or `{ kind: "opaque" }`. `inMemoryProvider()` uses this helper,
with name `inMemory` and empty options. Transaction-scoped providers are runtime
objects, not independent declarations to extract.

`app.describe().provider` describes an explicitly configured application provider;
repository descriptions include a descriptor only for their explicit provider.
Omitted providers remain omitted so extraction preserves scope and data sharing.
This replaces the v1 repository provider boolean. T10 supplies the inspector;
T12 handles all codegen implications in one sequential task.

## JSON and generated code (T12)

```json
{
  "version": 1,
  "name": "accounts",
  "provider": "inMemory",
  "entities": { "User": { "fields": { "name": "string", "age": "integer" } } },
  "repositories": {
    "Users": { "entity": "User", "actions": ["findMany", "exists", "findPage", "create"], "deletion": "soft" }
  }
}
```

```ts
const Users = repositoryOf({ entity: User, actions: ["findMany", "exists", "findPage", "create"], deletion: "soft" });
const App = applicationOf({ name: "accounts", entities: { User }, repositories: { Users }, provider: inMemoryProvider() });
await App.repositories.Users.findMany({ where: { age: { in: [18, 21] } }, orderBy: [{ key: "name" }], limit: 20 });
```

A provider reference can also be `{ "import": "./db.ts#provider" }` (generated
as a named import), or `{ "use": "drizzle", "options": { "db": { "import":
"./db.ts#db" } } }` (generated as `drizzleProvider({ db })`). A provider catalog
entry records name, package/import module and export of the factory. Catalogs
are supplied as codegen options; built-in `inMemory` needs no external catalog.
Options recurse over JSON and import references; imports are never evaluated
during validation. Unknown provider names and malformed import references are
stable validation issues. An opaque provider requires an extraction import
mapping (application key `provider`, repository key `repositories.Users.provider`);
without it, report an actionable extraction error rather than silently replacing
the provider with memory. Normalization equates `inMemory` with its named form
and empty options, but never equates an omitted provider with a shared one.

## Verification and integration

T10 updates affected handwritten providers/tests and docs; T11 runs independently
from this design; merge T10 then T11. T12 adds spec/schema/validate/normalize/
generate/extract and MCP plus both directions of behavioral round trips.
Each runs the plan's checks. Never update type-performance snapshots without
reporting a new mismatch, even when the change is the expected new actions.

The design sandbox measured 49,675 source-mode and 37,636 package-mode type
instantiations per edit (both below the 100,000 target). The existing suite
passed all 36 checks and 16 snapshots without updating any type-performance
snapshot. TypeScript 5.5, 5.9 and 7 compatibility is checked before integration.
