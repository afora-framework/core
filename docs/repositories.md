# Repositories

`repositoryOf` makes a repository of an entity with the methods you choose: `findBy<Key>` for a unique key (`id`, a key in `options.unique`, or one holding a `unique` property such as `Slug`), giving the entity or `undefined`; `findManyBy<Key>` for any key that is not unique, giving a list (a unique key has `findBy<Key>` instead, so `findManyByEmail` is rejected by type and at declaration); `create`, `update`, `delete`, `restore` (with soft deletion), `increment`, `count`, the queries `findMany`, `exists`, `findPage` and `findCursor`, and `forEachPage`, which walks the pages of a cursor query and can stop and resume. Every method is async.

```ts
import {
	blueprintOf,
	entityOf,
	environmentOf,
	repositoryOf,
	RepositoryOf,
} from "@afora/core";

class User extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.string,
		email: ctx.email,
		slug: ctx.slug,
	})),
	{ unique: ["email"] },
) {}

const Users = repositoryOf({
	entity: User,
	actions: [
		"findById",
		"findByEmail",
		"findBySlug",
		"findManyByName",
		"create",
		"update",
		"delete",
		"count",
	],
});

const user = await Users.create({
	name: "Ana",
	email: "ana@example.com",
	slug: "ana",
});
await Users.findByEmail("ana@example.com"); // User | undefined
await Users.findManyByName("Ana"); // User[]
// repositoryOf({ entity: User, actions: ["findByName"] }) does not compile, and throws: name is not unique
```

**Queries.** `findMany`, `exists`, `findPage` and `count` take a typed `RepositoryQuery<Entity>`: `where`, `orderBy`, `limit`, `offset`, `withDeleted` and `withExpired` (see [Records that expire](#records-that-expire)). `where` maps entity keys to a value (equality) or to `{ in: [...] }` (membership, an empty list matches nothing); conditions on several keys are ANDed. Values are normalized before they reach the provider: a record becomes its plain data and an entity its id, also inside `in`. `orderBy` is a list of `{ key, direction?: "asc" | "desc" }` on scalar fields (default `asc`): missing values come first when ascending and last when descending, strings sort by code point, numbers numerically, ties keep their order. A query with unknown keys or options, an invalid direction, an unorderable field or a negative, fractional or nonfinite `limit`/`offset` throws `InvalidRepositoryQuery` before the provider is called.

```ts
const adults = await Users.findMany({
	where: { age: { in: [18, 21] } },
	orderBy: [{ key: "name" }],
	limit: 20,
}); // User[]
await Users.exists({ where: { name: "Ana" } }); // boolean, honors offset and limit
const page = await Users.findPage({
	orderBy: [{ key: "name" }],
	limit: 10,
	offset: 20,
});
// { items: User[], total, limit, offset }: defaults 20 and 0; total ignores pagination
await Users.count({ where: { name: "Ana" } }); // ignores orderBy, limit and offset
```

**Cursors.** `findCursor` pages by position instead of by `offset`: it gives `{ items, limit, next }`, and the `next` of a page is the `after` of the following one, `undefined` on the last.

```ts
const page = await Users.findCursor({
	where: { active: true },
	orderBy: [{ key: "name" }],
	limit: 50, // 20 by default, at least 1
	after, // the next of the page before; the first page when left out
});
// page.items: User[], page.next: string | undefined
```

It reads a page with one provider call and no count, costs the same on the last page as on the first, and a row added or removed between two pages never repeats or skips another, which `offset` cannot promise. The query takes `where`, `orderBy`, `limit`, `withDeleted` and `withExpired`, which must stay the same from one page to the next; `offset` is rejected, and there is no `total` (use `count`). The `id` is added as the last order, so every row has one position even when the others tie.

A cursor is opaque text (base64url) that holds the values of the order keys of the last row. It is neither encrypted nor signed: whoever receives it can read those values, so a key in `options.sensitive` cannot order a cursor (`InvalidRepositoryQuery`), and a changed cursor only moves the position inside the same `where`. An `after` that is not a cursor of `findCursor`, or that was made for another `orderBy`, throws `InvalidRepositoryCursor`, which an output answers with 400. The provider must read by cursor, `capabilities.keyset` (`inMemoryProvider` and `@afora/drizzle` do); otherwise `findCursor` throws `InvalidRepositoryQuery`.

**Walking every page.** `forEachPage(query, fn, { until? })` reads the pages of a `findCursor` query one after the other and awaits `fn(items, { index, next })` on each, for bulk work: deleting a content type with its entries, rewriting rows after a rename, a cleanup, a migration. It gives `{ done, next?, pages, items }`: the pages `fn` ran on and their items, and `done: true` once the last page is done.

```ts
const result = await Entries.forEachPage(
	{ where: { type: type.id }, limit: 100, after: checkpoint },
	async (items) => {
		await Promise.all(items.map((entry) => Entries.delete(entry)));
	},
);
// { done: true, pages, items }
```

`until` stops the walk before the end: a deadline (a `Date` or epoch milliseconds) or a function that says when to stop. It is checked before each page is read, never while `fn` runs, so a page is never left half done by it. When it stops the walk, the result has `done: false` and `next`, the `after` to resume from: the `next` of the last page done, or the `after` it was given when it ran none (an `until` already passed runs no page; `next` is then `undefined` if the query had no `after`, which resumes from the start). Save it and call again with `after: next`; as with `findCursor`, rows added or removed between pages, or between two calls, are neither repeated nor skipped, and `fn` may delete or change the items it gets (only a change of the keys of `orderBy` moves a row). In a Lambda, leave a margin for the longest page:

```ts
export async function handler(_event: unknown, context: Context) {
	const checkpoint = await loadCheckpoint(); // undefined the first time
	const result = await Entries.forEachPage(
		{ where: { type: typeId }, limit: 100, after: checkpoint },
		async (items, page) => {
			await Promise.all(items.map((entry) => Entries.delete(entry)));
			if (page.next) await saveCheckpoint(page.next); // done up to here
		},
		{ until: Date.now() + context.getRemainingTimeInMillis() - 10_000 },
	);
	if (result.done) await clearCheckpoint();
	else await scheduleAgain(); // resumes from the checkpoint saved
}
```

`fn` runs on one page at a time and only on pages with items (an empty repository gives `{ done: true, pages: 0, items: 0 }`); `index` counts the pages of this call from 0, and `next` is the cursor after the page (`undefined` on the last), to save once the page is done. An error of `fn` stops the walk and rejects through the repository like any other action (an `Exception` of the repository layer); resume from the last checkpoint you saved, which runs the failed page again. The query is checked as `findCursor` checks it, before the first page and even when `until` has already passed, and `forEachPage` needs `findMany` and a provider that reads by cursor. It reads with the same internal read as `findCursor`, so declaring `findCursor` is not needed. In a use case, the repository `fn` calls is the one `execute` gets, with its overrides. It is not a use case step: call it from a use case written in TypeScript.

`findPage` reads the items and the total with two provider calls, so they are not an atomic snapshot unless the provider runs them in a transaction. `findBy<Key>`, `findManyBy<Key>` and `count` are queries too. By default reads leave out deleted rows when `deletion` is `"soft"`; with `"hard"` (the default) they see every row that exists, as before. `withDeleted: true` includes soft-deleted rows, and never makes a deleted entity mutable again.

`create` takes an entity or the input that builds one. `delete` takes an entity or an id, calls `destroy()` (so `onDelete` is queued) and gives the entity. Entities read back are rebuilt from their stored value, with their identity, so they do not queue `onCreate` again.

`repositoryOf({ entity, actions, deletion: "hard" | "soft" })` defaults to `"hard"`: deletion physically removes the stored row. With `"soft"`, deletion persists `deletedAt` through the provider's `update`. Finds and counts exclude these rows; unique values remain occupied. A relation pointing to a soft-deleted entity still loads it, deleted (`isDeleted` is true and it no longer changes): an order keeps its deleted product. Soft reads send `withDeleted: false` to the provider, and soft `delete` requires `update` instead of `remove`. `app.describe()` includes each repository's resolved `deletion` mode.

The `restore` action brings a soft-deleted entity back: `await Posts.restore(post)` (or its id) reads the row with deleted ones included, clears `deletedAt`, stamps `updatedAt` and saves it through the provider's `update`, which must therefore clear a value that is left out. It gives a new entity, alive; the deleted instance stays as it is. An entity that is not deleted is given as it is stored, and an unknown id throws `RepositoryEntityNotFound`. Listing `restore` without `deletion: "soft"` throws `InvalidRepositoryDeclaration`.

**Concurrency.** `update` reads nothing: it writes the value the entity holds, so when two use cases load the same entity, change it and save it, the second write silently replaces the first. An entity declared with `versioned: true` (see [Entities](entities.md#versioned-entities)) prevents that with optimistic concurrency: it has a `version`, 1 when created, and `update` writes only when the stored `version` is still the one the entity was read with, storing the next one and moving the entity's `version` to it. When someone else wrote the entity in between, `update` throws `RepositoryConcurrencyConflict` (Repository layer, `details: { id, expected, actual? }`), which an output answers with 409; read the entity again and retry, or report the conflict.

```ts
class Doc extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.string })),
	{
		change: ["title"],
		versioned: true,
	},
) {}
const Docs = repositoryOf({ entity: Doc, actions: ["findById", "update"] });

const a = await Docs.findById(id); // version 1
const b = await Docs.findById(id); // version 1
await Docs.update(a.change.title("A")); // stored as version 2; a.version is 2
await Docs.update(b.change.title("B")); // throws RepositoryConcurrencyConflict
```

A soft `delete` and `restore` write through `update`, so they check and bump the version too, and so does `increment`. The provider must check versions, `capabilities.versioning` (`inMemoryProvider` and `@afora/drizzle` do): it gets `{ expectedVersion }` as the third argument of `update` and compares it in the same atomic step as the write. A versioned entity whose provider does not throws `InvalidRepositoryDeclaration` on its first write, not when declared, since the provider of an application may only be known once it starts. The check covers the time between the read and the write of one process; a version a client sends back (an HTTP `If-Match`) is up to the use case, which can compare it with the one it loads.

**Increment.** `increment(idOrEntity, deltas, options?)` adds numbers to keys of the stored entity in one atomic write, so concurrent calls lose nothing (an `update` would read, add and write, and two calls would lose one increment). It takes only keys of the entity's `change` list that hold a number, checked by type and at runtime (`InvalidRepositoryIncrement`, with an issue for each key, answered with 400), stamps `updatedAt`, bumps the `version` of a versioned entity, queues `onUpdate` and gives the entity as stored.

```ts
class Counter extends entityOf(
	blueprintOf((ctx) => ({
		entry: ctx.string,
		views: ctx.integer,
		reads: ctx.integer,
	})),
	{ change: ["views", "reads"] },
) {}
const Counters = repositoryOf({
	entity: Counter,
	actions: ["increment", "findById"],
});

await Counters.increment(id, { views: 1, reads: 1 }); // Counter
// creates the counter when the id holds none: { entry: "home", views: 1, reads: 0 }
await Counters.increment(
	id,
	{ views: 1 },
	{ create: { entry: "home", reads: 0 } },
);
```

Without `create`, an id that holds no entity (or a soft-deleted one) throws `RepositoryEntityNotFound`. With `create`, the missing entity is built through the entity class from `create` and the given id, each delta added to its value (0 when left out), so it is validated, gets its identity (`version: 1`) and queues `onCreate`; the provider inserts it, and a concurrent call that inserted it first still gets its deltas added. A soft-deleted entity keeps its id, so `create` on one throws `RepositoryUniqueViolation`. On an entity that [expires](#records-that-expire), an expired record counts as absent: without `create` it is not found, and with it the record is replaced by a fresh one (new `createdAt` and `expiresAt`, `version: 1`, the deltas applied), which is how a rate-limit window starts again. The sum is validated when the entity is read back, not before it is stored: a property with a maximum is not a limit `increment` enforces. The provider needs `increment`, which `repositoryOf` checks when the action is declared, and advertises it with `capabilities.atomic`.

**Providers.** A repository reads and writes through an `IRepositoryProvider` (v2), on plain unmasked values, each call getting a `context` with the `entity`, the repository `name`, its `unique` keys, `env` and, for an entity that expires, `expiry` (`{ key }`):

```ts
interface IRepositoryProvider<Environment = unknown> {
	findOne(context, query?: ProviderQuery): Promise<RepositoryData | undefined>; // first row after offset
	findMany(context, query?: ProviderQuery): Promise<readonly RepositoryData[]>;
	insert(context, data): Promise<void>;
	update(
		context,
		data,
		options?: { expectedVersion?: number }, // capabilities.versioning
	): Promise<void>;
	remove(context, id: string): Promise<void>;
	count(context, query?: ProviderQuery): Promise<number>; // ignores orderBy, limit and offset
	increment?(
		// capabilities.atomic
		context,
		id: string,
		deltas: Readonly<Record<string, number>>,
		options?: { set?: RepositoryData; create?: RepositoryData; now?: string },
	): Promise<RepositoryData>; // the row as stored
	capabilities?: ProviderCapabilities; // e.g. { transactions: true, keyset: true, versioning: true, atomic: true }
	transaction?<Result>(
		run: (provider: IRepositoryProvider<Environment>) => Promise<Result>,
	): Promise<Result>;
	close?(): void | Promise<void>; // called by app.stop()
}
```

`context.name` is `<entity name>Repository`, and a provider that keeps one table or collection for each entity keys it by that name or by `recordNameOf(context.entity)`, not by `context.entity.name`: the name of a class changes when the code is minified, and the name declared with `entityOf(blueprint, { name: "User" })` does not (see [Records](records.md)).

A provider that sets `capabilities.versioning` honors `options.expectedVersion` on `update`: it writes only when the stored `version` equals it, in the same atomic step, and throws `RepositoryConcurrencyConflict` otherwise (`RepositoryEntityNotFound` still for an unknown id). One that sets `capabilities.atomic` has `increment`: it adds each delta to its key (a missing value counts as 0) and stores `options.set` (the repository sends `updatedAt`) in one atomic write on a row that is not soft-deleted, and gives the row as stored; when the id holds none it inserts `options.create` as it is, or throws `RepositoryEntityNotFound` without it, and an insert that races with another one still adds the deltas. For an entity that expires (`context.expiry`), a row expired at `options.now` counts as absent, and `create` replaces it. A versioned entity's `version` is one of the deltas, so an increment makes a later `update` with the old version conflict.

A provider that sets `capabilities.keyset` also honors `after` on `findMany` (`ProviderQuery`): one value for each order of `orderBy`, those of the last row read, for which it gives only the rows strictly after that position in the same order (missing values first when ascending, last when descending). `count` ignores it. A provider without the capability is never given `after`. `providerContract` runs these cases when the capability is set.

A provider that sets `capabilities.expiry` leaves expired rows out of `findOne`, `findMany` (with `after` too) and `count`: when `context.expiry` is set and `withExpired` is not `true`, it gives only the rows whose `context.expiry.key` is missing (or `null`) or later than `query.now`. The repository gives `now` (an ISO 8601 string, from the clock of the entity) and `withExpired` only for an entity that expires; a provider called without `now` uses the current time. Dates are stored as ISO 8601 strings, which compare as text when they are all UTC (`toISOString()`), as the ones `std` makes. Unique keys still count expired rows. `providerContract` runs these cases when the capability is set.

The bare `RepositoryQuery` uses string keys and stored values. Equality and `in` are mandatory; a provider excludes rows with `deletedAt !== undefined` unless `withDeleted` is `true`, and, with `capabilities.expiry`, expired rows unless `withExpired` is `true`. A provider enforces `context.unique` (`RepositoryUniqueViolation`) and rejects an unknown id on `update` and `remove` (`RepositoryEntityNotFound`). Relations load with `findMany(context, { where: { id: { in: ids } } })` (the v1 `findIn` and the key/value signatures are gone). By default each repository gets its own `inMemoryProvider()`; repositories given the same provider share the table of their entity. A provider of `providersOf` (`provider: Providers.audit`) is resolved by each application to its own instance (see [Named providers](applications.md#named-providers)). `repositoryOf` checks that the provider has the methods its actions call.

`transaction(run)` is optional: `run` gets a scoped provider whose writes commit when it resolves and roll back when it rejects; the scoped provider must not be used after `run` ends. `inMemoryProvider()` runs transactions on isolated snapshots, one at a time, makes other operations wait for the active one (so a rollback never discards unrelated writes), treats nested transactions through the scoped provider as savepoints, and clones data on write and read.

`providerOf({ name, options = {}, create })` calls `create(options)` once and returns that provider unchanged, keeping an immutable JSON description out of band; `providerDescriptionOf(provider)` gives `{ kind: "provider", name, options }`, or `{ kind: "opaque" }` for a provider made without it. Empty names, non-JSON or cyclic options and non-providers throw `InvalidRepositoryDeclaration`. `app.describe()` reports `provider` for an application with an explicit provider and for each repository that declared its own; omitted providers stay omitted.

**Environments.** `environmentOf(blueprint)` reads the declared variables from `process.env` (or `{ source }`), validates them on the first `load()` and keeps the value; a missing or rejected variable throws `InvalidEnvironment`. Pass one, or a list (merged in order), as `environmentDependencies`: the provider gets them as `context.env`, read on the first call, not on declaration.

```ts
const Database = environmentOf(
	blueprintOf((ctx) => ({ DATABASE_URL: ctx.url })),
);
const Posts = repositoryOf({
	entity: Post,
	actions: ["findById"],
	provider: postgres,
	environmentDependencies: [Database],
});
```

A variable is converted when its property does not take a string: to `true` or `false` (from `"true"` and `"false"`) for a boolean, and to a number for a number, e.g. `PORT: ctx.integer` reads `"3000"` as `3000`, and `DEBUG: ctx.boolean` reads `"true"` as `true`. A property that takes a string keeps the variable as is, so `"10"` stays a string for `ctx.string`. A value that does not convert is left for the blueprint to reject.

**References.** An entity a record holds (as a field, in a list, in a blueprint, or in a record that is not an entity) is stored as its id, not as a copy, and loaded back when the record is read, so it is always current. List the repositories that load them in `relations`: one for each entity class held, at any depth (the class itself, or a subclass). A missing, extra, duplicated or invalid relation throws `InvalidRepositoryDeclaration`. A stored id with no entity throws `InvalidRepositoryData`, caused by `RepositoryEntityNotFound`, even in an optional field. Reads load by batch (one `findMany` with `in` for each relation, under the deletion policy of the related repository), and the same id is the same instance within a read. Writes do not cascade: the entity is not checked or saved, so persist it through its own repository. Entities loaded this way do not queue `onCreate` again, and a use case collects the events of an entity only when it goes through that entity's own repository. `findBy<Key>` and `findManyBy<Key>` take the entity or its id (a list of them for a list field).

```ts
class PasswordRecovery extends entityOf(
	blueprintOf((ctx) => ({ user: User, token: ctx.string })),
	{ unique: ["token"] },
) {}

const Recoveries = repositoryOf({
	entity: PasswordRecovery,
	actions: ["findByToken", "findManyByUser", "create"],
	relations: [Users], // stored as { user: "<id>", token: "..." }
});

await Recoveries.findManyByUser(user); // or findManyByUser(user.id)
```

**Extending.** `RepositoryOf(repository)` is the class of a repository, to extend. Its instances share the entity, actions, provider and environment of the repository, and can use the protected `provider`, `context`, `env`, `dataOf(entity)`, and the async `hydrate(data)` and `hydrateMany(list)`, which also load the entities a stored value holds. `create`, `update`, `delete` and `count` are overridden as methods. `findBy<Key>` and `findManyBy<Key>` are named after the entity's keys, so TypeScript types them as properties: override them with a field, which can still call `super`.

```ts
class UsersRepository extends RepositoryOf(Users) {
	override findByEmail = async (email: string) =>
		super.findByEmail(email.trim().toLowerCase());

	override async create(...args: Parameters<typeof Users.create>) {
		const user = await super.create(...args);
		// ...
		return user;
	}

	async countAll() {
		return this.provider.count(this.context);
	}
}
```

As a type, `RepositoryOf<typeof User, ["findById", "create"]>` is the repository with those methods.

**In use cases.** A repository (or an instance of a class extending one) and an environment are dependencies of a use case, next to other use cases. The use case gets the repository's methods, usable only during execution; the events of the entities they take and give move to the use case. In a class extending a repository, the methods call each other through the use case too (`this.create` inside `revokeAllOf`): their events move to it, and what `execute` replaces is replaced there as well. Only the events of entities of the repository's own class move; the entities it holds (`post.author`) leave theirs to their own repository. Two limits: `#private` members do not work in the methods the use case calls, and an arrow field calling `this.other` does not go through the use case (`super.other` does); a repository used by importing it is not tracked. It gets an environment's variables. `execute` replaces some methods of a repository with an object, and an environment with variables its blueprint accepts.

```ts
class Register extends useCaseOf({
	name: "Register",
	blueprint: UserInput,
	response: UserResponse,
	dependencies: { users: Users, database: Database },
}) {
	override async execute({ users = this.dependencies.users } = {}) {
		return { user: await users.create(this.input) };
	}
}
```

## Records that expire

For an entity declared with [`expires`](entities.md#records-that-expire), every read (`findMany`, `count`, `exists`, `findPage`, `findCursor`, `findBy<Key>`, `findManyBy<Key>`, and the read of `delete` and `restore` given an id) leaves out the records whose date (`expiresAt`, or the key of `at`) is at or before now, by the clock of the entity; a record without a date never expires. `withExpired: true` includes them.

```ts
const AuditEvents = repositoryOf({
	entity: AuditEvent, // expires: { after: { days: 400 } }
	actions: ["create", "findMany", "count"],
});
await AuditEvents.count(); // the events of the last 400 days
await AuditEvents.count({ withExpired: true }); // every stored event
```

- Unique keys still count expired records, as they count soft-deleted ones: a new record cannot take the unique value of an expired one until the row is removed.
- A relation pointing to an expired entity still loads it (relations read with `withDeleted` and `withExpired`): a reference is data, not a missing id.
- Writes do not look at the date: `update` and `delete` of an expired entity you hold work as for any other, but `delete(id)` and `restore(id)` read the row first, so an expired one is not found (`RepositoryEntityNotFound`).
- The provider must leave expired records out, `capabilities.expiry` (`inMemoryProvider` and `@afora/drizzle` do); otherwise every read throws `InvalidRepositoryQuery`. Writes work without it.
- Records are only left out, not removed: purge them in the database (a TTL, a scheduled `DELETE`).

## Testing a provider

`@afora/core/testing` has a contract test kit for `IRepositoryProvider` implementations. It does not import a test runner: pass the `describe`, `it` and `expect` of yours, and a factory of fresh, empty providers (called once per case).

```ts
import { describe, expect, it } from "bun:test"; // or vitest, jest
import { providerContract } from "@afora/core/testing";
import { myProvider } from "./my-provider";

providerContract({ describe, it, expect }, () => myProvider());
```

It checks `insert`, `findOne`, `findMany`, `update` (which also clears a value that is left out, as `restore` needs), `remove` and `count`; `RepositoryUniqueViolation` (soft-deleted rows keep their unique values) and `RepositoryEntityNotFound`; `where` equality, `in` and AND; `orderBy`, `limit` and `offset`; `withDeleted`; that returned data is a copy; when the provider advertises `capabilities.transactions` (or with `{ transactions: true }`), commit, rollback, scoped-provider lifetime and nested savepoints; and, with `capabilities.expiry` (or `{ expiry: true }`), that `findOne`, `findMany`, `count` and reads after a position leave out rows whose `expiresAt` is at or before `now` (its table needs an `expiresAt` column), that a row without one never expires, that `withExpired` gives them back and that unique keys still count them. Likewise, `capabilities.versioning` (`{ versioning: true }`) runs the cases of `expectedVersion` (a stale version conflicts, two updates with the same one give exactly one conflict, no `expectedVersion` changes nothing), and `capabilities.atomic` (`{ atomic: true }`) those of `increment` (concurrent increments sum up, a missing id with and without `create`, concurrent creates, soft-deleted rows, and an increment of `version` making an update with the old one conflict). The rows of these cases use the columns `version` and `visits` (numbers).
