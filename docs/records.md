# Records

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

`toJSON()` is typed as it returns: every key of the plain value (`RecordJson`, nothing optional that the blueprint requires), read-only, with the keys of `options.sensitive`, of the plugins and of every `sensitive` property as `Masked`, the value with each leaf as a `string`. So `new User(value).toJSON().email` is a `string`, a sensitive `integer` is a `string` too, and a record field gives the type of its own `toJSON`. A record class built by slicing (`sliceOf`) is typed the same; the value `sliceValue` gives types a nested record by its plain value, so a non-string key masked only through that record's `options.sensitive` is not typed as masked there.

**Uniqueness.** A key holding a property declared `unique`, such as `Slug` (optional or not), is always unique; a list of them is not, since uniqueness applies to a key's value. `unique` only records the intent: a record never compares itself with other records, so two records with the same `email` both build. `options.unique` names the keys a repository (or a unique index in the database) must enforce. `Slug` slugifies its value: `"  Olá Mundo! "` becomes `"ola-mundo"`.

**Changes.** The keys are read-only and only change through `set`, which only the record itself (or a `change.<key>` method) can call. `set` validates the value, stores it, then runs `onSetAll(change)` and then the effect of the key in `onSet`. `change` is `{ key, value, previous }`, and checking `change.key` narrows the rest (annotate it as `RecordChange<User>`).

**Rejections.** An invalid value throws in the `Record` layer, naming the key in `details` (e.g. `{ key: "address.zip" }`). So does a key the blueprint does not declare, at any depth, with `UndeclaredRecordProperty` (e.g. `{ key: "addresses.0.extra" }`): the value is rejected, never trimmed. A key cannot take the name of a member of the record (`set`, `toJSON`, `onSet`, `onSetAll` or, when the record has `change` keys, `change`), nor of one every object inherits (`toString`, `valueOf`, `hasOwnProperty`, `__proto__`... all of `Object.prototype`, listed in `RESERVED_RECORD_KEYS`): `recordOf` throws `ReservedRecordKey`. Nor can a class extending the record declare a member with the name of a key, which would hide it: its first record throws `ReservedRecordKey`.

**Name.** A record is named after its class: the name is the `source` of its exceptions, the name of its schema in OpenAPI and, for an entity, what a repository gives its provider. A bundler that minifies renames classes, so anything keyed by that name (a table, a collection) stops matching. `recordOf(blueprint, { name: "User" })` (and `entityOf`) declares the name instead: an identifier (`InvalidRecordDeclaration` otherwise), kept by the class and its subclasses whatever they are renamed to. `recordNameOf(User)`, or `User.recordName`, gives the declared name, or the name of the class without one; a subclass gives its own with `static override readonly recordName = "Admin"`. Use it instead of `User.name` wherever the name is a key.

**Spread caveat.** The value of a record lives in a `WeakMap`, and each key is a getter on the record's prototype, not an own property. So `Object.keys(user)` is `[]` and `{ ...user }` is `{}` (unless a subclass adds own properties). Metadata is available through `user[Meta].blueprint` and `user[Meta].options` (`Meta` is exported by `@afora/core`), or the class statics `User.blueprint` and `User.options`. The string keys `blueprint` and `options` are available for domain data. For plain data use `user.toJSON()` (frozen, sensitive values masked), or `blueprint.safeParse(value)` to handle plain input into a plain object. To build a record from another one, pass a plain object of its keys, rather than relying on enumeration of the record itself.

## Plugins

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

## Slicing (experimental)

Slicing is experimental: it lives in `@afora/core/experimental`, may change in any release and is not covered by [`VERSIONING.md`](../VERSIONING.md).

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
