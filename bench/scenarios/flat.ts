// A small flat object, with or without transforms. `flat` trims and
// lowercases; `no-transform` is the same shape and only checks, which is where
// the libraries that compile a checker (TypeBox, Ajv, Typia, ArkType) are at
// their best.
import { type } from "arktype";
import * as S from "effect/Schema";
import Joi from "joi";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import * as v from "valibot";
import * as y from "yup";
import { z } from "zod";
import * as to from "../contenders.ts";
import * as typiaValidators from "../typia/generated/validators.js";
import { aforaProperties, ajvInstance, eEmail, eInt, eText } from "./shared.ts";

const clean = { name: "Alice", email: "alice@example.com", age: 30 };
// Three rules broken: name too short, email malformed, age negative and fractional.
const invalid = { name: "a", email: "not-an-email", age: -1.5 };

// biome-ignore lint/suspicious/noExplicitAny: the afora module is loaded from source on Bun and from a build on Node
function build(afora: any, transforms: boolean): to.Contender[] {
	const tb = Type.Object(
		{
			name: Type.String({ minLength: 3 }),
			email: Type.String({ format: "email" }),
			age: Type.Integer({ minimum: 0 }),
		},
		{ additionalProperties: false },
	);

	const ajvValidate = ajvInstance.compile({
		type: "object",
		additionalProperties: false,
		required: ["name", "email", "age"],
		properties: {
			name: { type: "string", minLength: 3 },
			email: { type: "string", format: "email" },
			age: { type: "integer", minimum: 0 },
		},
	});

	// `.email()` is deprecated in v4 but keeps the order: trim, lowercase, then check.
	const zFlat = z.strictObject({
		name: transforms ? z.string().trim().min(3) : z.string().min(3),
		email: transforms ? z.string().trim().toLowerCase().email() : z.email(),
		age: z.number().int().min(0),
	});

	const vFlat = v.strictObject({
		name: transforms
			? v.pipe(v.string(), v.trim(), v.minLength(3))
			: v.pipe(v.string(), v.minLength(3)),
		email: transforms
			? v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email())
			: v.pipe(v.string(), v.email()),
		age: v.pipe(v.number(), v.integer(), v.minValue(0)),
	});

	// ArkType lowercases through a function morph.
	const aFlat = transforms
		? type({
				name: type("string.trim").to("string >= 3"),
				email: type("string.trim")
					.pipe((value: string) => value.toLowerCase())
					.to("string.email"),
				age: "number.integer >= 0",
				"+": "reject",
			})
		: type({
				name: "string >= 3",
				email: "string.email",
				age: "number.integer >= 0",
				"+": "reject",
			});

	const eFlat = S.Struct({
		name: eText(3, transforms),
		email: eEmail(transforms),
		age: eInt(0),
	});

	// Without `strict()`, Yup casts: `trim()` and `lowercase()` are transforms.
	const yFlat = y
		.object({
			name: transforms
				? y.string().required().trim().min(3)
				: y.string().required().min(3),
			email: transforms
				? y.string().required().trim().lowercase().email()
				: y.string().required().email(),
			age: y.number().required().integer().min(0),
		})
		.exact();

	const jFlat = Joi.object({
		name: transforms
			? Joi.string().trim().min(3).required()
			: Joi.string().min(3).required(),
		email: transforms
			? Joi.string().trim().lowercase().email({ tlds: false }).required()
			: Joi.string().email({ tlds: false }).required(),
		age: Joi.number().integer().min(0).required(),
	});

	const property = aforaProperties(afora);
	const Name = property.text("name", 3, transforms);
	const Email = property.email("email", transforms);
	const Age = property.integer("age", 0);
	const Flat = afora.blueprintOf(() => ({
		name: Name,
		email: Email,
		age: Age,
	}));

	return [
		to.typebox(Compile(tb)),
		to.ajv(ajvValidate),
		to.typia(typiaValidators.flat),
		to.zod(zFlat),
		to.valibot(vFlat),
		to.arktype(aFlat),
		to.effect(eFlat),
		to.yup(yFlat),
		to.joi(jFlat),
		...to.afora(afora, Flat),
	];
}

// biome-ignore lint/suspicious/noExplicitAny: see above
export const flat = (afora: any): to.Scenario => ({
	id: "flat",
	title: "Small flat object",
	shape:
		"`{ name: string (minLength 3, trimmed), email: email (trimmed, lowercased), age: integer >= 0 }`. 3 rules broken in the invalid input.",
	transforms: true,
	input: {
		valid: { name: "  Alice  ", email: "  Alice@Example.COM ", age: 30 },
		validClean: clean,
		invalid,
	},
	contenders: build(afora, true),
});

// biome-ignore lint/suspicious/noExplicitAny: see above
export const noTransform = (afora: any): to.Scenario => ({
	id: "no-transform",
	title: "Small flat object, checks only",
	shape:
		"The flat object with no trim and no lowercase: `{ name: string (minLength 3), email: email, age: integer >= 0 }`. Nothing is transformed, so every library runs its fastest path.",
	transforms: false,
	input: { valid: clean, validClean: clean, invalid },
	contenders: build(afora, false),
});
