# Properties

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

A property whose callers give another form of its value than the one it stores says so with a static under the `PropertyInput` symbol: `{ accepts, convert }`, the property that validates what a caller gives (of the same value type) and the function that turns it into what is stored. `Password` declares `{ accepts: PlainPassword, convert }`, a plain password checked by the password rules and hashed, so what derives inputs from an entity, as the [standard use cases](std-use-cases.md) do, takes a plain password for a `Password` key and stores its hash. `propertyInputOf(field)` reads it (`undefined` for a property that takes its value as it stores it); a class extending or refining the property keeps it. `PlainPassword` is exported; it is not in the `Std` context.

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
