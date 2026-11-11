# Blueprints

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

`ctx.optional.*` and `ctx.list.*` mirror every field: `ctx.list.string` is `listOf(ctx.string)` and `ctx.list.optional.string` an optional list of strings. Every context also has `ctx.listOf`, `ctx.optionalOf`, `ctx.propertyOf` and `ctx.variantOf`, the same functions as the exports, to make fields inline: `ctx.listOf(ctx.string, { maxItems: 5 })`, `ctx.optionalOf(Address)`. `optional`, `list`, `listOf`, `optionalOf`, `propertyOf` and `variantOf` are reserved, so no plugin can declare them. Factories such as `ctx.enumOf` are not mirrored under `optional` and `list`, which would lose their literal types; wrap what they return in `ctx.listOf` or `ctx.optionalOf`.

`join` takes any number of blueprints (`A.join(B, C)` is `A.join(B).join(C)`); a later one replaces a key of an earlier one, like plugins do. `listOf` takes a property, a blueprint or another list, and `optionalOf` makes it an optional key.

## One of several blueprints

`variantOf(key, variants)` is a field that holds one of several objects, told apart by the value of one key:

```ts
import { blueprintOf, variantOf } from "@afora/core";

const Card = blueprintOf((ctx) => ({ holder: ctx.text, number: ctx.text }));
const Pix = blueprintOf((ctx) => ({ key: ctx.email }));

const Payment = blueprintOf((ctx) => ({
	amount: ctx.integer,
	by: variantOf("method", { card: Card, pix: Pix }),
	tried: ctx.listOf(ctx.variantOf("method", { card: Card, pix: Pix })),
}));

const result = Payment.safeParse({
	amount: 10,
	by: { method: "pix", key: " Jane@Example.COM " },
	tried: [],
});
if (!result.issues && result.value.by.method === "pix") {
	result.value.by.key; // "jane@example.com": narrowed by the key
}
```

Each variant is a blueprint, named by the value the key has for it. The blueprints do not declare the key: the field adds it, first, so a blueprint can be a variant of several fields and cannot disagree with its name. A blueprint that declares the key, and a field with no variant, throw `InvalidBlueprintVariant` when the field is declared.

A value is handled by the blueprint its key names, exactly as a nested blueprint handles it: its properties run their handlers (the email above is trimmed and lowercased), its issues have their own codes and paths (`required`, `undeclared_key`, `invalid_value` at `by.key`), sensitive properties are masked by `toJSON`, and the result is frozen. A value whose key is missing or names no variant gets one issue at the key (`invalid_value`, `must be equal to one of the allowed values`), and a value that is not an object is `invalid_type`.

`optionalOf` and `listOf` take a variant field, it has a `~standard` of its own, [`toOpenAPI`](openapi.md) gives it as `oneOf` with a `discriminator`, and `describe()` and the [schema lock](schema-evolution.md) hold each variant (a change inside one is told at `by.card.<its key>`).

A variant can also be a record class, an entity included:

```ts
class Card extends recordOf(
	blueprintOf((ctx) => ({ holder: ctx.text, number: ctx.text })),
) {}

const Payment = blueprintOf((ctx) => ({
	by: variantOf("method", { card: Card, pix: Pix }),
}));

const result = Payment.safeParse({
	by: { method: "card", holder: "Jane", number: "4111" },
});
if (!result.issues && result.value.by instanceof Card) result.value.by.holder;
```

The value is then an instance of the class, built from the plain value without the key, or the instance that was given. An instance has no key: it is told apart by its class (`instanceof`), so a class can be one variant only. The key is in what is given as a plain value, in `toJSON` (`{ method: "card", ...the record's own JSON }`) and in what is stored. An entity is stored by reference, as `{ [key]: name, id }`, and read back as the entity through the [relations](repositories.md) of the repository, which needs one for each entity class among the variants, as for any entity field; the events of an entity a use case returns inside a variant are collected like any other.

In an `afora.json` the field is `{ "variant": { "key": "method", "of": { "card": "Card", "pix": "Pix" } } }`, generated and extracted by `@afora/codegen` like any other field: see [Variant fields](afora-json.md#variant-fields). Not yet: picking keys inside a variant with `sliceOf` (it can be picked whole), and upgrading the stored value of a variant with the schema evolution options of its own properties (`fill`, `renamedFrom`). A union can also be the schema of one property, when its variants need no properties of their own: see [Unions](properties.md#unions). That one is checked by one compiled function for the whole value, so a valid value takes about half the time it takes as a variant field, whose variants are walked key by key like any blueprint (1.2 µs against 2.1 µs for twelve events of four variants, where Zod 4 takes 2.5 µs); rejected values take the same.

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
