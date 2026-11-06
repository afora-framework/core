import { propertyOf } from "@afora/core";
import { Type } from "typebox";

/** A property with a custom handler: it cannot be recreated from JSON. */
export const Rating = propertyOf({
	name: "rating",
	schema: Type.Integer({ minimum: 1, maximum: 5 }),
	preHandle: (value: number) => Math.min(5, Math.max(1, value)),
});
