import Ajv from "ajv";
import addFormats from "ajv-formats";
import { clean } from "./input.ts";

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile({
	type: "object",
	additionalProperties: false,
	required: ["name", "email", "age"],
	properties: {
		name: { type: "string", minLength: 3 },
		email: { type: "string", format: "email" },
		age: { type: "integer", minimum: 0 },
	},
});

export const result = validate(clean);
