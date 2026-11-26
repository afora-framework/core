# Entities

An entity is a record with identity, ready to persist. `entityOf` takes a blueprint and the options of `recordOf` (`name` included, which keeps the name of the entity [stable when the code is minified](records.md)), and adds four keys to it, from `std`:

- `id`: an `Id` (UUID v7) by default, generated when the value has none and always listed in `options.unique`. The `id` option replaces it for one entity (see [Ids](#ids)).
- `createdAt`: generated as now when the value has none. The `id` and `createdAt` that `entityOf` makes by default (and the `expiresAt` of an entity that expires) are made only after the rest of the value is known to be valid, so invalid input makes none of them; an entity that nests others gets its id after theirs. A generator set with `configure({ idGenerator })` still makes its id first, and the id is checked.
- `updatedAt`: absent until the first change, then set to now by each `set` or `change.<key>`, before `onSetAll` and `onSet` run.
- `deletedAt`: set by `destroy()`, which then runs `onDestroy`. A destroyed entity (`isDeleted`) no longer changes: `set`, `change.<key>` and `destroy` throw `DeletedEntity`.

```ts
import { blueprintOf, entityOf, listOf, optionalOf } from "@afora/core";

class User extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string })),
	{ change: ["name"] },
) {}

const user = new User({ name: "Jane" });
user.id; // "019a…" (UUID v7)
user.updatedAt; // undefined
user.change.name("Ann").updatedAt; // now
user.destroy().isDeleted; // true

// Loaded from a database: the identity given is validated and kept
const { id, createdAt, updatedAt, deletedAt } = user;
new User({ id, createdAt, updatedAt, deletedAt, name: "Jane" });

// As any record, an entity is a field of a record or of another entity
class Post extends entityOf(
	blueprintOf((ctx) => ({
		title: ctx.string,
		author: User,
		reviewer: optionalOf(User),
		coauthors: listOf(User),
	})),
) {}
new Post({ title: "Hi", author: { name: "Jane" }, coauthors: [user] }); // author gets its own id
```

An entity declared with `expires: { after }` gets a fifth one, `expiresAt` (see [Records that expire](#records-that-expire)), and a versioned entity one more, `version` (see [Versioned entities](#versioned-entities)).

The identity keys are read-only: `set` throws `ImmutableEntityKey` for them, and they get no `change.<key>` method. The blueprint cannot declare them, nor the members of an entity (`destroy`, `isDeleted`, `equals`, `onDestroy`, `emit`, `pullEvents`): `entityOf` throws `ReservedEntityKey`. Code that handles entities without knowing their class reads both lists from `@afora/core/adapters`: `ENTITY_IDENTITY_KEYS` (`id`, `createdAt`, `updatedAt`, `deletedAt`) and `RESERVED_ENTITY_KEYS` (those and the members above). An entity class also keeps its unique keys, as `options.unique` lists them, under the `EntityUniqueKeys` symbol: `repositoryOf` reads it to accept only classes made by `entityOf` and to generate a `findBy<Key>` for each unique key (and a `findManyBy<Key>` for the others). `user.equals(other)` compares entities of the same declaration by `id`. `isEntityClass` and `isEntity` tell entities apart from records. `entityBuilderOf({ identity, generateId, now, expiresAt })` makes an `entityOf` with your own identity fields and clock (`expiresAt`, a date and time property, is the field entities expiring `after` a duration get; without it such a declaration throws `InvalidEntityExpiry`).

Entities can queue domain events for an external consumer. `eventOf` accepts an entity class (including subclasses) and an optional async handler returning `Promise<void>`, called with the entity and `{ logger }` (the logger of the application whose command raised the event; see [Logging](logging.md)); `event.handle({ logger })` can give another. Definitions are immutable; incompatible entity instances are rejected when emitting. An event without a handler (`eventOf("created", Post)`) only carries the entity, for a policy such as [`publishEvents`](commands.md#event-policies); its `handle()` does nothing. `app.describe().entities.<Name>.events` gives the lifecycle events of an entity by cycle, and under `emits` those its methods declare (see below), each `{ name, handler }` (whether it has one).

State transitions belong in methods of a class that extends the one `entityOf` makes, where `change.<key>` and the protected `emit` are at hand; repositories take that class as their `entity` and give back instances of it. `app.describe().entities.<Name>.implementation` is `"class"` when the registered class adds members of its own (methods, getters) between itself and the class `entityOf` made; an empty subclass is described as the class it extends. In an `afora.json`, such a class is named with `implementation` (see [Entities with methods](afora-json.md#entities-with-methods)).

```ts
import {
	blueprintOf,
	entityOf,
	eventOf,
	type EventDefinition,
} from "@afora/core";

const UserBlueprint = blueprintOf((ctx) => ({ name: ctx.string }));
class User extends entityOf(UserBlueprint, {
	change: ["name"],
	onCreate: () => UserCreated,
	onUpdate: () => [UserUpdated],
	onDelete: () => UserDeleted,
	emits: () => [UserUpdated],
}) {
	announce(): void {
		this.emit(UserUpdated);
	}
}

// The annotation breaks TypeScript's circular inference through the base class.
// The handler parameter is still inferred as User.
const UserCreated: EventDefinition = eventOf(
	"user.created",
	User,
	async (user) => {
		console.log(user.id);
	},
);
const UserUpdated: EventDefinition = eventOf(
	"user.updated",
	User,
	async (user) => {
		console.log(user.name);
	},
);
const UserDeleted: EventDefinition = eventOf(
	"user.deleted",
	User,
	async (user) => {
		console.log(user.deletedAt);
	},
);

const user = new User({ name: "Jane" });
user.change.name("Ann");
user.announce();
for (const event of user.pullEvents()) {
	await event.handle();
}
```

The events the methods raise can be declared with `emits`, beside `onCreate`, `onUpdate` and `onDelete`: a definition, a list, or a function returning either (so the definitions may follow the class). Nothing queues them; `emits` tells `describe()`, the spec and the tools built on it which events the entity can raise. It is optional and does not restrict: `emit` still accepts an event that is not listed. In the example, `emits: () => [UserUpdated]` would list `user.updated`, raised by `announce`.

`emit` is protected and synchronous: it queues without executing the handler. `pullEvents()` immediately empties that instance's queue and returns occurrences with `name`, `entity`, and `handle(): Promise<void>`, in emission order, including duplicates. Each occurrence references the original entity and sees its state when handled, without making a snapshot. Events are excluded from `toJSON()` and JSON serialization. Records have no event API.

Each lifecycle option accepts a definition, a readonly list, or a function returning either. Functions are resolved only during their cycle, so definitions may follow the entity class but must exist before constructing instances. `onCreate` queues after base construction and validation only when **both** input `id` and `createdAt` are `undefined`. Supplying either identity field, as when loading persisted data, suppresses creation; parsing plain input follows the same rule. `onUpdate` queues after each valid `set` (including `change.<key>` and equal values) stores the value and `updatedAt`, before `onSetAll` and `onSet`. `onDelete` queues after `deletedAt` is stored, before `onDestroy`. Invalid operations and repeated deletion do not queue lifecycle events. If an existing hook throws after a mutation, its queued events remain.

The consuming layer decides when to drain and execute events. `handle()` propagates handler failures and can be called more than once. There is no automatic execution, dispatcher, retry, or execution-once guarantee.

## Ids

By default the id of an entity is a UUID v7, made when the value has none. The `id` option of `entityOf` gives one entity another strategy, and leaves every other entity as it is:

- `Uuid`: a UUID of any version (a v4 loaded from an existing database), lower-cased. A new entity still gets a UUID v7 from the configured generator.
- `Key`: a natural key, any text of 1 to 256 characters, never generated: the input must hold it, and building the entity without one reports an issue at `id`. The constructor type requires it too.
- `Serial`: a positive integer the database assigns as it stores the entity (an auto-increment, `serial` or identity column). See [Ids the database assigns](#ids-the-database-assigns).
- `idOf(property, generate?)`: any required property, with the function that makes an id when the value has none. Without `generate`, the id is a natural key, as with `Key`.

```ts
import { blueprintOf, entityOf, idOf, Integer, Key, Uuid } from "@afora/core";

const Named = blueprintOf((ctx) => ({ name: ctx.string }));

class Legacy extends entityOf(Named, { id: Uuid }) {}
new Legacy({ id: "6f1c2b9e-3d4a-4e8b-9f2a-1c3b5d7e9f0a", name: "Old" }); // kept
new Legacy({ name: "New" }).id; // a UUID v7

class Setting extends entityOf(Named, { id: Key }) {}
new Setting({ id: "seo", name: "SEO" }).id; // "seo"

let next = 0;
class Ticket extends entityOf(Named, { id: idOf(Integer, () => ++next) }) {}
new Ticket({ name: "First" }).id; // 1, typed number
```

The properties of `Uuid`, `Key` and `Serial` are exported as `UuidKey`, `TextKey` and `SerialKey`. The property of the strategy takes the place of `Id`: the type of `entity.id`, of `findById`, of `delete(id)` and of the `{id}` of the standard use cases follows it, and an HTTP route reads an integer id from the path as a number. The id stays unique and read-only. An id made by `generate` is validated like any other value; only the default generator, and `Uuid` with it, skip the check of what they just made. The standard `create` use case takes the id in its input when the entity makes none. The subject of a token is text: `refresh` and an `access.context` that reads `subject` (or a claim) turn it into a number where the id or the context key is an integer, so users with integer ids log in, refresh and fill their context; the `ownerId` of `ownable` holds an id of any strategy. Repositories store and resolve references to these entities by their id, a string or a number (`IdValue`, checked with `isIdValue(value)`; `isIdStrategy(value)` tells whether a value was made by `idOf`); the DynamoDB provider still needs a non-empty string id. The class keeps its strategy under the `EntityIdStrategy` symbol, and `app.describe().entities.<Name>.id` gives `{ property, generated }` (`generated` is `"database"` for `Serial`). An `id` not made by `idOf` throws `InvalidIdStrategy`.

### Ids the database assigns

With `id: Serial`, the database gives each new entity its id, a positive integer, when `repository.create` stores it:

```ts
import { blueprintOf, entityOf, repositoryOf, Serial } from "@afora/core";

class Ticket extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.string })),
	{ id: Serial },
) {}

const ticket = new Ticket({ title: "First" });
ticket.id; // undefined: not stored yet

const Tickets = repositoryOf({
	entity: Ticket,
	actions: ["create", "findById"],
});
const stored = await Tickets.create(ticket); // the same entity
stored.id; // 1, set by create
```

- **Before `create`.** An entity built without an id is valid and has none: `id` reads `undefined` (its type stays `number`, the id of a stored entity) and `toJSON()` leaves it out. It equals only itself. An entity loaded from the database, or built with an id, has that id, validated as a positive integer up to `Number.MAX_SAFE_INTEGER`. Until it is created, the repository refuses it with `UnstoredEntity`: to `update`, `delete` (checked before `destroy()`, so the entity is left as it was), `restore` or `increment`, and as an entity held by another one (a field or a list of them), which is stored by its id.
- **`create`.** The row goes to the provider without `id`; the provider gives back the one the database assigned, validated by `SerialKey`, and `create` sets it on the entity before it returns. An id the entity rejects (one above `Number.MAX_SAFE_INTEGER`, from a `bigint` column, say) throws `UnsupportedIdentity`, and the entity keeps none. A new entity given an id of its own is refused with `UnsupportedIdentity`, by `create` and by `increment` with `create`: a row inserted with its own id leaves the sequence of the database behind, so a later insert would get an id already taken (and an identity column `GENERATED ALWAYS` refuses it). Rows with ids of their own (a seed, a migration) go to the database directly; the in-memory provider, like a database, does not move its sequence past them, so a later `create` can collide with one (`RepositoryUniqueViolation`).
- **A rolled back `create`.** The id is set on the entity, and its `onCreate` queued, as soon as the insert returns: when the transaction of a command later rolls back, no row holds that id, but the entity keeps it. Build a new entity to try again (`create` refuses one with an id).
- **Events.** The `onCreate` events of the entity wait for its id: they are queued by `create`, before any event the entity emitted since it was built, so an `onCreate` handler always sees the id. Another event the entity emits before `create` holds the entity itself, not a copy: pulled and handled after `create` (as a use case does), it sees the id; pulled before, it does not.
- **Providers.** Only a provider with `capabilities.generatedIds` assigns ids: the in-memory provider (one counter per entity that, as a database sequence, never gives an id twice) and the Drizzle provider (SQLite and Postgres). A repository with `create` over another provider, such as DynamoDB's, throws `UnsupportedIdentity` when it is declared, when an application binds it to its provider, or on `app.start()` for a provider made on start. A repository that only reads is accepted.
- **Use cases.** The standard `create` use case and the `POST` of `resourceOf` do not take the id; the `{id}` of the other routes is read from the path as a number.

## Records that expire

`expires` declares when the records of an entity expire. [Repositories](repositories.md#records-that-expire) then leave them out of every read, whatever the provider, so an audit log, a daily salt or a rate-limit window needs no hand-written `ttl` and no filter of its own.

```ts
import { blueprintOf, entityOf, optionalOf } from "@afora/core";

// 400 days after createdAt, kept in the identity key expiresAt
class AuditEvent extends entityOf(
	blueprintOf((ctx) => ({ action: ctx.string })),
	{ name: "AuditEvent", expires: { after: { days: 400 } } },
) {}
new AuditEvent({ action: "login" }).expiresAt; // createdAt + 400 days

// At the date held by a key of the blueprint; without one, never
class Window extends entityOf(
	blueprintOf((ctx) => ({
		hits: ctx.integer,
		until: optionalOf(ctx.dateTime),
	})),
	{ name: "Window", expires: { at: "until" } },
) {}
```

- `{ after: { days?, hours?, minutes?, seconds? } }`: a non-empty duration of positive numbers (fractions allowed). The entity gets a read-only `expiresAt` identity key (a `std` `ExpiresAt`, a date and time), set to `createdAt` plus the duration when the value has none, so a row loaded without it gets it too; a value that has one keeps it. The blueprint cannot declare `expiresAt` (`ReservedEntityKey`) and `change` cannot list it (`ImmutableEntityKey`).
- `{ at: key }`: `key` is a key of the blueprint (checked by the type of the option too) holding a date (`ctx.dateTime` or `ctx.date`, optional or not). The record expires at that date; a record without a value never expires. The key stays an ordinary one: `change` may list it to extend or cut the life of a record.
- A record expires once its date is **at or before** now, by the clock of the entity (`now` of `entityBuilderOf`, the system clock in `std`).
- Anything else (an unknown key, a key that holds no date, an empty or negative duration, an unknown unit, both forms at once) throws `InvalidEntityExpiry` when the entity is declared.

`entityOf` keeps the option under the `EntitySettings` symbol (`{ versioned, expires }`), and `app.describe().entities.<Name>.expires` gives it as declared. Expired records are only left out of reads: removing them for good (a purge) is up to the database for now, as a TTL of DynamoDB or a scheduled `DELETE` in SQL.

## Versioned entities

`entityOf(blueprint, { versioned: true })` adds a `version` identity key: a positive integer (`EntityVersion`), 1 when the entity is built without one, kept as given when it is loaded. Like the other identity keys it is read-only (no `change.version`, `set` throws `ImmutableEntityKey`) and the blueprint cannot declare it (`ReservedEntityKey`); only the repository moves it. On an entity that is not versioned, `version` is an ordinary key, and the instance type has `version: number` only when `versioned` is `true`.

```ts
import { blueprintOf, entityOf } from "@afora/core";

class Doc extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.string })),
	{
		change: ["title"],
		versioned: true,
	},
) {}

new Doc({ title: "Draft" }).version; // 1
```

The repository uses it for optimistic concurrency: `update` (and a soft `delete`, `restore` and `increment`) writes only when the stored version is the one the entity was read with, and bumps it; otherwise it throws `RepositoryConcurrencyConflict` (409). See [Repositories](repositories.md) (Concurrency). The standard use cases leave `version` out of their inputs, as any identity key, and `app.describe()` marks the entity `versioned: true`.

## Schema evolution

Three options describe how the stored shape of an entity changed, so that a repository still reads the rows written before. They are not record options: the entity keeps them, with `versioned` and `expires`, under the `EntitySettings` symbol.

- `schemaVersion`: the version of its stored shape, a positive integer (1 when absent). Every write stores it in the row under `$v` (`SCHEMA_VERSION_KEY`), which the blueprint of such an entity cannot declare.
- `upgrade`: `{ [version]: (data) => data }`, the steps that bring a stored row from the version before each key up to it.
- `previousNames`: the `name`s the entity had, whose rows `app.migrate` moves.

```ts
import { blueprintOf, entityOf } from "@afora/core";

class Article extends entityOf(
	blueprintOf((ctx) => ({
		title: ctx.text,
		slug: ctx.slug,
		locale: ctx.enumOf(["pt", "en"]).with({ fill: "pt" }),
	})),
	{
		name: "Article",
		previousNames: ["Entry"],
		schemaVersion: 2,
		upgrade: { 2: (data) => ({ ...data, slug: data.path }) },
	},
) {}
```

Invalid options throw `InvalidEntitySchemaVersion`. `app.describe().entities.<Name>` gives `schemaVersion`, `upgrade` (the versions with a step) and `previousNames` when declared. See [Schema evolution](schema-evolution.md), with the `fill` and `renamedFrom` options of a property.
