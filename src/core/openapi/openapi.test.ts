import { describe, expect, expectTypeOf, test } from "bun:test";
import { blueprintOf } from "../../std/blueprint";
import { entityOf } from "../../std/entity";
import { SchemaProperty } from "../../std/properties/headless";
import { Integer } from "../../std/properties/primitives";
import { listOf } from "../blueprint/list";
import { optionalOf } from "../blueprint/optional";
import { recordOf } from "../record/record";
import { InvalidOpenAPIModel } from "./exceptions";
import { toOpenAPI } from "./openapi";
import type { OpenAPISchema } from "./types/openapi.interface";

const Address = recordOf(
	blueprintOf((ctx) => ({
		street: ctx.text({ description: "Street and number" }),
		zip: ctx.string({ pattern: /^\d{5}-\d{3}$/, examples: ["01310-100"] }),
	})),
);

const User = entityOf(
	blueprintOf((ctx) => ({
		name: ctx.text({ max: 80 }),
		email: ctx.email,
		password: ctx.password,
		nickname: ctx.optional.string,
		age: ctx.optional.integer({ min: 0 }),
		address: optionalOf(Address),
		tags: listOf(ctx.string, { maxItems: 5 }),
	})),
);

describe("toOpenAPI of one field", () => {
	test("a property is its JSON Schema, with its metadata and without TypeBox keys", () => {
		const schema = toOpenAPI(
			Integer.with({ min: 1, description: "Units", examples: [3] }),
		);

		expect(schema).toEqual({
			type: "integer",
			minimum: 1,
			description: "Units",
			examples: [3],
		});
		expect(JSON.stringify(schema)).not.toContain("~");
		expectTypeOf(schema).toEqualTypeOf<OpenAPISchema>();
	});

	test("a blueprint is a closed object, its optional keys left out of required", () => {
		const Point = blueprintOf((ctx) => ({
			x: ctx.number,
			y: ctx.number,
			label: ctx.optional.string,
		}));

		expect(toOpenAPI(Point)).toEqual({
			type: "object",
			properties: {
				x: { type: "number" },
				y: { type: "number" },
				label: { type: "string" },
			},
			required: ["x", "y"],
			additionalProperties: false,
		});
	});

	test("a list is an array of its item, with its bounds", () => {
		expect(
			toOpenAPI(listOf(Integer.with({ min: 0 }), { minItems: 1, maxItems: 3 })),
		).toEqual({
			type: "array",
			items: { type: "integer", minimum: 0 },
			minItems: 1,
			maxItems: 3,
		});
	});

	test("an entity has its identity read-only and its sensitive keys write-only", () => {
		const schema = toOpenAPI(User);
		const properties = schema.properties ?? {};

		expect(properties.id).toMatchObject({ type: "string", readOnly: true });
		expect(properties.createdAt).toMatchObject({
			format: "date-time",
			readOnly: true,
		});
		expect(properties.updatedAt).toMatchObject({ readOnly: true });
		expect(properties.password).toMatchObject({ writeOnly: true });
		expect(properties.name).not.toHaveProperty("readOnly");
		expect(properties.age).toEqual({ type: "integer", minimum: 0 });
		expect(properties.address).toMatchObject({
			type: "object",
			properties: {
				street: { description: "Street and number" },
				zip: { examples: ["01310-100"] },
			},
			required: ["street", "zip"],
		});
		expect(schema.required).toEqual([
			"id",
			"createdAt",
			"name",
			"email",
			"password",
			"tags",
		]);
	});

	test("the keys a record lists as sensitive are write-only", () => {
		const Card = recordOf(
			blueprintOf((ctx) => ({ holder: ctx.string, number: ctx.string })),
			{ sensitive: ["number"] },
		);

		expect(toOpenAPI(Card).properties).toEqual({
			holder: { type: "string" },
			number: { type: "string", writeOnly: true },
		});
	});

	test("a nested schema with an $id is referenced, not copied", () => {
		expect(toOpenAPI(SchemaProperty)).toEqual({
			type: "object",
			allOf: [{ $ref: "https://json-schema.org/draft/2020-12/schema" }],
		});
	});
});

describe("toOpenAPI of named models", () => {
	test("gives components, a record named among them as a $ref", () => {
		const Post = entityOf(
			blueprintOf((ctx) => ({ title: ctx.text, author: User })),
		);

		const components = toOpenAPI({ User, Post, Address });

		expect(Object.keys(components.schemas)).toEqual([
			"User",
			"Post",
			"Address",
		]);
		expect(components.schemas.Post.properties?.author).toEqual({
			$ref: "#/components/schemas/User",
		});
		expect(components.schemas.User.properties?.address).toEqual({
			$ref: "#/components/schemas/Address",
		});
		expect(components.schemas.User).toMatchObject({ type: "object" });
		expect(components.schemas.User).toEqual(
			toOpenAPI({ User, Address }).schemas.User,
		);
		expectTypeOf(components.schemas).toEqualTypeOf<{
			readonly User: OpenAPISchema;
			readonly Post: OpenAPISchema;
			readonly Address: OpenAPISchema;
		}>();
	});

	test("records not named are inline, and refPrefix changes the $ref", () => {
		const Post = entityOf(
			blueprintOf((ctx) => ({ title: ctx.text, author: User })),
		);

		expect(toOpenAPI({ Post }).schemas.Post.properties?.author).toMatchObject({
			type: "object",
		});
		expect(
			toOpenAPI({ Post, User }, { refPrefix: "#/$defs/" }).schemas.Post
				.properties?.author,
		).toEqual({ $ref: "#/$defs/User" });
	});

	test("rejects a model that is not a field", () => {
		expect(() => toOpenAPI({ User, Broken: { nope: true } } as never)).toThrow(
			InvalidOpenAPIModel,
		);
	});
});
