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
