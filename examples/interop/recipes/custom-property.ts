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
