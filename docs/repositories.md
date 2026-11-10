# Repositories

`repositoryOf` makes a repository of an entity with the methods you choose: `findBy<Key>` for a unique key (`id`, a key in `options.unique`, or one holding a `unique` property such as `Slug`), giving the entity or `undefined`; `findManyBy<Key>` for any key that is not unique, giving a list (a unique key has `findBy<Key>` instead, so `findManyByEmail` is rejected by type and at declaration); `create`, `update`, `delete`, `restore` (with soft deletion), `increment`, `count`, and the queries `findMany`, `exists`, `findPage` and `findCursor`. Every method is async.

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

**Queries.** `findMany`, `exists`, `findPage` and `count` take a typed `RepositoryQuery<Entity>`: `where`, `orderBy`, `limit`, `offset` and `withDeleted`. `where` maps entity keys to a value (equality) or to `{ in: [...] }` (membership, an empty list matches nothing); conditions on several keys are ANDed. Values are normalized before they reach the provider: a record becomes its plain data and an entity its id, also inside `in`. `orderBy` is a list of `{ key, direction?: "asc" | "desc" }` on scalar fields (default `asc`): missing values come first when ascending and last when descending, strings sort by code point, numbers numerically, ties keep their order. A query with unknown keys or options, an invalid direction, an unorderable field or a negative, fractional or nonfinite `limit`/`offset` throws `InvalidRepositoryQuery` before the provider is called.

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
let after: string | undefined;
do {
	const page = await Users.findCursor({
		where: { active: true },
		orderBy: [{ key: "name" }],
		limit: 50, // 20 by default, at least 1
		after,
	});
	// page.items: User[]
	after = page.next;
} while (after !== undefined);
```

It reads a page with one provider call and no count, costs the same on the last page as on the first, and a row added or removed between two pages never repeats or skips another, which `offset` cannot promise. The query takes `where`, `orderBy`, `limit` and `withDeleted`, which must stay the same from one page to the next; `offset` is rejected, and there is no `total` (use `count`). The `id` is added as the last order, so every row has one position even when the others tie.

A cursor is opaque text (base64url) that holds the values of the order keys of the last row. It is neither encrypted nor signed: whoever receives it can read those values, so a key in `options.sensitive` cannot order a cursor (`InvalidRepositoryQuery`), and a changed cursor only moves the position inside the same `where`. An `after` that is not a cursor of `findCursor`, or that was made for another `orderBy`, throws `InvalidRepositoryCursor`, which an output answers with 400. The provider must read by cursor, `capabilities.keyset` (`inMemoryProvider` and `@afora/drizzle` do); otherwise `findCursor` throws `InvalidRepositoryQuery`.

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

Without `create`, an id that holds no entity (or a soft-deleted one) throws `RepositoryEntityNotFound`. With `create`, the missing entity is built through the entity class from `create` and the given id, each delta added to its value (0 when left out), so it is validated, gets its identity (`version: 1`) and queues `onCreate`; the provider inserts it, and a concurrent call that inserted it first still gets its deltas added. A soft-deleted entity keeps its id, so `create` on one throws `RepositoryUniqueViolation`. The sum is validated when the entity is read back, not before it is stored: a property with a maximum is not a limit `increment` enforces. The provider needs `increment`, which `repositoryOf` checks when the action is declared, and advertises it with `capabilities.atomic`.

**Providers.** A repository reads and writes through an `IRepositoryProvider` (v2), on plain unmasked values, each call getting a `context` with the `entity`, the repository `name`, its `unique` keys and `env`:

```ts
interface IRepositoryProvider<Environment = unknown> {
	findOne(
		context,
		query?: RepositoryQuery,
	): Promise<RepositoryData | undefined>; // first row after offset
	findMany(
		context,
		query?: RepositoryQuery,
	): Promise<readonly RepositoryData[]>;
	insert(context, data): Promise<void>;
	update(
		context,
		data,
		options?: { expectedVersion?: number }, // capabilities.versioning
	): Promise<void>;
	remove(context, id: string): Promise<void>;
	count(context, query?: RepositoryQuery): Promise<number>; // ignores orderBy, limit and offset
	increment?(
		// capabilities.atomic
		context,
		id: string,
		deltas: Readonly<Record<string, number>>,
		options?: { set?: RepositoryData; create?: RepositoryData },
	): Promise<RepositoryData>; // the row as stored
	capabilities?: ProviderCapabilities; // e.g. { transactions: true, keyset: true, versioning: true, atomic: true }
	transaction?<Result>(
		run: (provider: IRepositoryProvider<Environment>) => Promise<Result>,
	): Promise<Result>;
	close?(): void | Promise<void>; // called by app.stop()
}
```

`context.name` is `<entity name>Repository`, and a provider that keeps one table or collection for each entity keys it by that name or by `recordNameOf(context.entity)`, not by `context.entity.name`: the name of a class changes when the code is minified, and the name declared with `entityOf(blueprint, { name: "User" })` does not (see [Records](records.md)).

A provider that sets `capabilities.versioning` honors `options.expectedVersion` on `update`: it writes only when the stored `version` equals it, in the same atomic step, and throws `RepositoryConcurrencyConflict` otherwise (`RepositoryEntityNotFound` still for an unknown id). One that sets `capabilities.atomic` has `increment`: it adds each delta to its key (a missing value counts as 0) and stores `options.set` (the repository sends `updatedAt`) in one atomic write on a row that is not soft-deleted, and gives the row as stored; when the id holds none it inserts `options.create` as it is, or throws `RepositoryEntityNotFound` without it, and an insert that races with another one still adds the deltas. A versioned entity's `version` is one of the deltas, so an increment makes a later `update` with the old version conflict.

A provider that sets `capabilities.keyset` also honors `after` on `findMany` (`ProviderQuery`): one value for each order of `orderBy`, those of the last row read, for which it gives only the rows strictly after that position in the same order (missing values first when ascending, last when descending). `count` ignores it. A provider without the capability is never given `after`. `providerContract` runs these cases when the capability is set.

The bare `RepositoryQuery` uses string keys and stored values. Equality and `in` are mandatory; a provider excludes rows with `deletedAt !== undefined` unless `withDeleted` is `true`. A provider enforces `context.unique` (`RepositoryUniqueViolation`) and rejects an unknown id on `update` and `remove` (`RepositoryEntityNotFound`). Relations load with `findMany(context, { where: { id: { in: ids } } })` (the v1 `findIn` and the key/value signatures are gone). By default each repository gets its own `inMemoryProvider()`; repositories given the same provider share the table of their entity. A provider of `providersOf` (`provider: Providers.audit`) is resolved by each application to its own instance (see [Named providers](applications.md#named-providers)). `repositoryOf` checks that the provider has the methods its actions call.

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

## Testing a provider

`@afora/core/testing` has a contract test kit for `IRepositoryProvider` implementations. It does not import a test runner: pass the `describe`, `it` and `expect` of yours, and a factory of fresh, empty providers (called once per case).

```ts
import { describe, expect, it } from "bun:test"; // or vitest, jest
import { providerContract } from "@afora/core/testing";
import { myProvider } from "./my-provider";

providerContract({ describe, it, expect }, () => myProvider());
```

It checks `insert`, `findOne`, `findMany`, `update` (which also clears a value that is left out, as `restore` needs), `remove` and `count`; `RepositoryUniqueViolation` (soft-deleted rows keep their unique values) and `RepositoryEntityNotFound`; `where` equality, `in` and AND; `orderBy`, `limit` and `offset`; `withDeleted`; that returned data is a copy; and, when the provider advertises `capabilities.transactions` (or with `{ transactions: true }`), commit, rollback, scoped-provider lifetime and nested savepoints. Likewise `capabilities.versioning` (`{ versioning: true }`) runs the cases of `expectedVersion` (a stale version conflicts, two updates with the same one give exactly one conflict, no `expectedVersion` changes nothing), and `capabilities.atomic` (`{ atomic: true }`) those of `increment` (concurrent increments sum up, a missing id with and without `create`, concurrent creates, soft-deleted rows, and an increment of `version` making an update with the old one conflict). The rows of these cases use the columns `version` and `visits` (numbers).
