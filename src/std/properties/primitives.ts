import { Type } from "typebox";
import { propertyOf } from "../../core/property/property";

export const StringProperty = propertyOf({
	name: "string",
	schema: Type.String(),
	default: "demo",
});

/** A string that is not blank once trimmed. */
export const Text = propertyOf({
	name: "text",
	schema: Type.String({ minLength: 1 }),
	default: "Demo",
	preHandle: (value) => value.trim(),
});

export const NumberProperty = propertyOf({
	name: "number",
	schema: Type.Number(),
	default: 0,
});

export const Integer = propertyOf({
	name: "integer",
	schema: Type.Integer(),
	default: 0,
});

export const BooleanProperty = propertyOf({
	name: "boolean",
	schema: Type.Boolean(),
	default: false,
});
