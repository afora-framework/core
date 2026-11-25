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
| `ctx.url`   | `Url`   | a URL, up to 2048 characters, not `javascript:` and the like  | trims it                                              |        | `https://example.com`                  |
| `ctx.ip`    | `Ip`    | an IPv4 or IPv6 address                                       | trims it                                              |        | `127.0.0.1`                            |

`Url` accepts a URL of any protocol (`https:`, `postgres:`, `redis:`, `mailto:`...) but `javascript:`, `data:`, `vbscript:` and `file:`, which run script or read local files in a link. They are rejected however they are written, as the URL parser reads the protocol: in any case (`JaVaScRiPt:`), after leading spaces and control characters, and with tabs or newlines inside (`java\tscript:`). `Url.with({ protocols })` accepts only the protocols it lists instead, each with its colon, and keeps the other options of `with`: `Url.with({ protocols: ["https:"] })` for a link that must be a web page, `Url.with({ protocols: ["https:", "mailto:"] })`, or `Url.with({ protocols: ["data:"] })` to accept `data:` URLs. A protocol that is not a scheme (`"https"`, without its colon) throws `InvalidUrlOptions` when the class is declared. The protocols are checked by a `pattern` in the schema, so OpenAPI documents them.

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

[Properties](properties.md#json) covers `JsonProperty`, `jsonOf` and `checkJsonSchema`. `SchemaProperty` holds a schema itself, defined at runtime: `serialize()` and `SchemaProperty.deserialize(json)` move it to and from JSON, and `match(data)` and `errors(data)` validate data against it. A schema nested more than 128 JSON levels deep (the root is the first; `{ "type": "object", "properties": { "a": {...} } }` takes two per object) is rejected (`is nested too deeply`, with the path), by `safeParse`, the constructor and `deserialize`, so that checking data against a stored schema stays quick and within the stack on every runtime. For the same reason, the cost of checking against it is bounded when it is accepted, and a schema is rejected with the path and the reason when:

- a `$ref` is not a JSON Pointer into the schema itself (`#`, `#/$defs/address`) that resolves to a schema, or a chain of `$ref`s comes back to a schema it went through (a recursive schema, `{ "$ref": "#" }` under `properties` included); `$dynamicRef`, `$recursiveRef` and a `$id` below the root are not taken;
- it expands to more than 20000 schemas, each use of a `$ref` counted as a copy of what it refers to (`$defs` that refer twice to the one before, `allOf` or `anyOf`, double at each level);
- a `pattern` (or a key of `patternProperties`) is not a valid regular expression (with the `u` flag, as it is checked), or holds what can make matching take time exponential in the length of the string: a group repeated by `*`, `+` or `{n,m}` that holds a quantifier or an alternation (`^(a+)+$`, `(a|b)*`, `(-[a-z]+)*`), a backreference (`\1`, `\k<name>`) or a lookaround, or more than 4 quantifiers that vary (`*`, `+`, `?`, `{n,m}`). Write a slug as `^[a-z0-9-]+$` rather than `^[a-z0-9]+(-[a-z0-9]+)*$`. A pattern that is accepted still takes time that grows with the length of the string (polynomially), so give strings a `maxLength` and limit the size of request bodies.

[Properties](properties.md#json) applies the same rules to the schema given to `checkJsonSchema` and `jsonSchemaIssues`.

```ts
import { SchemaProperty } from "@afora/core";

const shape = SchemaProperty.deserialize(
	'{ "type": "string", "minLength": 1 }',
);
shape.match("Hi"); // true
shape.match(""); // false
shape.serialize(); // '{"type":"string","minLength":1}'
```

### Files

| Context      | Class / factory | Holds                                                                                       |
| ------------ | --------------- | ------------------------------------------------------------------------------------------- |
| `ctx.file`   | `FileProperty`  | any file (a `File`, or any `Blob`), of any type and size                                    |
| `ctx.fileOf` | `fileOf`        | a file of the media `types` given (`"image/*"` takes any image but SVG), at most `maxBytes` |

A file is what a `multipart/form-data` body sends: an [HTTP sink](outputs.md) reads one for an input that holds a file, and the OpenAPI document describes it as `type: "string", format: "binary"` (with `contentMediaType` when one exact type is accepted). The value is checked to be a `Blob`, its type (without parameters, case aside) to be one of `types`, and its size to be at most `maxBytes`. The type is the one the client declares, not what the bytes are: the [HTTP sinks](outputs.md) also check that a file declared as a PNG, JPEG, GIF, WebP or AVIF starts as one, and a wildcard never takes `image/svg+xml` (a document that can carry scripts), which only its own name in `types` does. Anything else throws `InvalidFile`, whose message is the issue's (`Expected a file`, `Expected a file of type image/png, not "text/plain"`, `Expected a file of at most 5000000 bytes, not 6000000 bytes`), at the key of the file. Options that are not media types or a size throw `InvalidFileOptions` when the property is declared. The file is kept as it is: never read, copied or frozen, so a use case streams it to storage (`file.stream()`, `await file.arrayBuffer()`). A file cannot be `sensitive` or `unique` (`recordOf` throws `InvalidRecordDeclaration`), and an entity cannot hold one, at any depth (`EntityHoldsFile`): an entity is stored, a file is not, so store where the file went (a URL, a storage key). A record's `toJSON` gives the file as it is, and `JSON.stringify` writes a `Blob` as `{}`: respond with what you made of it (a URL, `{ name, type, size }`), not the file. The demo value is an empty file of the first type, made when it is asked for (no `File` is made when a module loads).

```ts
import { blueprintOf } from "@afora/core";

const UploadMedia = blueprintOf((ctx) => ({
	file: ctx.fileOf({
		types: ["image/png", "image/jpeg", "image/webp"],
		maxBytes: 5_000_000,
	}),
	folder: ctx.optional.string,
}));
```

### Money

| Context     | Factory   | Holds                                                                                                  |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `ctx.money` | `moneyOf` | an amount of money as an integer of minor units: alone for one `currency`, else `{ amount, currency }` |

An amount is held as an integer of the minor unit of its currency (cents for `BRL` and `USD`, yen for `JPY`), so no floating point ever rounds it: `1999` is R$ 19.99. `ctx.money({ currency: "BRL" })` is an amount in one currency, and its value, on the wire and in a record, is the integer alone (typed `number`). `ctx.money({ currency: ["BRL", "USD"] })` is an amount that carries one of the currencies listed, and `ctx.money()` one that carries any: the value is `{ amount, currency }` (`MoneyValue`, typed with the codes listed). A currency is an ISO 4217 code checked by its form, three upper-case letters (`"brl"` is rejected, not upper-cased), and by the list when there is one; no table of every currency ships with the library.

`min` and `max` bound the amount, in minor units, and `nonNegative: true` rejects an amount below zero; an amount is always a safe integer (`Number.isSafeInteger`), so a larger one is rejected rather than rounded. `ctx.optionalOf(ctx.money(...))` (`optionalOf(moneyOf(...))`) accepts `undefined`, `ctx.listOf(ctx.money(...))` is a list, and `name` names the property. A value that is not an integer, a currency that is not accepted, a key missing or one more than `amount` and `currency` give `invalid_value` issues, at the key of the amount or below it (`["total", "amount"]`). Options that are not valid (a currency such as `"R$"`, a bound that is not an integer, a `min` above `max`) throw `InvalidMoneyOptions` when the property is declared. The demo value is 0, or the bound closest to it, in the first currency listed (`USD` when none is).

`currencyDecimals(code)` gives the decimals of a currency in ISO 4217, what its minor unit is: 2 for any code but a few, 0 for `BIF`, `CLP`, `DJF`, `GNF`, `ISK`, `JPY`, `KMF`, `KRW`, `PYG`, `RWF`, `UGX`, `UYI`, `VND`, `VUV`, `XAF`, `XOF` and `XPF`, 3 for `BHD`, `IQD`, `JOD`, `KWD`, `LYD`, `OMR` and `TND`, and 4 for `CLF` and `UYW`. The property only checks and holds a value: no arithmetic, rounding, formatting or exchange. `MoneyOptions` is what `moneyOf` takes, and `TMoney` the schema of an amount that carries its currency; [OpenAPI](openapi.md) describes how both forms are documented.

```ts
import { blueprintOf, currencyDecimals, moneyOf } from "@afora/core";

const Price = moneyOf({ currency: "BRL", nonNegative: true });

const Order = blueprintOf((ctx) => ({
	subtotal: Price,
	tip: ctx.optionalOf(ctx.money({ currency: "BRL" })),
	total: ctx.money({ currency: ["BRL", "USD"], max: 10_000_000 }),
}));

Order.safeParse({ subtotal: 1999, total: { amount: 2199, currency: "USD" } });
// { value: { subtotal: 1999, total: { amount: 2199, currency: "USD" } } }
Order.safeParse({ subtotal: 19.99, total: { amount: 2199, currency: "EUR" } })
	.issues;
// [{ path: ["subtotal"], code: "invalid_value", message: "must be integer", ... },
//  { path: ["total", "currency"], code: "invalid_value", ... }]
currencyDecimals("JPY"); // 0
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
| `Ownable`         | `ctx.ownable`         | `ownerId` (an `OwnerId`)                 | `isOwnedBy(id)`, `transferTo(id)`                | the `owner` option of any of them |
| `Authenticatable` | `ctx.authenticatable` | `email` (unique), `password` (sensitive) | `change.password(hash)`, `verifyPassword(plain)` | `register`, `login`               |

- **`Publishable`.** `publishedAt` is absent while the record is a draft. `publish(at?)` sets it, to now when `at` is not given, `unpublish()` clears it, and `isPublished` tells which.
- **`Archivable`.** `archivedAt` is absent while the record is active; `archive(at?)` sets it, `restore()` clears it, `isArchived` tells. It is not soft deletion: an archived entity is still found by every query, and an entity's own `deletedAt` is what `delete` sets on a soft-deleting repository.
- **`Taggable`.** `tag(...tags)` adds each tag the record does not have yet, so each tag is kept once; `untag(...tags)` removes them; `hasTag(tag)` tells.
- **`Ownable`.** `ownerId` is the id of who owns the record, an `OwnerId`: the id of an entity of any id strategy (text of 1 to 256 characters, a UUID kept in lower case, or a positive integer). `isOwnedBy(id)` compares it, a UUID whatever its case and a number by value (`1` and `"1"` are the same owner), and `transferTo(id)` changes it. The `owner` option of the standard use cases reads `ownerId` by default.
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
