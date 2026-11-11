# A custom property

You have a value with its own rules, a product code, and want every blueprint to normalize and check it the same way.

```ts
import {
	blueprintBuilderOf,
	blueprintPluginOf,
	propertyOf,
	Std,
} from "@afora/core";
import { Type } from "typebox";

// A property: normalize first, check the schema, then adjust the result
export const Sku = propertyOf({
	name: "sku",
	schema: Type.String({ pattern: "^[A-Z]{3}-[0-9]{4}$" }),
	preHandle: (value) => value.trim().toUpperCase(),
	unique: true, // a record lists its key in options.unique
	default: "MUG-0001", // what Sku.demo() gives
});

// A builder whose ctx has everything of Std plus ctx.sku
export const shopBlueprintOf = blueprintBuilderOf(
	Std,
	blueprintPluginOf("shop", { sku: Sku }),
);

export const Product = shopBlueprintOf((ctx) => ({
	sku: ctx.sku,
	name: ctx.text,
}));
```

`propertyOf` runs `preHandle`, then validates the value against the TypeBox schema, then `afterHandle` (not used here). The handler gets a value of the type of the schema. `unique: true` makes a record list the key in `options.unique`, as `Slug` does; `sensitive: true` makes `toJSON` mask it. `blueprintBuilderOf(Std, blueprintPluginOf(...))` makes a `blueprintOf` whose `ctx` has everything of `Std` plus `ctx.sku`; without `Std` the `ctx` would hold only your properties.

A property is also usable directly as a field (`sku: Sku`) in any blueprint, with no plugin.

More: [Properties](../properties.md), [Blueprints](../blueprints.md) (plugins, builders), [Records](../records.md).
