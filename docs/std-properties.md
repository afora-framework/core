# Standard properties and plugins

`@afora/core` ships the properties most domains need, and five record plugins built on them. A blueprint picks a property from its context (`ctx.email`), and the same class is exported for use on its own (`Email`). How a property works, and how to write one, is in [Properties](properties.md); how a plugin works is in [Records](records.md#plugins).

```ts
import { blueprintOf, Email, entityOf } from "@afora/core";

const UserBlueprint = blueprintOf((ctx) => ({
	email: ctx.email,
	name: ctx.text({ max: 80 }),
	role: ctx.enumOf(["reader", "editor"]),
	bio: ctx.optional.text,
	tags: ctx.list.string,
}));

class User extends entityOf(UserBlueprint, {
	plugins: (ctx) => [ctx.ownable],
}) {}

new Email(" Jane@Example.COM ").value; // "jane@example.com"
User.options.unique; // ["id"]
```

`ctx.optional.<name>` accepts `undefined` as well, `ctx.list.<name>` is a list of the property (and `ctx.list.optional.<name>` an optional list), and `ctx.<name>(options)` narrows it, as [`Property.with`](properties.md) does.

## Properties

Every property first checks the type of the value (a string where a string is expected), then runs its handler, then validates the result against its schema. The **demo** column is the value `Property.demo()` gives, which [codegen](../packages/codegen/README.md), the OpenAPI examples and tests use.

### Identity and contact

| Context     | Class   | Accepts                                                       | Normalizes                                            | Flags  | Demo                                   |
| ----------- | ------- | ------------------------------------------------------------- | ----------------------------------------------------- | ------ | -------------------------------------- |
| `ctx.id`    | `Id`    | a UUID v7                                                     | lower-cases it                                        |        | `01a173d2-051c-77bb-8166-a371e999573e` |
| `ctx.slug`  | `Slug`  | any text; stored as lower-case words joined by `-`, up to 255 | slugifies it: `"  Olá Mundo! "` becomes `"ola-mundo"` | unique | `demo-slug`                            |
| `ctx.email` | `Email` | an email address, up to 254 characters                        | trims and lower-cases it                              |        | `demo@example.com`                     |
| `ctx.phone` | `Phone` | a phone number in E.164 (`+` and up to 15 digits)             | drops spaces, dots, dashes and parentheses            |        | `+5511999999999`                       |
| `ctx.url`   | `Url`   | a URL, up to 2048 characters                                  | trims it                                              |        | `https://example.com`                  |
| `ctx.ip`    | `Ip`    | an IPv4 or IPv6 address                                       | trims it                                              |        | `127.0.0.1`                            |

`Id.generate()` makes a new id with the configured generator: a UUID v7 by default, time-ordered, so ids sort by creation on any runtime. An entity gets its `id` this way; [Runtime](runtime.md) explains how to replace the generator. `Slug` is `unique`, so a record lists every `Slug` key in `options.unique` and a repository gets `findBy<Key>` for it.

### Text, numbers and booleans

| Context       | Class             | Accepts                    | Normalizes | Demo    |
| ------------- | ----------------- | -------------------------- | ---------- | ------- |
| `ctx.string`  | `StringProperty`  | any string, empty included |            | `demo`  |
| `ctx.text`    | `Text`            | a string that is not blank | trims it   | `Demo`  |
| `ctx.number`  | `NumberProperty`  | any number                 |            | `0`     |
| `ctx.integer` | `Integer`         | an integer                 |            | `0`     |
| `ctx.boolean` | `BooleanProperty` | `true` or `false`          |            | `false` |

`Text` is the one for what a person types (a title, a name): `"  Hi "` becomes `"Hi"`, and `"   "` is rejected once trimmed. `StringProperty` keeps the value as it is. Narrow any of them with options: `ctx.text({ max: 80 })`, `ctx.integer({ min: 0 })`, `ctx.string({ pattern: /^[A-Z]{3}$/ })`.

### Dates and times

Dates are ISO 8601 strings, so they go to JSON, to a database and to OpenAPI as they are.

| Context         | Class          | Accepts                                      | Optional | Demo                       |
| --------------- | -------------- | -------------------------------------------- | -------- | -------------------------- |
| `ctx.date`      | `DateProperty` | a calendar date, `2026-01-01`                |          | `2026-01-01`               |
| `ctx.dateTime`  | `DateTime`     | a date and time, `2026-01-01T00:00:00.000Z`  |          | `2026-01-01T00:00:00.000Z` |
| `ctx.createdAt` | `CreatedAt`    | a date and time: when the record was created |          | `2026-01-01T00:00:00.000Z` |
| `ctx.updatedAt` | `UpdatedAt`    | a date and time: when it was last updated    | yes      | `2026-01-01T00:00:00.000Z` |
| `ctx.deletedAt` | `DeletedAt`    | a date and time: when it was soft-deleted    | yes      | none                       |

`DateTime`, `CreatedAt`, `UpdatedAt`, `DeletedAt` and `ExpiresAt` have `now()`, an instance holding the current date and time (`DateTime.now().value`). An [entity](entities.md) holds `createdAt`, `updatedAt` and `deletedAt` as part of its identity and sets them itself, so a blueprint does not declare them. `ExpiresAt` is not in the context: it is the key an entity declared with `expires: { after }` gets.

```ts
import { blueprintOf, CreatedAt, DateTime } from "@afora/core";

const Event = blueprintOf((ctx) => ({
	day: ctx.date,
	startsAt: ctx.dateTime,
	endsAt: ctx.optional.dateTime,
}));

Event.safeParse({ day: "2026-13-01", startsAt: DateTime.now().value }).issues;
// [{ path: ["day"], code: "invalid_value", message: 'must match format "date"', ... }]
CreatedAt.now().value; // "2026-11-11T13:13:07.116Z"
```

### Passwords

| Context        | Class           | Accepts                                | Flags     |
| -------------- | --------------- | -------------------------------------- | --------- |
| `ctx.password` | `Password`      | an argon2 hash, never a plain password | sensitive |
|                | `PlainPassword` | a password as a person types it        | sensitive |

A plain password has 7 to 128 characters, with a lower-case and an upper-case letter, a digit and a special character. `Password.hash(plain)` checks those rules (throwing `InvalidPropertyValue` with every rule broken) and hashes it with argon2id. `password.verify(plain)` tells whether a plain password matches the hash, and `password.verifySync(plain)` does it without waiting, on a hasher that can (it throws `SyncVerifyUnsupported` otherwise). Both properties are `sensitive`, so a record masks them in `toJSON`.

`Password` tells what derives inputs from an entity, as the [standard use cases](std-use-cases.md) and the HTTP providers do, to take a `PlainPassword` and store its hash: a caller sends the password as typed, and the repository stores `$argon2id$...`. Which hasher runs depends on the runtime: see [Runtime](runtime.md#password-hashing).

```ts
import { Password } from "@afora/core";

const password = await Password.hash("Secret@123");
password.value; // "$argon2id$v=19$m=65536,t=2,p=1$..."
await password.verify("Secret@123"); // true
await password.verify("secret"); // false
```

### JSON and schemas

| Context      | Class / factory  | Holds                                                              |
| ------------ | ---------------- | ------------------------------------------------------------------ |
| `ctx.json`   | `JsonProperty`   | any JSON value, typed `JsonValue`                                  |
| `ctx.jsonOf` | `jsonOf`         | JSON that a JSON Schema known at declaration accepts, typed by it  |
| `ctx.schema` | `SchemaProperty` | a JSON Schema (draft 2020-12) as a value, such as a content type's |

[Properties](properties.md#json) covers `JsonProperty`, `jsonOf` and `checkJsonSchema`. `SchemaProperty` holds a schema itself, defined at runtime: `serialize()` and `SchemaProperty.deserialize(json)` move it to and from JSON, and `match(data)` and `errors(data)` validate data against it.

```ts
import { SchemaProperty } from "@afora/core";

const shape = SchemaProperty.deserialize(
	'{ "type": "string", "minLength": 1 }',
);
shape.match("Hi"); // true
shape.match(""); // false
shape.serialize(); // '{"type":"string","minLength":1}'
```

### Enumerations

`ctx.enumOf(values, options?)` (`enumOf`) holds one of a list of strings or numbers, typed as their union; its demo is the first value unless `default` names another, and `{ optional: true }` accepts `undefined`. [Properties](properties.md) has the details.

```ts
import { enumOf } from "@afora/core";

const Status = enumOf(["draft", "published", "archived"], { name: "status" });
new Status("draft").value; // "draft", typed "draft" | "published" | "archived"
```

## Record plugins

A record plugin adds keys and behavior to a record or an entity. The five standard ones are exported (`Publishable`, `Archivable`, `Taggable`, `Ownable`, `Authenticatable`) and gathered in `StdRecordPlugins`, the catalog `recordOf` and `entityOf` pick from when `options.plugins` is a function:

```ts
import { blueprintOf, entityOf, Publishable, Taggable } from "@afora/core";

class Article extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text })),
	{ plugins: (ctx) => [ctx.publishable, ctx.taggable, ctx.archivable] },
) {}

// the same, with the exported plugins
class Page extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text })),
	{
		plugins: [Publishable, Taggable],
	},
) {}

const article = new Article({ title: "Hello" });
article.publish().tag("news", "tech");
article.isPublished; // true
article.hasTag("news"); // true
new Page({ title: "About" }).isPublished; // false
```

Every method that changes a key goes through the record's `set`, so on an entity it also sets `updatedAt` and queues the update event. The [standard use cases](std-use-cases.md) build on these plugins: `ctx.publish(Posts)` needs a publishable entity, `ctx.register(Users)` an authenticatable one.

| Plugin            | Context               | Keys                                     | Members                                          | Standard use cases                |
| ----------------- | --------------------- | ---------------------------------------- | ------------------------------------------------ | --------------------------------- |
| `Publishable`     | `ctx.publishable`     | `publishedAt?` (a `DateTime`)            | `publish(at?)`, `unpublish()`, `isPublished`     | `publish`, `unpublish`            |
| `Archivable`      | `ctx.archivable`      | `archivedAt?` (a `DateTime`)             | `archive(at?)`, `restore()`, `isArchived`        | `archive`, `unarchive`            |
| `Taggable`        | `ctx.taggable`        | `tags?` (a list of strings)              | `tag(...tags)`, `untag(...tags)`, `hasTag(tag)`  | `tag`, `untag`                    |
| `Ownable`         | `ctx.ownable`         | `ownerId` (an `Id`)                      | `isOwnedBy(id)`, `transferTo(id)`                | the `owner` option of any of them |
| `Authenticatable` | `ctx.authenticatable` | `email` (unique), `password` (sensitive) | `change.password(hash)`, `verifyPassword(plain)` | `register`, `login`               |

- **`Publishable`.** `publishedAt` is absent while the record is a draft. `publish(at?)` sets it, to now when `at` is not given, `unpublish()` clears it, and `isPublished` tells which.
- **`Archivable`.** `archivedAt` is absent while the record is active; `archive(at?)` sets it, `restore()` clears it, `isArchived` tells. It is not soft deletion: an archived entity is still found by every query, and an entity's own `deletedAt` is what `delete` sets on a soft-deleting repository.
- **`Taggable`.** `tag(...tags)` adds each tag the record does not have yet, so each tag is kept once; `untag(...tags)` removes them; `hasTag(tag)` tells.
- **`Ownable`.** `ownerId` is the id of who owns the record. `isOwnedBy(id)` compares it, whatever the case of `id`, and `transferTo(id)` changes it. The `owner` option of the standard use cases reads `ownerId` by default.
- **`Authenticatable`.** `email` is unique, so the repository gets `findByEmail`; `password` is a `Password`, a sensitive argon2 hash, changed by `change.password(hash)`. `verifyPassword(plain)` tells whether a plain password matches it.

```ts
import { blueprintOf, entityOf, Password } from "@afora/core";

class Account extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.text })),
	{ plugins: (ctx) => [ctx.authenticatable] },
) {}

const account = new Account({
	name: "Jane",
	email: "jane@example.com",
	password: (await Password.hash("Secret@123")).value as string,
});
await account.verifyPassword("Secret@123"); // true
account.toJSON().password; // "********"
Account.options.unique; // ["id", "email"]
```

A plugin of your own is made with `recordPluginOf` and can join a catalog of its own next to these: see [Records](records.md#plugins).
