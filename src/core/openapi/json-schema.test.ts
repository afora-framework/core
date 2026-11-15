import { describe, expect, expectTypeOf, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { blueprintOf } from "../../std/blueprint";
import { entityOf } from "../../std/entity";
import { Integer } from "../../std/properties/primitives";
import { listOf } from "../blueprint/list";
import { optionalOf } from "../blueprint/optional";
import type { BlueprintField } from "../blueprint/types/blueprint.interface";
import { variantOf } from "../blueprint/variant";
import { recordOf } from "../record/record";
import { InvalidOpenAPIModel } from "./exceptions";
import { jsonSchemaOf } from "./json-schema";
import { toOpenAPI } from "./openapi";
import type { JSONSchema } from "./types/json-schema.interface";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** An Ajv 2020 validator of `field`'s JSON Schema, strict: an unknown keyword or format throws. */
function validatorOf(field: BlueprintField) {
	const ajv = new Ajv2020({ strict: true, allErrors: true });
	addFormats(ajv);
	return ajv.compile(jsonSchemaOf(field));
}

const Address = recordOf(
	blueprintOf((ctx) => ({
		street: ctx.text({ description: "Street and number" }),
		zip: ctx.string({ pattern: /^\d{5}-\d{3}$/ }),
	})),
	{ name: "Address" },
);

const Card = blueprintOf((ctx) => ({ last4: ctx.string }));
const Pix = blueprintOf((ctx) => ({ key: ctx.email }));

const User = entityOf(
	blueprintOf((ctx) => ({
		name: ctx.text({ max: 80 }),
		email: ctx.email,
		password: ctx.password,
		nickname: ctx.optional.string,
		age: ctx.optional.integer({ min: 0 }),
		home: Address,
		work: optionalOf(Address),
		tags: listOf(ctx.string, { maxItems: 5 }),
		status: ctx.enumOf(["active", "blocked"]),
		meta: ctx.json,
		payment: ctx.variantOf("method", { card: Card, pix: Pix }),
	})),
	{ name: "User" },
);

describe("jsonSchemaOf", () => {
	test("a property is a JSON Schema document of its own", () => {
		const schema = jsonSchemaOf(Integer.with({ min: 1, description: "Units" }));
		expect(schema).toEqual({
			$schema: DIALECT,
			type: "integer",
			minimum: 1,
			description: "Units",
		});
		expectTypeOf(schema).toEqualTypeOf<JSONSchema>();
		const validate = validatorOf(Integer.with({ min: 1 }));
		expect(validate(3)).toBe(true);
		expect(validate(0)).toBe(false);
		expect(validate("3")).toBe(false);
	});

	test("every std property is a schema Ajv 2020 compiles in strict mode", () => {
		const Scalars = blueprintOf((ctx) => ({
			id: ctx.id,
			slug: ctx.slug,
			email: ctx.email,
			phone: ctx.phone,
			url: ctx.url,
			ip: ctx.ip,
			password: ctx.password,
			string: ctx.string,
			text: ctx.text,
			number: ctx.number,
			integer: ctx.integer,
			boolean: ctx.boolean,
			date: ctx.date,
			dateTime: ctx.dateTime,
			createdAt: ctx.createdAt,
			updatedAt: ctx.updatedAt,
			deletedAt: ctx.deletedAt,
			schema: ctx.schema,
			json: ctx.json,
			enum: ctx.enumOf(["a", "b"]),
		}));
		const validate = validatorOf(Scalars);
		expect(validate({})).toBe(false);
		expect(jsonSchemaOf(Scalars).properties?.password?.writeOnly).toBe(true);
	});

	test("optional keys, lists and nested blueprints", () => {
		const Post = blueprintOf((ctx) => ({
			title: ctx.string,
			subtitle: ctx.optional.string,
			tags: listOf(ctx.string, { minItems: 1, maxItems: 3 }),
			author: blueprintOf((inner) => ({ name: inner.string })),
		}));
		const schema = jsonSchemaOf(Post);
		expect(schema.$schema).toBe(DIALECT);
		expect(schema.required).toEqual(["title", "tags", "author"]);
		expect(schema.additionalProperties).toBe(false);
		expect(schema.$defs).toBeUndefined();

		const validate = validatorOf(Post);
		expect(
			validate({ title: "Hi", tags: ["a"], author: { name: "Ana" } }),
		).toBe(true);
		expect(validate({ title: "Hi", tags: [], author: { name: "Ana" } })).toBe(
			false,
		);
		expect(
			validate({ title: "Hi", tags: ["a"], author: { name: "Ana", x: 1 } }),
		).toBe(false);
		expect(validatorOf(listOf(Post))([])).toBe(true);
	});

	test("a list is an array document", () => {
		expect(jsonSchemaOf(listOf(Integer, { maxItems: 2 }))).toEqual({
			$schema: DIALECT,
			type: "array",
			items: { type: "integer" },
			maxItems: 2,
		});
	});

	test("a record held inside is defined once under $defs, by its name", () => {
		const Contacts = blueprintOf(() => ({
			home: Address,
			work: optionalOf(Address),
			others: listOf(Address),
		}));
		const schema = jsonSchemaOf(Contacts);
		const ref = { $ref: "#/$defs/Address" };
		expect(schema.properties).toEqual({
			home: ref,
			work: ref,
			others: { type: "array", items: ref },
		});
		expect(Object.keys(schema.$defs ?? {})).toEqual(["Address"]);
		expect(schema.$defs?.Address).toEqual(toOpenAPI(Address));

		const validate = validatorOf(Contacts);
		const address = { street: "Av. Paulista", zip: "01310-100" };
		expect(validate({ home: address, others: [address] })).toBe(true);
		expect(validate({ home: { ...address, zip: "x" }, others: [] })).toBe(
			false,
		);
	});

	test("two records of the same name get numbered definitions", () => {
		const Other = recordOf(
			blueprintOf((ctx) => ({ line: ctx.string })),
			{ name: "Address" },
		);
		const schema = jsonSchemaOf(blueprintOf(() => ({ a: Address, b: Other })));
		expect(schema.properties?.b).toEqual({ $ref: "#/$defs/Address2" });
		expect(Object.keys(schema.$defs ?? {})).toEqual(["Address", "Address2"]);
	});

	test("a record or entity given is the document, its records under $defs", () => {
		expect(jsonSchemaOf(Address)).toEqual({
			$schema: DIALECT,
			...toOpenAPI(Address),
		});

		const schema = jsonSchemaOf(User);
		expect(schema.properties?.id?.readOnly).toBe(true);
		expect(schema.properties?.createdAt?.readOnly).toBe(true);
		expect(schema.properties?.password?.writeOnly).toBe(true);
		expect(schema.properties?.home).toEqual({ $ref: "#/$defs/Address" });
		expect(Object.keys(schema.$defs ?? {})).toEqual(["Address"]);
		expect(JSON.stringify(schema)).not.toContain("discriminator");

		const validate = validatorOf(User);
		const user = {
			id: "0190a0a0-0000-7000-8000-000000000000",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			name: "Ana",
			email: "ana@example.com",
			// The schema of a Password is that of its hash, as `toOpenAPI` gives it.
			password: "$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA",
			home: { street: "Av. Paulista", zip: "01310-100" },
			tags: [],
			status: "active",
			meta: { any: ["json"] },
			payment: { method: "pix", key: "ana@example.com" },
		};
		const valid = validate(user);
		expect(validate.errors ?? []).toEqual([]);
		expect(valid).toBe(true);
		expect(validate({ ...user, status: "gone" })).toBe(false);
		expect(
			validate({ ...user, payment: { method: "pix", last4: "1234" } }),
		).toBe(false);
		expect(
			validate({ ...user, payment: { method: "card", last4: "1234" } }),
		).toBe(true);
	});

	test("a variant is oneOf, without the OpenAPI discriminator", () => {
		const Payment = variantOf("method", { card: Card, pix: Pix });
		const schema = jsonSchemaOf(Payment);
		expect(schema.discriminator).toBeUndefined();
		expect(schema.oneOf).toEqual(
			(toOpenAPI(Payment) as { oneOf: unknown }).oneOf,
		);
		const validate = validatorOf(Payment);
		expect(validate({ method: "card", last4: "1234" })).toBe(true);
		expect(validate({ method: "boleto" })).toBe(false);
	});

	test("anything else throws InvalidOpenAPIModel", () => {
		expect(() => jsonSchemaOf({ x: 1 } as never)).toThrow(InvalidOpenAPIModel);
	});
});
