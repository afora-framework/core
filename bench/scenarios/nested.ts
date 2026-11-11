// The flat user plus one address, a list of tags and a list of ten addresses.
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

const address = { street: "  Main Street 100 ", zip: "01310-100" };
const addressClean = { street: "Main Street 100", zip: "01310-100" };
const tags = ["coffee", "roast", "bean"];

// biome-ignore lint/suspicious/noExplicitAny: the afora module is loaded from source on Bun and from a build on Node
export const nested = (afora: any): to.Scenario => {
	const tbAddress = Type.Object(
		{
			street: Type.String({ minLength: 1 }),
			zip: Type.String({ minLength: 5 }),
		},
		{ additionalProperties: false },
	);
	const tb = Type.Object(
		{
			name: Type.String({ minLength: 3 }),
			email: Type.String({ format: "email" }),
			age: Type.Integer({ minimum: 0 }),
			address: tbAddress,
			tags: Type.Array(Type.String({ minLength: 1 }), { maxItems: 5 }),
			addresses: Type.Array(tbAddress),
		},
		{ additionalProperties: false },
	);

	const ajvAddress = {
		type: "object",
		additionalProperties: false,
		required: ["street", "zip"],
		properties: {
			street: { type: "string", minLength: 1 },
			zip: { type: "string", minLength: 5 },
		},
	};
	const ajvValidate = ajvInstance.compile({
		type: "object",
		additionalProperties: false,
		required: ["name", "email", "age", "address", "tags", "addresses"],
		properties: {
			name: { type: "string", minLength: 3 },
			email: { type: "string", format: "email" },
			age: { type: "integer", minimum: 0 },
			address: ajvAddress,
			tags: {
				type: "array",
				maxItems: 5,
				items: { type: "string", minLength: 1 },
			},
			addresses: { type: "array", items: ajvAddress },
		},
	});

	const zAddress = z.strictObject({
		street: z.string().trim().min(1),
		zip: z.string().min(5),
	});
	const zNested = z.strictObject({
		name: z.string().trim().min(3),
		email: z.string().trim().toLowerCase().email(),
		age: z.number().int().min(0),
		address: zAddress,
		tags: z.array(z.string().min(1)).max(5),
		addresses: z.array(zAddress),
	});

	const vAddress = v.strictObject({
		street: v.pipe(v.string(), v.trim(), v.minLength(1)),
		zip: v.pipe(v.string(), v.minLength(5)),
	});
	const vNested = v.strictObject({
		name: v.pipe(v.string(), v.trim(), v.minLength(3)),
		email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email()),
		age: v.pipe(v.number(), v.integer(), v.minValue(0)),
		address: vAddress,
		tags: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.maxLength(5)),
		addresses: v.array(vAddress),
	});

	const aAddress = type({
		street: type("string.trim").to("string >= 1"),
		zip: "string >= 5",
		"+": "reject",
	});
	const aNested = type({
		name: type("string.trim").to("string >= 3"),
		email: type("string.trim")
			.pipe((value: string) => value.toLowerCase())
			.to("string.email"),
		age: "number.integer >= 0",
		address: aAddress,
		tags: type("string >= 1").array().atMostLength(5),
		addresses: aAddress.array(),
		"+": "reject",
	});

	const eAddress = S.Struct({ street: eText(1), zip: eText(5, false) });
	const eNested = S.Struct({
		name: eText(3),
		email: eEmail(),
		age: eInt(0),
		address: eAddress,
		tags: S.Array(eText(1, false)).check(S.isMaxLength(5)),
		addresses: S.Array(eAddress),
	});

	const yAddress = y
		.object({
			street: y.string().required().trim().min(1),
			zip: y.string().required().min(5),
		})
		.exact();
	const yNested = y
		.object({
			name: y.string().required().trim().min(3),
			email: y.string().required().trim().lowercase().email(),
			age: y.number().required().integer().min(0),
			address: yAddress.required(),
			tags: y.array().of(y.string().required().min(1)).required().max(5),
			addresses: y.array().of(yAddress.required()).required(),
		})
		.exact();

	const jAddress = Joi.object({
		street: Joi.string().trim().min(1).required(),
		zip: Joi.string().min(5).required(),
	});
	const jNested = Joi.object({
		name: Joi.string().trim().min(3).required(),
		email: Joi.string().trim().lowercase().email({ tlds: false }).required(),
		age: Joi.number().integer().min(0).required(),
		address: jAddress.required(),
		tags: Joi.array().items(Joi.string().min(1)).max(5).required(),
		addresses: Joi.array().items(jAddress).required(),
	});

	const { blueprintOf, listOf } = afora;
	const property = aforaProperties(afora);
	const Street = property.text("street", 1);
	const Zip = property.text("zip", 5, false);
	const Tag = property.text("tag", 1, false);
	const Name = property.text("name", 3);
	const Email = property.email("email");
	const Age = property.integer("age", 0);
	const Address = blueprintOf(() => ({ street: Street, zip: Zip }));
	const Nested = blueprintOf(() => ({
		name: Name,
		email: Email,
		age: Age,
		address: Address,
		tags: listOf(Tag, { maxItems: 5 }),
		addresses: listOf(Address),
	}));

	return {
		id: "nested",
		title: "Nested user (address, 5 tags max, 10 addresses)",
		shape:
			"The flat user plus `address: { street (trimmed), zip (minLength 5) }`, `tags: string[]` (`maxItems 5`) and `addresses: Address[]` with 10 items. 7 rules broken in the invalid input, in different places.",
		transforms: true,
		input: {
			valid: {
				name: "  Alice  ",
				email: "  Alice@Example.COM ",
				age: 30,
				address,
				tags,
				addresses: Array.from({ length: 10 }, () => ({ ...address })),
			},
			validClean: {
				name: "Alice",
				email: "alice@example.com",
				age: 30,
				address: addressClean,
				tags,
				addresses: Array.from({ length: 10 }, () => ({ ...addressClean })),
			},
			// name, email, age, zip (wrong type), six tags (limit is five), and
			// one address of the ten with no street and a short zip.
			invalid: {
				name: "a",
				email: "not-an-email",
				age: -1.5,
				address: { street: "Main Street 100", zip: 1310 },
				tags: ["a", "b", "c", "d", "e", "f"],
				addresses: Array.from({ length: 10 }, (_, index) =>
					index === 3 ? { zip: "1" } : { ...address },
				),
			},
		},
		contenders: [
			to.typebox(Compile(tb)),
			to.ajv(ajvValidate),
			to.typia(typiaValidators.nested),
			to.zod(zNested),
			to.valibot(vNested),
			to.arktype(aNested),
			to.effect(eNested),
			to.yup(yNested),
			to.joi(jNested),
			...to.afora(afora, Nested),
		],
	};
};
