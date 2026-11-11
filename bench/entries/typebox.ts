import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { clean } from "./input.ts";

const Flat = Compile(
	Type.Object(
		{
			name: Type.String({ minLength: 3 }),
			email: Type.String({ format: "email" }),
			age: Type.Integer({ minimum: 0 }),
		},
		{ additionalProperties: false },
	),
);

export const result = Flat.Check(clean);
