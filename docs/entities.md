# Entities

An entity is a record with identity, ready to persist. `entityOf` takes a blueprint and the options of `recordOf`, and adds four keys to it, from `std`:

- `id`: an `Id` (UUID v7), generated when the value has none and always listed in `options.unique`.
- `createdAt`: generated as now when the value has none.
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

The identity keys are read-only: `set` throws `ImmutableEntityKey` for them, and they get no `change.<key>` method. The blueprint cannot declare them, nor the members of an entity (`destroy`, `isDeleted`, `equals`, `onDestroy`, `emit`, `pullEvents`): `entityOf` throws `ReservedEntityKey`. `user.equals(other)` compares entities of the same declaration by `id`. `isEntityClass` and `isEntity` tell entities apart from records. `entityBuilderOf({ identity, generateId, now })` makes an `entityOf` with your own identity fields and clock.

Entities can queue domain events for an external consumer. `eventOf` accepts an entity class (including subclasses) and an async handler returning `Promise<void>`, called with the entity and `{ logger }` (the logger of the application whose command raised the event; see [Logging](logging.md)); `event.handle({ logger })` can give another. Definitions are immutable; incompatible entity instances are rejected when emitting.

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

`emit` is protected and synchronous: it queues without executing the handler. `pullEvents()` immediately empties that instance's queue and returns occurrences with `name`, `entity`, and `handle(): Promise<void>`, in emission order, including duplicates. Each occurrence references the original entity and sees its state when handled, without making a snapshot. Events are excluded from `toJSON()` and JSON serialization. Records have no event API.

Each lifecycle option accepts a definition, a readonly list, or a function returning either. Functions are resolved only during their cycle, so definitions may follow the entity class but must exist before constructing instances. `onCreate` queues after base construction and validation only when **both** input `id` and `createdAt` are `undefined`. Supplying either identity field, as when loading persisted data, suppresses creation; parsing plain input follows the same rule. `onUpdate` queues after each valid `set` (including `change.<key>` and equal values) stores the value and `updatedAt`, before `onSetAll` and `onSet`. `onDelete` queues after `deletedAt` is stored, before `onDestroy`. Invalid operations and repeated deletion do not queue lifecycle events. If an existing hook throws after a mutation, its queued events remain.

The consuming layer decides when to drain and execute events. `handle()` propagates handler failures and can be called more than once. There is no automatic execution, dispatcher, retry, or execution-once guarantee.
