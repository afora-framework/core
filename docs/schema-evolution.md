# Schema evolution

Every read parses the stored row against the current blueprint, so a blueprint change meets the rows written before it: a new required key is `required`, a removed one `undeclared_key`, and one stale row fails the whole `findMany` with `InvalidRepositoryData`. Schema evolution is what an entity declares so that its old rows are still read, and how they are rewritten for good.

Some changes need nothing, some need a declaration, and none deletes data unless asked:

| Blueprint change                                                             | Class                                     | What afora does                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| New optional key                                                             | Automatic                                 | Nothing                                                                                      |
| New required key with a `fill`                                               | Automatic                                 | Fills it on read                                                                             |
| Required key made optional                                                   | Automatic                                 | Nothing                                                                                      |
| Constraint loosened (an enum gains a value, a larger `max`, a smaller `min`) | Automatic                                 | Nothing                                                                                      |
| Metadata (`description`, `sensitive`, `change`...)                           | Automatic                                 | Nothing                                                                                      |
| Key removed                                                                  | Automatic on read, destructive on rewrite | Left out on read; `app.migrate` removes it from the rows only with `destructive: true`       |
| New required key without a `fill`                                            | Declared                                  | Needs a `fill` or an `upgrade` step                                                          |
| Key renamed                                                                  | Declared                                  | `renamedFrom: "old"`; without it, it reads as a removal plus an addition                     |
| Type changed, key split or merged, reference retargeted                      | Declared                                  | Needs an `upgrade` step                                                                      |
| Constraint tightened (an enum loses a value, a smaller `max`, made required) | Declared, then checked                    | An `upgrade` step or a `fill`; `app.migrate({ mode: "check" })` lists the rows that break it |
| New unique key                                                               | Checked                                   | `app.migrate({ mode: "check" })` before it is enforced                                       |
| Entity renamed (`name`)                                                      | Declared                                  | `previousNames: ["Old"]`; `app.migrate` moves the rows; without it `start({ lock })` fails   |

Nested blueprints, records and the items of lists follow the same rules, key by key.

## fill and renamedFrom

Two options of `.with()` (and of `ctx.<property>(options)`) describe a key to the rows stored before it:

```ts
import { blueprintOf, entityOf } from "@afora/core";

class Entry extends entityOf(
	blueprintOf((ctx) => ({
		title: ctx.text.with({ renamedFrom: "name" }),
		locale: ctx.enumOf(["pt", "en"]).with({ fill: "pt" }),
	})),
	{ name: "Entry" },
) {}
```

- `fill` is the value a key gets when a stored row lacks it (`undefined`; a stored `null` is kept). Unlike `default`, which is only the [demo value](properties.md), it fills real data, on read and in a backfill. An object is copied for each row.
- `renamedFrom` is the key that held the value before: when a row lacks the key and has the old one, the value moves.

Both are kept in the property's lineage, so `app.describe()` and `afora.json` carry them.

## schemaVersion and upgrade

A change that a `fill` cannot express (a type changed, a key split, a value computed from others) is an `upgrade` step between two versions of the entity:

```ts
import { blueprintOf, entityOf } from "@afora/core";

class Entry extends entityOf(
	blueprintOf((ctx) => ({
		title: ctx.text.with({ renamedFrom: "name" }),
		slug: ctx.slug,
		tags: ctx.listOf(ctx.slug),
		locale: ctx.enumOf(["pt", "en"]).with({ fill: "pt" }),
	})),
	{
		name: "Entry",
		schemaVersion: 3,
		upgrade: {
			2: (data) => ({ ...data, slug: data.path }), // v1 -> v2
			3: (data) => ({ ...data, tags: String(data.tags ?? "").split(",") }), // v2 -> v3
		},
	},
) {}
```

- `schemaVersion` is a positive integer, 1 when absent. It is not `versioned`, which is [optimistic concurrency](entities.md#versioned-entities).
- With `schemaVersion`, every write stores it in the row under `SCHEMA_VERSION_KEY` (`"$v"`), and reads strip it before parsing. A row without it is version 1. The key is never a key of the entity; an entity with `schemaVersion` cannot declare `$v` (`ReservedEntityKey`), any other can.
- `upgrade[n]` takes the stored data of version `n - 1` (frozen, without `$v`) and gives that of version `n`. Steps are optional: a version with nothing to convert has none.
- Invalid options throw `InvalidEntitySchemaVersion` when the entity is declared: a `schemaVersion` that is not a positive integer, a step that is not a function or reaches a version outside `2..schemaVersion`, a previous name that is not an identifier or is the entity's own. An entity without `name` is named by its class, which `entityOf` does not know yet: a previous name equal to it throws when its repository is declared (`repositoryOf`), and `app.migrate` never reads the entity's own name as a previous one.

## What a read does

For an entity that declares `schemaVersion`, `previousNames`, or a key with `fill` or `renamedFrom` (at any depth), every row a repository reads, its own and those of the entities it holds through relations, is brought up before it is parsed:

1. `$v` is taken out; a row without it is version 1. A version that is not a positive integer, or one above `schemaVersion` (written by newer code), throws `InvalidRepositoryData` caused by `InvalidStoredSchemaVersion`.
2. Each `upgrade` step runs, from the stored version + 1 up to `schemaVersion`.
3. The automatic steps of the current blueprint run, recursively: each `renamedFrom` moves its key, each missing key with a `fill` gets it, and the keys the blueprint no longer declares are left out.

The steps run first because each one is written against the shape of the version it upgrades from: run after the automatic steps, `upgrade[2]` above would find `path` already dropped and `slug` filled. The automatic steps hold for the current blueprint whatever the version, so running them last also covers a `fill` or a rename added without a new version.

Every other entity is read as before, at no cost: whether an entity needs this is worked out once and cached.

Writes store the current shape (and `$v`), so the rows converge as they are written. Until then:

- A query filters and orders on the stored rows: `where: { locale: "pt" }` does not match an old row that lacks `locale`, nor `where: { title }` one that still has `name`. Run the backfill before relying on such queries.
- Each read of an old row repeats the steps. On large lists, run the backfill.
- `increment` of a key with `renamedFrom` reads the row first and, when it still holds the old key, writes it brought up (at the version read, for a versioned entity) before the provider adds the delta, so the delta adds to the old value instead of to 0. Without `capabilities.versioning`, a write of the same row in between can be lost; the backfill avoids it.

## app.migrate

`app.migrate` rewrites the stored rows in the current shape, walking each provider directly (by `after` when it reads by cursor, else by `offset`), deleted and expired rows included:

<!-- docs:code continue -->
```ts
import { applicationOf, inMemoryProvider, repositoryOf } from "@afora/core";
import type { SchemaLock } from "@afora/core/adapters";

const Entries = repositoryOf({ entity: Entry, actions: ["findById"] });
const app = applicationOf({
	name: "cms",
	entities: { Entry },
	repositories: { Entries },
	provider: inMemoryProvider(),
});
const lock: SchemaLock = await Bun.file("afora.lock.json").json();

const report = await app.migrate({
	entities: ["Entry"], // every entity with a repository by default
	mode: "check", // or "apply"
	destructive: false, // removing keys, and the rows of a previous name, needs true
	pageSize: 100,
	lock, // the committed afora.lock.json, for the plan of provider.migrate
});
report.entities.Entry;
// { scanned, upToDate, upgraded, removalPending, invalid: [{ id, issues }], movedFromPreviousNames, removedKeys, deferred, alreadyApplied }
```

- `check` only reads: it counts what `apply` would do and lists in `invalid` the rows the entity rejects once brought up (a tightened constraint, a duplicate the upgrade cannot fix, a missing reference), each with its issues.
- `apply` first gives each provider the plan of its entity (`provider.migrate(context, plan)`, see below), then rewrites the rows below `schemaVersion` or with a `fill` or `renamedFrom` pending. It writes the brought-up data as it is (`updatedAt` and `version` are left alone), with `$v`. Invalid rows are left as they are. When the provider defers the plan (`{ deferred: true }`, see below), the rows of that entity are not walked: its report has `deferred: true` and every count at 0; run `app.migrate` again once the plan is applied.
- A provider with a `journal` (`inMemoryProvider`, `@afora/drizzle` with `migrations: "apply"`) records each plan it applied, and a later run skips it. A plan with changes is identified by its checksum, the SHA-256 of the plan as canonical JSON (`{ entity, changes, destructive }`, keys sorted): `apply` asks the journal whether that checksum is recorded for the entity, and when it is, `provider.migrate` is not called and the report has `alreadyApplied: true`; the rows are still walked, as the backfill is idempotent. A plan applied and not deferred is recorded once its backfill ends, as `{ entity, plan, checksum, appliedAt }` (`MigrationJournalEntry`). `check`, a plan without changes (no `lock`, or nothing changed) and a deferred plan never touch the journal, and a provider without one gets the plan on every run, as before.
- Keys the blueprint no longer declares stay in the rows unless `destructive: true`: such a row counts in `removalPending`, and `removedKeys` lists their paths (`meta.old`, `blocks[].stale`).
- With `previousNames`, the rows stored under each previous name are read with a context made for it (`context.name` is `<Old>Repository`, `context.entity` a subclass whose record name is `Old`) and inserted under the current name, unless a row with the id is already there. They are removed from the old name only with `destructive: true`.
- It is idempotent and resumable: a row already brought up counts as `upToDate`, a row already moved is not moved again (the ids of each page of a previous name are looked up under the current one in one `findMany`), so a run stopped halfway is run again.
- `migrate` does not need the application to be started, but a provider of `providerFrom` only exists once it is.
- Invalid options, or an entity without a repository, throw `InvalidSchemaMigration`.

## The lock

`schemaLockOf(app.describe())` is the stored shape of every entity, normalized so that equivalent applications give equal JSON: per entity its `schemaVersion`, `previousNames`, unique keys, the versions its `upgrade` has a step to, and its fields (each with its JSON Schema, `optional`, `unique`, `fill`, `renamedFrom`, and the fields of a nested blueprint or record; a reference to an entity is `{ "type": "string", "entity": "User" }`). The identity keys and the keys of record plugins are left out. Committed as `afora.lock.json`, it is what the stores hold.

`diffSchemas(lock, current)` gives the changes from the lock to the code, each `{ entity, key?, change, class, satisfied, destructive, from?, detail? }`, ordered by entity and key:

- `change`: `added-required`, `added-optional`, `removed`, `renamed`, `type-changed`, `tightened`, `loosened`, `made-optional`, `made-required`, `metadata`, `unique-added`, `unique-removed`, `entity-added`, `entity-removed`, `entity-renamed`.
- `class`: `automatic`, `declared` or `check`, as in the table above.
- `satisfied`: whether the code declares what the change needs: a `fill`, a `renamedFrom`, a `previousNames`, or an `upgrade` step to a version above the lock's. Always `true` when `automatic`.
- `destructive`: whether applying it deletes stored data: a removed key, a renamed or removed entity.

`app.start({ lock })` throws `SchemaLockMismatch` (`details.problems`) when an entity of the lock is no longer named and no entity lists it in `previousNames` (renamed without it, its rows would no longer be read), or when an entity's `schemaVersion` is lower than the lock's. `schemaLockProblemsOf(lock, current)` gives the same problems without starting.

The `@afora/codegen` CLI writes and checks the lock: `afora-codegen schema lock` and `afora-codegen schema check`, for CI. See [its README](../packages/codegen/README.md).

## From commit to production

The pieces above, in the order a change goes through them. The example renames `fullName` to `name` and adds a required `locale`:

1. **Change the code.** Edit the blueprint and declare what the change needs: `renamedFrom: "fullName"` on `name`, a `fill` on `locale` (or an `upgrade` step and a higher `schemaVersion` when the change is not a key-by-key one). From this commit on, every read brings an old row up in memory, so the new code works before any row is rewritten.
2. **Check it before merging.** `afora-codegen schema check src/app.ts#App` (with `bunx`, or `npx` on Node) fails CI when a change declares nothing, and prints the stub to add. Once the code declares what it needs, `afora-codegen schema lock src/app.ts#App` writes the new `afora.lock.json`; commit it with the change.
3. **Look first.** Against the store of production, `app.migrate({ mode: "check", lock })` reads every row and reports how many would be upgraded, and in `invalid` the rows the new shape rejects (a tightened constraint, a duplicate under a new unique key), each with its issues. Fix those rows, or the declaration, before going on.
4. **Change the store's structure, before or with the deploy.** For SQL, the columns must exist before the new code writes: run `app.migrate({ mode: "apply", lock })` with `drizzleProvider({ migrations: "apply" })`, which adds and renames them, as a step of the deploy that runs before the new code serves; or write the SQL with `migrations: { file }` and apply it with drizzle-kit in your usual migration step ([`@afora/drizzle`](../packages/drizzle/README.md#schema-evolution)). A document store (in memory, DynamoDB) needs nothing here.
5. **Deploy.** `await app.start({ lock })` refuses to start with `SchemaLockMismatch` when the code and the committed lock disagree on something a read cannot handle (an entity renamed without `previousNames`, a `schemaVersion` that went down).
6. **Rewrite the rows.** `app.migrate({ mode: "apply", lock })`, from a one-off job or a deploy hook; with `migrations: "apply"`, the run of step 4 already did it. It is idempotent and resumable, so a run stopped halfway is run again. Until it runs, nothing breaks: reads keep bringing rows up.
7. **Remove what is gone, later.** The old keys (`fullName`) stay in the rows until a run with `destructive: true`, which you run once you no longer need the old values.

## Providers

A provider needs nothing new to support schema evolution: the core brings rows up, and the backfill uses `findMany`, `update`, `insert` and `remove` (and `increment` of a renamed key, `findOne`). A provider that stores rows as documents keeps `$v` as any key; one with a fixed set of columns needs a column for it, or maps `context.schema.key` to one of its own.

- `context.schema` (`RepositorySchema`), for an entity with `schemaVersion`: `{ version, key, previousNames }`.
- `provider.migrate?(context, plan)` is optional. `app.migrate({ mode: "apply" })` calls it before the backfill of each entity, with `{ entity, changes, destructive }`: the changes of `diffSchemas` from the given `lock`, or none without one. A provider with a structural schema (SQL) turns them into DDL; it applies destructive changes only when `plan.destructive`. Document stores leave it out. It gives nothing once the plan is applied, or `{ deferred: true }` (`ProviderMigrationResult`) when it only wrote it for later (`@afora/drizzle` with `migrations: { file }`): the store does not have the new shape yet, so `app.migrate` skips the backfill of the entity instead of writing rows a column is missing for.
- `provider.journal?` (`MigrationJournal`) is optional too: `applied(entity, checksum)` gives whether the plan was recorded, and `record(entry)` records one (recording the same entity and checksum again changes nothing). Keep it where the data is, so it moves with the store: `inMemoryProvider` keeps it in memory (emptied by `clear()`), `@afora/drizzle` in a table of its own. A journal of a fixed shape cannot be migrated through the plans it records.
- `inMemoryProvider` keys the table of an entity that declares a name (`name`, or a `static recordName`) by that name, as a database names its tables, so a context made for a previous name reads its old rows; the table of an entity without one stays keyed by its class.
- The [provider contract](repositories.md#testing-a-provider) has schema evolution cases, and journal cases for a provider with a `journal`.
