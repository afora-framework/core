import { Type } from "typebox";
import { blueprintOf, propertyOf } from "../../src/index.ts";
import { raw } from "./input.ts";

const Name = propertyOf({
	name: "name",
	schema: Type.String({ minLength: 3 }),
	preHandle: (value: string) => value.trim(),
});
const Email = propertyOf({
	name: "email",
	schema: Type.String({ format: "email" }),
	preHandle: (value: string) => value.trim().toLowerCase(),
});
const Age = propertyOf({ name: "age", schema: Type.Integer({ minimum: 0 }) });
const Flat = blueprintOf(() => ({ name: Name, email: Email, age: Age }));

export const result = Flat.safeParse(raw);
