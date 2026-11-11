import { Type } from "typebox";
import { propertyOf } from "../../core/property/property";

/** Any string. */
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

/** Any number. */
export const NumberProperty = propertyOf({
	name: "number",
	schema: Type.Number(),
	default: 0,
});

/** An integer. Narrow it with `Integer.with({ min, max })`. */
export const Integer = propertyOf({
	name: "integer",
	schema: Type.Integer(),
	default: 0,
});

/** A boolean. */
export const BooleanProperty = propertyOf({
	name: "boolean",
	schema: Type.Boolean(),
	default: false,
});
