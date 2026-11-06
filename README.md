# afora

Domain modeling on [TypeBox](https://github.com/sinclairzx81/typebox): entities with invariants, sensitive data masking and exceptions that know their layer, usable by any [Standard Schema](https://standardschema.dev) consumer.

afora is not a general-purpose validator. It is for code that models a domain, and it plugs into the validators your framework already accepts.

- **Records with invariants.** Properties (`Email`, `Slug`, `Password`, your own) validate and normalize every value; blueprints compose them; a record (`class User extends recordOf(...)`) holds the handled value and rejects undeclared keys at any depth.
- **Sensitive data masking.** A property declared `sensitive` (`Password`) is masked by `toJSON()` at any depth, so `JSON.stringify(user)` cannot leak it.
- **Entities, repositories and use cases.** `entityOf` adds identity, timestamps and domain events; `repositoryOf` generates typed `findBy<Key>` methods for the keys in `options.unique` and enforces them; use cases inject repositories and environments and can override them per call.
- **Typed change namespace and side effects.** `change: ["password"]` generates `change.password(value)` (also destructurable, as `const { change } = user`), which re-validates the value and runs `onSetAll` and `onSet`.
- **Exceptions that know their layer.** Each error carries a layer (`Property`, `Record`, `UseCase`, `Output`...) and a `trace` that grows as it goes up.
- **Standard Schema V1 on every field.** Properties, blueprints, lists and record classes work as is in Hono, tRPC and TanStack Form, and `safeParse` never throws for an invalid value.

## Install

```bash
bun add @afora/core typebox   # or: npm install @afora/core typebox
```

Requirements: [Bun](https://bun.sh) >= 1.4.4 or Node.js >= 22. TypeBox (`typebox`, version `^1`) is a required peer dependency, shared with your application and afora's companion packages. The package ships ESM with TypeScript declarations; TypeScript >= 5.5 is an optional peer dependency.

`Password` hashes with argon2id: with `Bun.password` on Bun, with native `node:crypto` argon2 on a Node that has it (24.7+), and otherwise it throws `PasswordHasherRequired` until you call `configure({ hasher })`. `Id.generate()` makes a portable, monotonic UUID v7 on any runtime. afora imports no `node:crypto` (or `Buffer`) at load, so it loads in browsers and Workers; the native hasher is looked up on first use through `process.getBuiltinModule` (Node 22.3+). The native hasher derives argon2 version 19 only; a hash of another version throws `UnsupportedPasswordHash` (verify it with `Bun.password`, or `configure({ hasher })`).

```ts
import { configure, type PasswordHasher } from "@afora/core";

const hasher: PasswordHasher = {
	hash: (plain) => myArgon2.hash(plain),
	verify: (plain, hash) => myArgon2.verify(plain, hash),
	verifySync: (plain, hash) => myArgon2.verifySync(plain, hash), // optional; `Password.verifySync` throws without it
};
configure({ hasher, idGenerator: () => myUuidV7() }); // both optional; `resetRuntime()` restores the defaults
```

## Quick start

A `User` record created from an HTTP body through Standard Schema, saved by a repository that reads `User.options.unique`, returned with its password masked; and an error that keeps the layers it crossed. This is the code of `examples/interop/quickstart.ts`, run by `bun run test:interop` (there the import is the local source instead of `"@afora/core"`).

```ts
import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";
import {
	blueprintOf,
	ExceptionLayers,
	exceptionOf,
	guard,
	listOf,
	Password,
	recordOf,
	type StandardSchemaV1,
} from "@afora/core";

// Domain: a record with invariants, a sensitive key and unique intent
const Address = blueprintOf((ctx) => ({ street: ctx.string, zip: ctx.string }));

const UserBlueprint = blueprintOf((ctx) => ({
	email: ctx.email, // trimmed and lowercased
	slug: ctx.slug, // slugified; unique by declaration
	password: ctx.password, // only an argon2 hash is accepted; always masked
	address: Address,
	tags: listOf(ctx.string, { maxItems: 5 }),
}));

export class User extends recordOf(UserBlueprint, {
	unique: ["email"], // `slug` is unique already, as a Slug
	change: ["password"], // generates change.password(value)
}) {}

// Input: the HTTP body carries a plain password, which never enters the record
const SignUpBody = blueprintOf((ctx) => ({
	email: ctx.email,
	slug: ctx.slug,
	plainPassword: ctx.string,
	address: Address,
	tags: listOf(ctx.string, { maxItems: 5 }),
}));

// Repository: enforces what User.options.unique declares
const UserAlreadyExists = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "UserAlreadyExists",
	message: "A user with this email or slug already exists.",
});

class UserRepository {
	readonly #users: User[] = [];

	save(user: User): User {
		for (const key of User.options.unique) {
			if (this.#users.some((saved) => saved[key] === user[key])) {
				throw new UserAlreadyExists({ source: "UserRepository" });
			}
		}
		this.#users.push(user);
		return user;
	}
}

// Use case and HTTP route
const users = new UserRepository();

async function signUp({ plainPassword, ...data }: SignUpData) {
	const password = await Password.hash(plainPassword);
	return users.save(new User({ ...data, password: password.value }));
}

export const app = new Hono().post(
	"/users",
	sValidator("json", SignUpBody), // any Standard Schema consumer works the same
	async (c) => {
		const user = await signUp(c.req.valid("json"));
		return c.json(user.toJSON(), 201); // the password comes out masked
	},
);

// Errors keep the layers they crossed
export function changePassword(user: User, value: string) {
	return guard(
		{ layer: ExceptionLayers.Output, source: "PATCH /password" },
		() =>
			guard({ layer: ExceptionLayers.UseCase, source: "ChangePassword" }, () =>
				user.change.password(value),
			),
	);
}

type SignUpData = StandardSchemaV1.InferOutput<typeof SignUpBody>;
```

What it does:

```ts
// POST /users with { email: "  Jane@Example.COM ", slug: "Olá Mundo", plainPassword: "Str0ng!Pass", ... }
// 201 { "email": "jane@example.com", "slug": "ola-mundo", "password": "********", ... }
// the same slug again: UserAlreadyExists (layer "repository"), thrown by the repository

// a body with email "nope" and tags "x": 400 from the validator, with the issues
// [{ path: ["email"], code: "invalid_value", ... }, { path: ["tags"], code: "invalid_type", ... }]

changePassword(user, "plain text"); // not an argon2 hash, so it throws; exception.trace is:
// property:password -> record:User -> use-case:ChangePassword -> output:PATCH /password
```

## Standard Schema

Every field implements Standard Schema V1 (`vendor: "afora"`), so any library that takes one (Hono, tRPC, TanStack Form...) takes it as is. `validate` is synchronous, never throws for an invalid value, and reports every issue with its `path` (e.g. `["addresses", 0, "zip"]`).

| Field                                                              | `~standard.validate` gives                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| property class (`Slug`, `propertyOf`, `optionalOf(Property)`)      | the handled value: `Slug` turns `"Olá Mundo"` into `"ola-mundo"`                   |
| blueprint (and `optionalOf(blueprint)`, which accepts `undefined`) | the handled object, nested records as instances                                    |
| list (`listOf`)                                                    | a frozen array of the handled items                                                |
| record class (`recordOf`, subclasses included)                     | an instance of the class; a plain object for a nested record field becomes one too |

```ts
import { sValidator } from "@hono/standard-validator";
import { FieldApi, FormApi } from "@tanstack/form-core"; // see examples/interop for the full setup
import { initTRPC } from "@trpc/server";
import { Hono } from "hono";
import { blueprintOf, Email, listOf, recordOf } from "@afora/core";

const Address = blueprintOf((ctx) => ({ street: ctx.string, zip: ctx.string }));
const UserBlueprint = blueprintOf((ctx) => ({
	name: ctx.string,
	email: ctx.email,
	slug: ctx.slug,
	addresses: listOf(Address),
}));
class User extends recordOf(UserBlueprint) {}

// Hono: `c.req.valid("json")` is the handled object; an invalid body is a 400 with the issues
new Hono().post("/users", sValidator("json", UserBlueprint), (c) =>
	c.json(c.req.valid("json")),
);

// tRPC: the resolver gets a `User`; an invalid input is `BAD_REQUEST`, its cause holding the issues
const t = initTRPC.create();
t.procedure.input(User).mutation(({ input }) => input.name);

// TanStack Form: a property validates a field, a blueprint validates the form
new FieldApi({ form, name: "email", validators: { onChange: Email } });
new FormApi({ defaultValues, validators: { onChange: UserBlueprint } });
```

Without a framework, `safeParse` (on properties, blueprints and record classes) takes `unknown` and returns `{ value }` or `{ issues }`, never both and never throwing for an invalid value:

```ts
const result = UserBlueprint.safeParse(body);
if (result.issues) {
	for (const issue of result.issues) {
		console.log(issue.path, issue.code, issue.message); // ["addresses", 0, "zip"] "invalid_value" ...
	}
} else {
	result.value; // handled and frozen
}
```

`code` is one of `required`, `invalid_type`, `invalid_value`, `undeclared_key`, `too_few_items`, `too_many_items` and `not_record`; `source` names who rejected the value, and for a property issue `cause` keeps the exception it raised.

`Record.safeParse` builds the instance through the class constructor, so a subclass that normalizes its input, or throws its own exception, is honored: what `new User(value)` accepts, `User.safeParse(value)` accepts, and an error thrown by the constructor becomes an issue (code `invalid_value`, path `[]`) instead of escaping. An instance of the class is returned as it is.

The input type is that of the blueprint (a record field takes an instance or a plain object). `StandardSchemaV1.InferOutput<typeof User>` is the instance type of the class `recordOf` returns. For a subclass that adds members (`class User extends recordOf(...) { get initials() {} }`) that is the base record instance type, because TypeScript cannot type the statics of a subclass; at runtime the value is an instance of the subclass, so narrow it with `instanceof User`. Each class has one stable `~standard` object.

The real-library tests (Hono, tRPC, TanStack Form) are in `examples/interop`: `bun run test:interop`.

## OpenAPI

`toOpenAPI` turns any field (a property, blueprint, list, record or entity) into an OpenAPI 3.1 schema, which is plain JSON Schema. Given named models, it gives the `components` of a document, and a record named among them is a `$ref` wherever another model holds it:

```ts
import { blueprintOf, entityOf, toOpenAPI } from "@afora/core";

const User = entityOf(
	blueprintOf((ctx) => ({
		name: ctx.text({ max: 80, description: "Full name" }),
		email: ctx.email({ examples: ["jane@example.com"] }),
		password: ctx.password,
	})),
);
const Post = entityOf(
	blueprintOf((ctx) => ({ title: ctx.text, author: User })),
);

toOpenAPI(User); // { type: "object", properties: { id: {..., readOnly: true }, ... } }

const document = {
	openapi: "3.1.0",
	info: { title: "Blog", version: "1.0.0" },
	paths: {},
	components: toOpenAPI({ User, Post }), // Post.author is { $ref: "#/components/schemas/User" }
};
```

What `Property.with` (or `ctx.<property>(options)`) gives, `description`, `examples`, bounds and the rest, is kept. Sensitive keys (`Password`, `options.sensitive`) are `writeOnly`, the identity of an entity (`id`, `createdAt`, `updatedAt`, `deletedAt`) is `readOnly`, optional keys are left out of `required`, and every object has `additionalProperties: false`, since blueprints reject undeclared keys. Records not named among the models are inline; `refPrefix` changes where a `$ref` points (`"#/components/schemas/"` by default). A model that is not a field throws `InvalidOpenAPIModel`.

## Concepts

### Properties

A property is a class that validates and normalizes one value, through `preHandle -> validation -> afterHandle`; the current step is exposed on `property.definition[State]`.

```ts
import { Type } from "typebox";
import { propertyOf } from "@afora/core";

const Name = propertyOf({
	name: "name",
	schema: Type.String({ minLength: 3 }),
	preHandle: (value) => value.trim(),
	default: "Jane", // used by Name.demo()
});

new Name("  Alice ").value; // "Alice"
new Name("a"); // throws: Invalid value for property "name": ...
Name.demo().value; // "Jane"
```

Pass `optional: true` to accept `undefined`, `sensitive: true` to have records mask it (as `Password` does) and `unique: true` to have records list its key in `options.unique` (as `Slug` does). `Std` ships `Id`, `Slug`, `Email`, `Phone`, `Url`, `Ip`, `Password`, strings, numbers, booleans and date properties.

`Property.with(options)` gives a subclass narrowed and documented by `options`. In a blueprint, every property of the context can be called for the same thing, as `ctx.number({ min: 1 })`; used as it is, `ctx.number` is still the class:

```ts
import { blueprintOf, Integer } from "@afora/core";

const Age = Integer.with({ min: 0, max: 150, description: "In years" });

const Product = blueprintOf((ctx) => ({
	name: ctx.text({ max: 80, description: "Shown in the catalog" }),
	price: ctx.number({ min: 1, examples: [1990] }),
	sku: ctx.string({ pattern: /^[A-Z]{3}-\d{4}$/, examples: ["MUG-0001"] }),
	stock: ctx.optional.integer({ min: 0 }),
	status: ctx.enumOf(["draft", "published"]).with({ deprecated: true }),
}));

Product.schema.toString(); // JSON Schema, with each description, example and bound
```

Every property takes `title`, `description`, `examples`, `deprecated`, `readOnly` and `writeOnly`, which go to its JSON Schema as they are (for OpenAPI and other docs) and change nothing in validation, and `default`, its demo value, which is not written to the schema; without `default`, the first of `examples` is the demo. Strings also take `min` and `max` (`minLength`/`maxLength`) and `pattern` (a string or a `RegExp`, whose flags are not kept); numbers and integers take `min`, `max`, `exclusiveMin`, `exclusiveMax` and `multipleOf`. Constraints only narrow a property: `ctx.text({ min: 0 })` keeps the `minLength: 1` of `Text`, and a pattern given to `Phone` is checked along with its own, under `allOf`. Handlers, flags (`sensitive`, `unique`) and statics are kept, so `ctx.id({ description })` still has `generate()` and `ctx.slug({ max: 40 })` is still unique. Factories such as `ctx.enumOf` return a class, so use `.with` on what they return.

`enumOf` declares a property that holds one of a list of strings or numbers; its demo is the first value unless `default` is given. In a blueprint it is `ctx.enumOf`:

```ts
import { blueprintOf, enumOf } from "@afora/core";

const Status = enumOf(["draft", "published"], { name: "status" });

new Status("draft").value; // "draft", typed "draft" | "published"
new Status("archived"); // throws: Invalid value for property "status": ...

const Post = blueprintOf((ctx) => ({
	status: ctx.enumOf(["draft", "published"]),
	tags: ctx.listOf(ctx.enumOf(["news", "tech"]), { minItems: 1 }),
	level: ctx.optionalOf(ctx.enumOf([1, 2, 3])), // or ctx.enumOf([1, 2, 3], { optional: true })
}));
```

### Blueprints

A blueprint picks properties from `Std` and its sources, plugins or other blueprints. A key can also hold another blueprint, validated as a nested object, and `join` merges blueprints:

```ts
import { blueprintOf, listOf, optionalOf } from "@afora/core";

const Address = blueprintOf((ctx) => ({ street: ctx.string, zip: ctx.string }));
const Timestamps = blueprintOf((ctx) => ({ createdAt: ctx.createdAt }));

const User = blueprintOf((ctx) => ({
	name: ctx.string,
	address: Address, // nested object
	billing: optionalOf(Address), // optional nested object
	addresses: listOf(Address), // array of nested objects
	tags: listOf(ctx.string, { maxItems: 5 }), // array of values
}));

const Admin = blueprintOf([User], (ctx) => ({
	name: ctx.name, // picked from User
	role: ctx.string,
}));

const Customer = User.join(Timestamps); // every field of both
```

`ctx.optional.*` and `ctx.list.*` mirror every field: `ctx.list.string` is `listOf(ctx.string)` and `ctx.list.optional.string` an optional list of strings. Every context also has `ctx.listOf`, `ctx.optionalOf` and `ctx.propertyOf`, the same functions as the exports, to make fields inline: `ctx.listOf(ctx.string, { maxItems: 5 })`, `ctx.optionalOf(Address)`. `optional`, `list`, `listOf`, `optionalOf` and `propertyOf` are reserved, so no plugin can declare them. Factories such as `ctx.enumOf` are not mirrored under `optional` and `list`, which would lose their literal types; wrap what they return in `ctx.listOf` or `ctx.optionalOf`.

`join` takes any number of blueprints (`A.join(B, C)` is `A.join(B).join(C)`); a later one replaces a key of an earlier one, like plugins do. `listOf` takes a property, a blueprint or another list, and `optionalOf` makes it an optional key.

`blueprintOf` is `blueprintBuilderOf(Std)`. To build blueprints from other properties, without `Std`, make a builder of your own:

```ts
import { blueprintBuilderOf, blueprintPluginOf } from "@afora/core";

const contentBlueprintOf = blueprintBuilderOf(
	blueprintPluginOf("content", { title: Title, body: Body }),
);
const Post = contentBlueprintOf((ctx) => ({
	title: ctx.title,
	body: ctx.body,
}));
```

A plugin can also take factories, functions that make a field from their arguments, as `Std` does with `enumOf`: `blueprintPluginOf("content", { title: Title }, { enumOf })` gives `ctx.enumOf`. A factory replaces a field with the same name.

### Slicing

Slicing is experimental: it lives in `@afora/core/experimental`, may change in any release and is not covered by [`VERSIONING.md`](VERSIONING.md).

`sliceOf(blueprint, selector)` gives a new blueprint with only the fields `selector` names, recursively into nested blueprints, records and lists. Optional fields stay optional and lists stay lists. A property is kept with its flags (`sensitive`, `unique`, ...); a nested record stays a record, with the `sensitive`, `unique` and `change` keys it declares among the keys kept, so it still masks its sensitive keys and is still `writeOnly` in `toOpenAPI`. The selector is a mask, `true` keeping a field whole and an object keeping only its keys, or a blueprint or record class, whose keys, at any depth, are the mask.

```ts
import { sliceOf, sliceValue } from "@afora/core/experimental";

const Card = sliceOf(Person, { name: true, address: { city: true } });
const Same = sliceOf(Person, CardBlueprint); // keys of another blueprint or record class
```

A nested record or entity the selector names whole (`true`, or the same class in a blueprint or record selector) is kept as it is. One sliced to some of its keys becomes a plain record of those keys, not an entity: its identity keys (`id`, `createdAt`, ...) are in it only if the selector names them, and it has no events, `destroy` or plugin members. A sliced record field still accepts an instance of the original record.

A key the blueprint does not have is a type error and throws `UndeclaredBlueprintProperty`. The types `SliceMask` and `ValueMask` describe a selector mask, and `SlicedBlueprint` and `SlicedValue` the results.

`sliceValue(value, selector)` does the same to data: it strips the keys the selector does not name, through objects and lists, and does not validate. A record instance is read by its `toJSON`, so what is sensitive stays masked; a plain object is copied as it is. A key missing from the value is left out.

```ts
sliceValue(post, { title: true, author: { name: true } }); // { title, author: { name } }
```

### Records

A record implements a blueprint: it keeps the blueprint and a value of its shape, each key handled by its field (at any depth) and read as a member of the record (`user.name`). Its constructor takes the value inferred from the blueprint (and throws on an invalid one), the protected `set` changes one key, and `onSet` declares the side effect of a change to each key:

```ts
import { recordOf, type RecordEffects } from "@afora/core";

class User extends recordOf(UserBlueprint) {
	protected override onSet(): RecordEffects<User> {
		return {
			name: (value, previous) => console.log(`${previous} -> ${value}`),
		};
	}
}

const user = new User({
	name: " Jane ",
	address: { street: "Main St", zip: "01310-100" },
});
user.name; // "Jane"
user.blueprint; // UserBlueprint
```

A second argument describes the keys:

```ts
class Account extends recordOf(AccountBlueprint, {
	sensitive: ["token"], // masked in toJSON; a sensitive property (Password) always is, at any depth
	unique: ["email"], // listed for repositories to enforce; a unique property (Slug) key always is
	change: ["password"], // generates a typed change.password(value)
}) {}

Account.options; // { sensitive: ["token", "password"], unique: ["email"], change: ["password"] }
new Account(value).change.password(hash); // same as set("password", hash), returns the record
```

Keys are resolved in the order of the blueprint.

**Masking.** A key holding a property declared `sensitive`, such as `Password` (optional, or a list of them), is always sensitive. `toJSON` (and so `JSON.stringify`) replaces each leaf of a sensitive value (strings, numbers, booleans; objects and lists leaf by leaf) with `MASK` (`"********"`, the same whatever the length, so none leaks), and does the same for every `sensitive` property at any depth, inside nested blueprints and lists too. Reading a key still gives the real value (`account.password` is the hash, for `verify` and repositories).

**Uniqueness.** A key holding a property declared `unique`, such as `Slug` (optional or not), is always unique; a list of them is not, since uniqueness applies to a key's value. `unique` only records the intent: a record never compares itself with other records, so two records with the same `email` both build. `options.unique` names the keys a repository (or a unique index in the database) must enforce. `Slug` slugifies its value: `"  Olá Mundo! "` becomes `"ola-mundo"`.

**Changes.** The keys are read-only and only change through `set`, which only the record itself (or a `change.<key>` method) can call. `set` validates the value, stores it, then runs `onSetAll(change)` and then the effect of the key in `onSet`. `change` is `{ key, value, previous }`, and checking `change.key` narrows the rest (annotate it as `RecordChange<User>`).

**Rejections.** An invalid value throws in the `Record` layer, naming the key in `details` (e.g. `{ key: "address.zip" }`). So does a key the blueprint does not declare, at any depth, with `UndeclaredRecordProperty` (e.g. `{ key: "addresses.0.extra" }`): the value is rejected, never trimmed. A key cannot take the name of a member of the record (`set`, `toJSON`, `onSet`, `onSetAll` or, when the record has `change` keys, `change`), nor of one every object inherits (`toString`, `valueOf`, `hasOwnProperty`, `__proto__`... all of `Object.prototype`, listed in `RESERVED_RECORD_KEYS`): `recordOf` throws `ReservedRecordKey`. Nor can a class extending the record declare a member with the name of a key, which would hide it: its first record throws `ReservedRecordKey`.

**Spread caveat.** The value of a record lives in a `WeakMap`, and each key is a getter on the record's prototype, not an own property. So `Object.keys(user)` is `[]` and `{ ...user }` is `{}` (unless a subclass adds own properties). Metadata is available through `user[Meta].blueprint` and `user[Meta].options` (`Meta` is exported by `@afora/core`), or the class statics `User.blueprint` and `User.options`. The string keys `blueprint` and `options` are available for domain data. For plain data use `user.toJSON()` (frozen, sensitive values masked), or `blueprint.safeParse(value)` to handle plain input into a plain object. To build a record from another one, pass a plain object of its keys, rather than relying on enumeration of the record itself.

### Entities

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

Entities can queue domain events for an external consumer. `eventOf` accepts an entity class (including subclasses) and an async handler returning `Promise<void>`. Definitions are immutable; incompatible entity instances are rejected when emitting.

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


### Plugins

A plugin carries keys, options and behavior that records and entities share, with no identity of its own. It is made from a record class: the keys of its blueprint, its `sensitive`, `unique` and `change` keys, the methods and getters its class declares, and its `onSet` and `onSetAll`. A record or an entity lists plugins in `options.plugins`, and gets all of that:

```ts
import {
	blueprintOf,
	entityOf,
	hasPlugin,
	recordOf,
	recordPluginOf,
	type RecordEffects,
} from "@afora/core";

class SluggedRecord extends recordOf(
	blueprintOf((ctx) => ({ slug: ctx.slug })), // Slug: always unique
	{ change: ["slug"] },
) {
	get path(): string {
		return `/${this.slug}`;
	}

	protected override onSet(): RecordEffects<SluggedRecord> {
		return { slug: (value) => console.log(`moved to /${value}`) };
	}
}

export const Slugged = recordPluginOf("slugged", SluggedRecord, {
	version: "1.0.0",
});

class Post extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.string })),
	{ plugins: [Slugged] },
) {}

const post = new Post({ title: "Hi", slug: "Olá Mundo" });
post.path; // "/ola-mundo"
post.change.slug("hello"); // sets updatedAt, then logs "moved to /hello"
Post.options.unique; // ["id", "slug"]: repositories get findBySlug
hasPlugin(post, Slugged); // true, and narrows post to the plugin's record
```

- **Behavior.** The plugin's methods run on the record they are applied to, so `this.set` is that record's (an entity's sets `updatedAt` and queues `onUpdate`). Its `onSetAll` and `onSet` effects run for changes to its keys, before those of the record. The constructor of the plugin's class does not run for the record, and its methods cannot use private (`#`) members.
- **Conflicts.** A plugin key or member cannot be one the record, or another plugin, already has (an entity's identity included): declaring the record throws `RecordPluginConflict`. Nor can two different plugins share a name. A plugin's class cannot replace a member every record has (`toJSON`, `set`...), and cannot be an entity (plugins have no identity): `recordPluginOf` throws `InvalidRecordPlugin`.
- **Composition.** A plugin's class can declare plugins itself: they are applied with it, each once, and listed in `plugin.requires`. `Post.plugins` lists them all.
- **Tracking.** `hasPlugin(value, plugin)` (or `plugin.is(value)`) tells a record, an entity or a class of them having the plugin, through `requires` and subclasses too. `hasPlugin(value, "slugged")` checks by name. `pluginsOf(value)` lists them.

**Standard plugins.** `recordOf` and `entityOf` pick from the plugins of `StdRecordPlugins` when `options.plugins` is a function, the way `blueprintOf` picks from `Std`:

```ts
class Article extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.string })),
	{
		plugins: (ctx) => [ctx.publishable, ctx.taggable, ctx.ownable],
	},
) {}
```

| Plugin            | Keys                                     | Adds                                             |
| ----------------- | ---------------------------------------- | ------------------------------------------------ |
| `publishable`     | `publishedAt?`                           | `publish(at?)`, `unpublish()`, `isPublished`     |
| `archivable`      | `archivedAt?`                            | `archive(at?)`, `restore()`, `isArchived`        |
| `taggable`        | `tags?` (strings)                        | `tag(...tags)`, `untag(...tags)`, `hasTag(tag)`  |
| `ownable`         | `ownerId` (an `Id`)                      | `isOwnedBy(id)`, `transferTo(id)`                |
| `authenticatable` | `email` (unique), `password` (sensitive) | `change.password(hash)`, `verifyPassword(plain)` |

Your own catalog is `recordPluginCatalogOf(Slugged, ...StdRecordPlugins.list)`, given to `recordBuilderOf(catalog)` or to `entityBuilderOf({ ..., plugins: [catalog] })`. A later catalog replaces a plugin of an earlier one that has the same name.

**Serialization.** A plugin is a descriptor in JSON (`plugin.toJSON()`): its name, version, keys, `sensitive`, `unique` and `change` keys, member names and requirements. Methods are listed by name, never serialized as code, so a catalog resolves a descriptor back to the plugin that implements it:

```ts
const json = JSON.stringify(Post.plugins);
// [{"kind":"record-plugin","name":"slugged","version":"1.0.0","keys":["slug"],...}]

const plugins = catalog.resolveAll(JSON.parse(json));
class Rebuilt extends entityOf(PostBlueprint, { plugins }) {}

catalog.resolve("slugged"); // by name
catalog.resolve("slugged@1.0.0"); // by name and version
```

`resolve` throws `UnknownRecordPlugin` when the catalog has no plugin of that name. It throws `IncompatibleRecordPlugin` when the catalog's plugin does not satisfy the reference: a different major version (minor, below `1.0.0`), an older version, or keys, options, members or requirements the descriptor lists that it no longer has. Typing is lost once plugins go through JSON, since they are only known at runtime.

### UseCases

`useCaseOf` declares an abstract operation with input and response blueprints and a collection of concrete UseCase classes as dependencies. This combines the **Command** pattern (an instance holds the operation's arguments) with **method injection** (dependency functions are supplied to `execute`).

```ts
import { blueprintOf, entityOf, useCaseOf } from "@afora/core";

const UserInput = blueprintOf((ctx) => ({ name: ctx.string }));
class User extends entityOf(UserInput) {}
const UserResponse = blueprintOf(() => ({ user: User }));

class CreateUser extends useCaseOf({
	name: "CreateUser",
	blueprint: UserInput,
	response: UserResponse,
}) {
	override async execute() {
		return { user: new User(this.input) };
	}
}

class RegisterUser extends useCaseOf({
	name: "RegisterUser",
	blueprint: UserInput,
	dependencies: { createUser: CreateUser },
	response: UserResponse,
}) {
	override async execute({ createUser = this.dependencies.createUser } = {}) {
		return await createUser(this.input);
	}
}

const operation = new RegisterUser({ name: "Ana" });
const { user } = await operation.execute();
for (const event of operation.pullEvents()) await event.handle();

// Partial overrides replace direct dependencies; other dependencies resolve normally.
await new RegisterUser({ name: "Ana" }).execute({
	createUser: async (input) => ({ user: new User(input) }),
});
```

The constructor validates its arguments and exposes their parsed values as read-only `this.input`. Implement `execute` as an async prototype method, not an arrow-function field. It must return the value shape of the response blueprint, including record/entity instances for those fields. The framework wraps the method automatically to validate the response and collect events; no `super.execute()` call is needed. Each instance allows one execution attempt, including failures; concurrent or subsequent calls reject with `UseCaseAlreadyExecuted`.

Dependencies default to `{}`. Each dependency function creates a fresh child, resolves its dependencies and returns its validated response. Await all dependency calls before returning. Functions are usable only during execution. Use the destructured defaults shown above to keep both no-argument calls and partial overrides inferred in TypeScript. `execute(deps = this.dependencies)` also supports no-argument calls, but its inferred override type requires the complete dependency map. During execution, `this.dependencies` exposes the resolved functions, including overrides. Overrides apply only to direct dependencies, and their inputs and responses are validated against the declared child. There is no global container.

Events from managed children move to the parent when each child finishes, including on failure and when the parent's response omits the child result. Then the validated parent response is traversed through declared records, entities, nested blueprints and lists. Repeated object references are visited once; separately emitted duplicate events are preserved. Child events follow completion order, followed by remaining response events. No handlers run automatically. `pullEvents()` immediately drains the queue, which remains available after failure. Invalid responses are not drained. Overrides contribute events from their returned entities; hidden operations inside an override must expose their events separately.

#### Context and metadata

A use case can declare a `context`, a blueprint for what the caller supplies with each call (the signed-in user, a request id), and metadata that tools can read:

```ts
const RegisterBase = useCaseOf({
	name: "Register",
	blueprint: UserInput,
	response: UserResponse,
	context: blueprintOf((ctx) => ({ userId: ctx.id, requestId: ctx.string })),
	description: "Signs a user up.", // optional
	tags: ["users"], // optional, default []
	deprecated: false, // optional, default false
	errors: [UserAlreadyExists, RepositoryUniqueViolation], // exceptionOf classes a caller should expect
});

const operation = new Register(input, { context: { userId, requestId } });
operation.context; // Readonly<{ userId: string; requestId: string }>, parsed and frozen
```

With a declared `context`, the second constructor argument is required by type and validated by its blueprint; a missing or invalid one throws `InvalidUseCaseContext` (`UseCase` layer, `details.issues`). Without one, `options.context` is not accepted and `this.context` is `undefined`. `UseCaseContext<typeof Register>` extracts the type, and `UseCaseOptions` is the type of the second argument.

A child called through a dependency function receives its parent's context narrowed to the keys of its own `context` blueprint and validated by it. A child with no context gets none; a child that declares one under a parent without context fails with `InvalidUseCaseContext`. Overrides passed to `execute` keep the signature `(input) => response`.

The class gets the frozen statics `context`, `description`, `tags`, `deprecated` and `errors`, beside `useCaseName`, `blueprint`, `response` and `dependencies`. `context` is a non-optional blueprint, `tags` are distinct non-empty strings, and `errors` are distinct classes made by `exceptionOf`; anything else throws `InvalidUseCaseDeclaration`. `errors` documents what to expect and changes nothing at runtime: an exception that is not listed still propagates.

`UseCaseInput`, `UseCaseResponse` and `UseCaseDependencies` extract a declaration's types. `isUseCase` identifies instances; `isUseCaseClass` identifies concrete declarations with a prototype `execute`. UseCases carry their own kind and cannot be used as fields of ordinary data blueprints. Validation errors carry `details.issues`; errors crossing an execution boundary preserve their cause and gain a `UseCase` trace frame using the declared name.

#### Steps

Instead of writing `execute`, a use case can declare `steps`: plain data that the use case interprets. The class is concrete, so it needs no body, and `describe()` reports the steps (a hand-written `execute` is `{ kind: "opaque" }`).

```ts
class Register extends useCaseOf({
	name: "Register",
	blueprint: RegisterInput, // { name, email, plainPassword }
	response: UserResponse, // { user: User }
	dependencies: { users: Users },
	errors: [UserAlreadyExists],
	steps: [
		{ find: "users.findByEmail", args: ["$input.email"], as: "existing" },
		{ ensure: "absent", value: "$existing", error: UserAlreadyExists },
		{ run: "hashPassword", fn: hashPassword, args: ["$input.plainPassword"], as: "hash" },
		{ build: User, values: { name: "$input.name", email: "$input.email", password: "$hash" }, as: "user" },
		{ create: "users", value: "$user", as: "saved" },
		{ return: { user: "$saved" } },
	],
}) {}
```

The steps are the same objects in TypeScript and in JSON, except for the class of `build`, the exception class of `ensure.error` and the function of `run`, which the descriptor names or marks `opaque`. TypeScript checks the dependency and action names (`"users.findByEmail"` only exists if `Users` has that read action); the values are checked at execution by the blueprints. Steps run in order, each awaited, and every repository and use case call goes through the same dependency functions as a hand-written `execute`: execution scope, events, trace frames, `UseCaseAlreadyExecuted` and `execute({ ...overrides })` behave identically.

A *value* is a reference, a literal or a mapping:

| Value | Meaning |
|---|---|
| `"$input.email"` | the parsed input; a path of identifiers and indices follows the root (`$saved.tags.0`); a missing segment is `undefined` |
| `"$context.userId"` | the parsed context (only if the use case declares one) |
| `"$env.mail.FROM"` | a variable of an environment dependency |
| `"$name"` | the result of an earlier step bound with `as` |
| `"text"`, `1`, `true`, `null` | a JSON literal; write `{ literal: "$5" }` for a string that starts with `$` |
| `{ user: "$saved" }`, `["$a", 2]` | a mapping, resolved recursively |

There are no operators or interpolation: anything computed goes through `run`. The names `input`, `context`, `env` and `literal` are reserved.

| Step | Does | Result (`as`) |
|---|---|---|
| `{ find: "<repo>.<action>", args?, as? }` | a read action: `findBy*`, `findManyBy*`, `findMany`, `exists`, `findPage`, `count` | its result |
| `{ ensure, value, other?, error, details? }` | `ensure` is `exists`, `absent`, `equals`, `notEquals` (`other` required, structural equality as in queries), `true` or `false`; on failure throws `new error({ source, details })` | none |
| `{ build: Class, values, as }` | `new Class(values)`, a record or entity | the instance |
| `{ change: "$ref", key, value, as? }` | `record.change[key](value)`; `key` must be a change key | the record |
| `{ invoke: "$ref", method, args?, as? }` | a public method of a record or entity (`publish`, `verifyPassword`...), awaited | its result |
| `{ create \| update \| delete: "<repo>", value, as? }` | the repository action of that name | its result |
| `{ call: "<useCase>", input, as? }` | the use case dependency: validated child, inherited context, events moved up | its response |
| `{ run: "<name>", fn, args?, as? }` | `await fn(...args, { context })`; `name` is unique in the use case | its result |
| `{ return: value }` | the response, validated by the response blueprint; required, last, once | none |

`useCaseOf` validates the steps at declaration and throws `InvalidUseCaseStep` (`UseCase` layer, `details: { index, reason, code }`) for an unknown or malformed step, a bad or repeated `as`, a reference to an unbound name, a `$context` without a declared context, a first-level `$input.<key>` or `$context.<key>` the blueprint lacks, an unknown repository, action, use case or environment, a `find` of a write action, a `build` that is not a record class, an `ensure.error` missing from `errors`, a `change.key` that is not a change key of the class `build` made, and a missing, repeated or misplaced `return`. A `change` or `invoke` on something that is not a record, or on a member it lacks, throws `InvalidUseCaseStep` with the `index` while the steps run. In an application, the classes of `build` and `ensure.error` must be registered (`UnregisteredApplicationReference`); `describe()` gives `implementation: { kind: "steps", steps }` with them by name (`"User"`, `"UserAlreadyExists"`, or `{ core: "RepositoryUniqueViolation" }` for an exported exception) and `run.fn` as `{ kind: "opaque" }`. A subclass that overrides `execute` is hand-written, so it is `{ kind: "opaque" }`.

### Commands

`commandOf` groups use cases under operation names and is the **execution boundary** of a call: the context is validated once, a transaction can wrap the use case, the events it raised are handled by a policy, and the trace gets a `command` frame.

```ts
import { blueprintOf, commandOf } from "@afora/core";

const Users = commandOf({
	name: "Users",
	description: "Accounts.", // optional
	tags: ["accounts"], // optional, default []
	context: blueprintOf((ctx) => ({ userId: ctx.id, requestId: ctx.string })), // optional
	useCases: { register: Register, login: Login },
	transaction: true, // optional, default false
	events: "after-commit", // "after-commit" (default) | "manual" | handler
	onEventError: (error, event) => {}, // optional, "after-commit" only
});

const { user } = await Users.run("register", input, { context });
const { value, events } = await Users.execute("register", input, { context }); // no event policy
```

The keys of `useCases` are the operation names: identifiers holding concrete use case classes. `commandOf` validates its settings and throws `InvalidCommandDeclaration` (`Command` layer, `details.reason`) for anything else. The command is frozen and exposes `commandName`, `description`, `tags`, `context`, `useCases`, `transaction`, `events`, `onEventError` and `operations`; `isCommand` identifies one.

In an application, register commands under `commands: { Users }` (keyed by `commandName`, else `InvalidApplicationDeclaration`); every use case of every command must be in `useCases` (`UnregisteredApplicationReference`, `details: { command, useCase }`). With a `provider`, `app.commands.Users` (or `app.command(Users)`) is the same command rebuilt over the bound use cases, memoized, with the same settings; the transaction check runs again against the bound providers and throws `InvalidCommandDeclaration` at `applicationOf`. `app.describe().commands` gives each command's operations (`{ ref }` of the use case), `transaction`, `events` (a handler appears as `{ kind: "opaque" }`) and `onEventError` (only when set).

`run(op, input, options)` does this:

1. An unknown operation throws `UnknownCommandOperation` (`details.operation`).
2. With a command `context`, `options.context` is validated by that blueprint (`InvalidCommandContext`, `details.issues`) and each use case gets it narrowed to its own context keys; a use case without a context gets none. Without a command `context`, `options.context` goes to the use case as is, typed and validated by it.
3. A fresh use case is built and executed. Input errors stay use case errors.
4. With `transaction: true`, `execute()` runs inside the `transaction` of the provider of the repositories, which therefore see the transaction (relations and child use cases included). A rejection rolls back and propagates. At declaration, every repository reachable from the use cases (through child use cases and relations) must share one provider, and it must support `transaction`; otherwise `commandOf` throws `InvalidCommandDeclaration` listing the repositories. A command with no repository ignores the flag.
5. The events are drained **after** the transaction resolves, so a call that rolled back handles none.
6. The event policy applies, in `run` only:
   - `"after-commit"`: awaits `event.handle()` in emission order. On the first failure, `onEventError(error, event)` is awaited and the next event runs; without it, `run` throws `CommandEventFailed` (`cause`, `details: { operation, event, handled, remaining }`). The commit already happened, so the data is saved even when this error is thrown.
   - `"manual"`: `run` drops the events; use `execute` to get them.
   - a function: awaited with `(events, { command, operation, context })`; a rejection is a `CommandEventFailed`.
7. The validated response is returned.

`execute` performs steps 1 to 5 and returns `{ value, events }` without applying the policy, for outboxes and tests. The whole call runs under a `Command` guard, so errors gain the frame `command @ Users.register`. Concurrent calls are independent; each builds its own use case.

Types: `CommandOf`, `CommandOperation`, `CommandInput`, `CommandResponse`, `CommandOptions` and `AnyCommand`. `options` is `{ context }` when the command declares a context, or the use case's `UseCaseOptions` when it does not.

### Outputs

`outputOf` turns commands into **operations** and runs them through a **pipe** of stages: transforms change or remove operations, and a last stage, a **sink**, builds something concrete (an OpenAPI document, an HTTP app, MCP tools).

```ts
import { outputOf, select } from "@afora/core";

const Api = outputOf({
	name: "Api",
	commands: [Users, Posts],
	statuses: { UserAlreadyExists: 409 }, // optional, by exception name
	pipe: [select({ tags: ["public"] }), someSink({ basePath: "/api" })],
});

Api.operations; // OperationDescriptor[] after the transforms, in declaration order
Api.build(); // the sink's result, built on the first call and memoized
Api.pipe(select({ exclude: ["Users.login"] })); // a new, unnamed output with more stages
Api.pipe(otherSink()); // when the last stage is a sink, its result
```

Each operation is a frozen **`OperationDescriptor`** (version 1): `id` (`"Users.register"`), `command`, `name`, `useCase`, `description` (the use case's, else the command's), `tags` (the command's then the use case's, deduplicated), `deprecated`, `input`, `response`, `context` (the command's, else the use case's), `errors`, `meta` (`{}` until a transform sets it) and `invoke(input, { context })`, which is `command.run`. `operationOf(operation, patch)` returns a modified copy; only `meta` (replaced), `tags`, `description`, `deprecated` and `invoke` can be patched, anything else throws `InvalidOutputStage`.

`outputOf` throws `InvalidOutputStage` (`Output` layer, `details.reason`) for an empty `name`, an entry that is neither a command made by `commandOf` nor an application, a pipe entry that is not a stage, a sink that is not last, or `statuses` that is not a map of exception names to integers between 400 and 599, and `DuplicateOperation` when two operations share an `id`. The operations are computed at declaration; `build()` throws when the pipe has no sink. The output is frozen, tagged and identified by `isOutput`. `commands` also takes an application (all its commands, the bound ones when it has a provider, in registration order) or a list mixing commands and applications: `outputOf({ name: "Api", commands: app })`. The same command twice counts once; two different commands whose operations share an `id` are a `DuplicateOperation`.

To register an output in an application, use `outputs: { Api }` (see Applications).

**Stages** come from factories, so a stage is a name plus JSON options (validated like the options of `providerOf`, and frozen):

```ts
import { sinkOf, transformOf } from "@afora/core";

const hide = transformOf({
	name: "hide",
	apply: (operation, options: { tag: string }) =>
		operation.tags.includes(options.tag) ? null : operation, // null removes it
});
const ids = sinkOf({
	name: "ids",
	build: (operations, options: { prefix?: string }, { output }) =>
		operations.map(({ id }) => `${options.prefix ?? ""}${output.name}/${id}`),
});

outputOf({ name: "Api", commands: [Users], pipe: [hide({ tag: "internal" }), ids()] });
```

`apply` and `build` also get `{ output: { name, statuses } }`. `stageDescriptionOf(stage)` gives `{ kind, name, options }` for a stage made by a factory and `{ kind: "opaque" }` for a hand-written object of the stage shape (accepted at runtime). `stageCatalogOf(...factories)` resolves names to stages (`catalog.resolve("select", options)`), and `StdStages` holds the built-in ones. `select` keeps the operations that match `tags` (any of), `operations` (ids to keep) and `exclude` (ids to drop).

**Errors at the boundary.** `statusOf(error, operation?, statuses?)` gives an HTTP-style status: `statuses[error.name]` if given; 400 for `InvalidUseCaseInput`, `InvalidUseCaseContext`, `InvalidCommandContext` and any exception whose `details.issues` is a list; 404 for `RepositoryEntityNotFound` and `UnknownCommandOperation`; 409 for `RepositoryUniqueViolation`; 422 for an exception listed in `operation.errors`; 500 for anything else, including `CommandEventFailed` (the call committed, but the response cannot claim success) and errors that are not exceptions. `problemOf(error, { status, debug? })` returns an RFC 9457 object (`type: "urn:afora:exception:<name>"`, `title`, `status`, `detail`, `layer`), served as `PROBLEM_MEDIA_TYPE` (`application/problem+json`). `issues` (`path`, `code`, `message`; no values, no causes) only appears for a 400, `trace` only with `debug: true`, and the `detail` of a 5xx is `"Internal error."` unless `debug` is set, so internal messages do not leak.

**Masking.** `outputValueOf(value)` is `JSON.parse(JSON.stringify(value))`: every record goes through its `toJSON`, so sensitive values (a `Password` always) are masked at any depth. A sink must send its response values through it.

### Repositories

`repositoryOf` makes a repository of an entity with the methods you choose: `findBy<Key>` for a unique key (`id`, a key in `options.unique`, or one holding a `unique` property such as `Slug`), giving the entity or `undefined`; `findManyBy<Key>` for any key that is not unique, giving a list (a unique key has `findBy<Key>` instead, so `findManyByEmail` is rejected by type and at declaration); `create`, `update`, `delete`, `count`, and the queries `findMany`, `exists` and `findPage`. Every method is async.

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

`findPage` reads the items and the total with two provider calls, so they are not an atomic snapshot unless the provider runs them in a transaction. `findBy<Key>`, `findManyBy<Key>` and `count` are queries too. By default reads leave out deleted rows when `deletion` is `"soft"`; with `"hard"` (the default) they see every row that exists, as before. `withDeleted: true` includes soft-deleted rows, and never makes a deleted entity mutable again.

`create` takes an entity or the input that builds one. `delete` takes an entity or an id, calls `destroy()` (so `onDelete` is queued) and gives the entity. Entities read back are rebuilt from their stored value, with their identity, so they do not queue `onCreate` again.

`repositoryOf({ entity, actions, deletion: "hard" | "soft" })` defaults to `"hard"`: deletion physically removes the stored row. With `"soft"`, deletion persists `deletedAt` through the provider's `update`. Finds, counts and relation loading exclude these rows; unique values remain occupied. A relation pointing to a soft-deleted entity is treated as missing. Soft reads send `withDeleted: false` to the provider, and soft `delete` requires `update` instead of `remove`. `app.describe()` includes each repository's resolved `deletion` mode.

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
	update(context, data): Promise<void>;
	remove(context, id: string): Promise<void>;
	count(context, query?: RepositoryQuery): Promise<number>; // ignores orderBy, limit and offset
	capabilities?: ProviderCapabilities; // e.g. { transactions: true }
	transaction?<Result>(
		run: (provider: IRepositoryProvider<Environment>) => Promise<Result>,
	): Promise<Result>;
}
```

The bare `RepositoryQuery` uses string keys and stored values. Equality and `in` are mandatory; a provider excludes rows with `deletedAt !== undefined` unless `withDeleted` is `true`. A provider enforces `context.unique` (`RepositoryUniqueViolation`) and rejects an unknown id on `update` and `remove` (`RepositoryEntityNotFound`). Relations load with `findMany(context, { where: { id: { in: ids } } })` (the v1 `findIn` and the key/value signatures are gone). By default each repository gets its own `inMemoryProvider()`; repositories given the same provider share the table of their entity. `repositoryOf` checks that the provider has the methods its actions call.

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

### Applications

`applicationOf` gathers the declarations of an app in one named, immutable manifest, so everything runs in one context and can be inspected:

```ts
const Blog = applicationOf({
	name: "blog",
	properties: { Age, Status },
	blueprints: { Address },
	entities: { User, Post },
	environments: { Database },
	repositories: { Users, Posts },
	provider: inMemoryProvider(), // the default of the repositories that declared none
});

Blog.entities.User; // the declarations, by name
Blog.repositories.Users; // typed; bound to Blog's provider
Blog.repository(Users); // the same, from the original
```

It checks the set as a whole when declared: one object under two names (`DuplicateApplicationDeclaration`), an entity or record held at any depth (fields, lists, optionals, nested blueprints) that is not registered (`UnregisteredApplicationReference`), and a repository whose entity, `relations` or `environmentDependencies` are not (`UnregisteredRepositoryDependency`). A declaration of the wrong kind throws `InvalidApplicationDeclaration`.

`extends: [Auth]`, or `Blog.extend(Billing)`, which returns a new application, inherits declarations; the extended ones stay usable alone and are never changed. The same object under the same name is registered once; one name for different objects, or one object under two names, throws `ApplicationConflict` naming both origins. References may cross applications (a `Post` of `Blog` holding the `User` of `Auth`), and validation runs on the resolved set.

Use cases are registered by name too: `useCases: { Register, CreateUser }` (concrete classes, keyed by their `useCaseName`) and `exceptions: { UserAlreadyExists }` (made by `exceptionOf`, keyed by their `name`); another key throws `InvalidApplicationDeclaration`. The resolved set (extended applications included) is checked: every dependency of a use case must be registered, a use case, repository or environment (`UnregisteredUseCaseDependency`, with `details.useCase` and `details.dependency`); records and entities held by its `blueprint`, `response` or `context` must be registered (`UnregisteredApplicationReference`); and each class in `errors` must be in `exceptions`, unless it is an exception exported by `@afora/core` such as `RepositoryUniqueViolation` (`UnregisteredApplicationReference` otherwise).

With a `provider`, `app.useCases.Register` is a subclass of `Register` whose `dependencies` swap each repository for the application's bound one, through child use cases too; it is the same subclass every time, and `Register` itself is never changed. Without a provider, `app.useCases.Register === Register`. `app.useCase(Register)` gives the same class from the original, as `app.repository(Users)` does.

Commands are registered the same way (`commands: { Users }`, keyed by `commandName`); with a provider `app.commands.Users` runs over the bound use cases (see Commands above).

Outputs are registered with `outputs: { Api }`, keyed by `outputName` (`InvalidApplicationDeclaration`, which also rejects unnamed outputs made by `.pipe`); every command of an output must be registered in `commands` (`UnregisteredApplicationReference`, `details: { output, command }`). With a `provider`, `app.outputs.Api` (or `app.output(Api)`) is the output rebuilt over the application-bound commands, with the same name, statuses and stages, memoized, so `invoke` on its operations writes through the application provider. `app.describe().outputs` gives, for each output, `from`, `name`, `commands` (names), `statuses` and `pipe`: each stage as `{ kind: "transform" | "sink", name, options }`, or `{ kind: "opaque" }` for a hand-written stage.

Repositories are module-level and may be shared, so an application does not change them: `app.repositories.Users` shares the declaration of `Users` but reads and writes through the `provider` of the application (or of the last application it extends that has one), unless `Users` declared its own. Two applications with different providers do not share data. Without a `provider`, `app.repositories.Users` is `Users` itself, and records, entities and repositories work the same outside any application.

`app.describe()` gives a JSON-serializable graph, with the `from` of each declaration (the application that registered it): properties (name, flags, JSON Schema and `lineage`), blueprints, records and entities (fields, `options`, plugin descriptors), environments, repositories (entity, actions, `relations` and `environments` by name), use cases (`name`, `description`, `tags`, `deprecated`, `input`, `response`, optional `context`, `errors` as `{ kind: "exception", ref }` or `{ kind: "core", name }`, `dependencies` as `{ kind, ref }`, and `implementation`: `{ kind: "steps", steps }` or `{ kind: "opaque" }`) and exceptions (`layer` and, when declared as a string, `message`). A field is a reference by name (`{ kind: "entity", ref: "User" }`) when it holds a registered declaration. A property's `lineage` comes from `propertyLineageOf(Property)`: `Integer.with({ min: 0 })` is `{ kind: "refined", base, options }`, `optionalOf` is `{ kind: "optional", base }` and `enumOf` is `{ kind: "factory", factory: "enumOf", args: { values } }`. A root property (declared with `propertyOf`) has no lineage and is identified by its `name`; one with custom handlers is described with what is known (name and schema), never an error.

### Exceptions

Every error the library raises is an `Exception` that knows its `layer` (`ExceptionLayers`: `Schema`, `Property`, `Blueprint`, `Record`, `Entity`, `UseCase`, `Repository`, `Environment`, `Event`, `Command`, `Output`), its `name` and its `source` (who raised it). Passing it up keeps the whole `trace`:

```ts
import {
	ExceptionLayers,
	exceptionOf,
	guard,
	InvalidPropertyValue,
} from "@afora/core";

const UserNotCreated = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UserNotCreated",
	message: "Could not create the user.",
});

guard(
	{ layer: ExceptionLayers.UseCase, source: "CreateUser" },
	() => new Name(input).value,
	(exception, pass) => {
		if (exception.is(InvalidPropertyValue)) return "Jane"; // resolve it here
		return pass(); // or send it up, with this layer added to the trace
	},
);

// or wrap it in an exception of your own
throw new UserNotCreated({ source: "CreateUser", cause: exception });
```

`exception.trace` lists each step from the origin, `exception.origin` is the first one raised, and `toJSON()`/`toString()` print all of it.

## Performance

`bun run bench` compares afora with TypeBox (compiled), Zod 4, Valibot and ArkType on the same data, on Bun and on Node; the results are in `bench/RESULTS.md`. Absolute numbers depend on the machine, so read the ratios. On the measured machine (Apple M2):

- **Valid input.** afora is about 1.8x to 2.5x slower than Valibot and about 1.1x to 2.1x slower than Zod 4 (flat and nested objects, Bun and Node). It is faster than ArkType in these cases, where ArkType's morphs move it to a slower path.
- **Invalid input.** This is still where afora is weakest, but much closer than before. Flat objects are about 5x slower than Valibot and 3.7x slower than Zod 4 on Bun, and about 4.4x and 3.6x on Node; nested objects are about 2.9x and 2.1x on Bun, and about 3.1x on Node. It is faster than ArkType here. Most of what remains is TypeBox's own error collection, which runs once for each failing property; the `cause` exception of an issue is built only when it is read.
- **Floor.** Compiled TypeBox, which only checks and does not transform, is about 9x to 27x faster than afora on valid input. afora builds on it.

What afora does that the fast rows do not all do: a handler pipeline per property (`preHandle`, schema check, `afterHandle`), preceded by a shape check so handlers only see the right types; objects walked key by key instead of one compiled function; frozen results; every issue with `code`, `path` and `source`; and, for `Record.safeParse` and `new Record`, creating the instance. If you validate untrusted bulk data in a hot path and need none of that, use a validator built for it, and use afora at the domain boundary, where the cost per entity is small next to I/O.

## Comparison

A rough guide, not a verdict. "Partial" means it is possible but not what the library is for.

|                             | afora                                          | Zod 4               | Valibot        | Effect Schema                      |
| --------------------------- | ---------------------------------------------- | ------------------- | -------------- | ---------------------------------- |
| Standard Schema V1          | yes, on every field                            | yes                 | yes            | yes                                |
| Transforms                  | yes (`preHandle`, `afterHandle`)               | yes                 | yes            | yes                                |
| Domain entities / classes   | yes (records with change methods and effects)  | no                  | no             | partial (`Schema.Class`)           |
| Sensitive masking           | yes (`sensitive`, in `toJSON`)                 | no                  | no             | partial (`Redacted`)               |
| Layered errors with a trace | yes (`ExceptionLayers`, `trace`)               | no                  | no             | partial (tagged errors, no layers) |
| Runtime speed               | slower; see Performance                        | faster              | faster         | not measured here                  |
| Bundle size                 | not measured; depends on TypeBox and `slugify` | larger than Valibot | small, modular | larger                             |
| Ecosystem and maturity      | new, small                                     | very large          | large          | large, in the Effect ecosystem     |

Where the others win: Zod and Valibot are faster, have far larger ecosystems and documentation, and have integrations and code generators for most tools; Valibot is modular and small; Effect Schema fits a codebase already built on Effect. afora gives up those to model entities, masking and layers in the type you already validate with.

## Packages

`@afora/codegen` generates afora code from an `afora.json` (and extracts the `afora.json` of an `Application` back), and `@afora/mcp` is an MCP server that lets an agent build a domain with it: see [packages/codegen](packages/codegen/README.md) and [packages/mcp](packages/mcp/README.md).

## Local playground

Try the library in a TypeScript editor with IntelliSense, executable examples and an expandable console. It lives in its own package, `@afora/playground`, which provides the `afora` CLI (`afora playground`); `@afora/core` carries no editor:

```bash
bun run playground
```

In this repository that uses the current `src/`. In a project that depends on `@afora/core`, install `@afora/playground` as a dev dependency and run `afora playground` through a package script to use that project's `package.json`, `tsconfig.json` and installed dependencies. Saved experiments live in `.afora/sandbox/**/*.sandbox.ts` inside the selected project. Bun is required for the playground. See [packages/playground](packages/playground/README.md) for setup, project selection and execution limits.

## Testing a provider

`@afora/core/testing` has a contract test kit for `IRepositoryProvider` implementations. It does not import a test runner: pass the `describe`, `it` and `expect` of yours, and a factory of fresh, empty providers (called once per case).

```ts
import { describe, expect, it } from "bun:test"; // or vitest, jest
import { providerContract } from "@afora/core/testing";
import { myProvider } from "./my-provider";

providerContract({ describe, it, expect }, () => myProvider());
```

It checks `insert`, `findOne`, `findMany`, `update`, `remove` and `count`; `RepositoryUniqueViolation` (soft-deleted rows keep their unique values) and `RepositoryEntityNotFound`; `where` equality, `in` and AND; `orderBy`, `limit` and `offset`; `withDeleted`; that returned data is a copy; and, when the provider advertises `capabilities.transactions` (or with `{ transactions: true }`), commit, rollback, scoped-provider lifetime and nested savepoints.

## Scripts

```bash
bun install
bun test              # unit tests
bun check             # type check
bun run test:types    # build, then type-check the packed package on TypeScript, bundler and nodenext resolution
bun run test:type-perf # build, then budget the editor cost per edit and snapshot hovers, completions and errors
bun run test:api      # build, then snapshot the public surface (exports and declarations) and the afora.json schema
bun run test:interop  # Hono, tRPC and TanStack Form tests (examples/interop), including the quick start
bun run smoke         # build, then run the package on plain Node
bun run bench         # benchmark against TypeBox, Zod, Valibot and ArkType
bun run lint          # biome lint
bun run knip          # unused files, exports and dependencies
bun run fmt           # biome format + fix
bun run build         # build dist/ (ESM + .d.ts)
bun run test:codegen  # tests of packages/codegen
bun run test:mcp      # tests of packages/mcp
bun run test:playground # tests of packages/playground
bun run playground    # the local playground, on this repository's src/
bun run build:packages # build the core, then packages/codegen, packages/mcp and packages/playground
```

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`feat(repository): …`, `fix: …`), checked by commitlint in a Husky `commit-msg` hook; the `pre-commit` hook runs Biome and Knip. CI runs lint, Knip, type checks, unit and interop tests, the build and the Node smoke test on every push and pull request. Pushing a `v*` tag that matches `package.json` publishes to npm with provenance.

## Versioning

What is stable, what may break and how deprecations work is in [VERSIONING.md](VERSIONING.md).

## License

MIT
