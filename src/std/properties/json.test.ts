import { describe, expect, expectTypeOf, test } from "bun:test";
import { Type } from "typebox";
import {
	blueprintOf,
	checkJsonSchema,
	commandOf,
	entityOf,
	InvalidJsonData,
	InvalidJsonSchema,
	inMemoryProvider,
	JsonProperty,
	type JsonValue,
	jsonOf,
	jsonSchemaIssues,
	recordOf,
	repositoryOf,
	statusOf,
} from "../../index";

describe("ctx.json", () => {
	const Doc = recordOf(blueprintOf((ctx) => ({ data: ctx.json })));

	test("holds any JSON value", () => {
		for (const data of [null, true, 1.5, "a", [1, [2]], { a: { b: [null] } }]) {
			expect(new Doc({ data }).data).toEqual(data);
		}
		expectTypeOf(new Doc({ data: 1 }).data).toEqualTypeOf<JsonValue>();
	});

	test("rejects what JSON cannot hold, at any depth", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		for (const [data, message] of [
			[undefined, "is required"],
			[Number.NaN, "is not JSON (NaN)"],
			[{ a: [1, undefined] }, "/a/1: is not JSON (undefined)"],
			[{ f: () => 1 }, "/f: is not JSON (function)"],
			[{ at: new Date(0) }, "/at: is not JSON (an instance of Date)"],
			[cyclic, "/self: is circular"],
		] as const) {
			const result = Doc.safeParse({ data });
			expect(result.issues?.[0]?.path).toEqual(["data"]);
			expect(result.issues?.[0]?.message).toContain(message);
		}
		expect(() => new JsonProperty(Infinity)).toThrow(
			'Invalid value for property "json": is not JSON (Infinity)',
		);
	});
});

describe("jsonOf", () => {
	test("checks a JSON Schema written as JSON, typed by it", () => {
		const Seo = jsonOf({
			name: "seo",
			schema: {
				type: "object",
				properties: {
					title: { type: "string", maxLength: 60 },
					tags: { type: "array", items: { type: "string" } },
				},
				required: ["title"],
				additionalProperties: false,
			},
		});
		const Page = recordOf(blueprintOf(() => ({ seo: Seo })));
		const page = new Page({ seo: { title: "Home", tags: ["a"] } });
		expectTypeOf(page.seo.title).toEqualTypeOf<string>();
		expect(page.toJSON()).toEqual({ seo: { title: "Home", tags: ["a"] } });

		const result = Page.safeParse({ seo: { tags: [1], extra: true } });
		expect(result.issues?.map((issue) => issue.path)).toContainEqual([
			"seo",
			"tags",
			0,
		]);
	});

	test("takes TypeBox types, optional, and in a blueprint as ctx.jsonOf", () => {
		const Doc = recordOf(
			blueprintOf((ctx) => ({
				meta: ctx.jsonOf({
					schema: Type.Object({ n: Type.Integer() }),
					optional: true,
				}),
			})),
		);
		expect(new Doc({ meta: { n: 1 } }).meta).toEqual({ n: 1 });
		expect(new Doc({}).meta).toBeUndefined();
		expect(Doc.safeParse({ meta: { n: 1.5 } }).issues).toHaveLength(1);
		expectTypeOf(new Doc({}).meta).toEqualTypeOf<{ n: number } | undefined>();
	});

	test("rejects a schema that is not a JSON Schema", () => {
		expect(() => jsonOf({ name: "bad", schema: { type: 1 } as never })).toThrow(
			InvalidJsonSchema,
		);
	});
});

describe("checkJsonSchema", () => {
	const schema = {
		type: "object",
		properties: {
			body: { type: "string", minLength: 1 },
			"a/b": { type: "integer" },
		},
		required: ["body"],
		additionalProperties: false,
	} as const;

	test("gives the value, typed by the schema, when it is valid", () => {
		const value = checkJsonSchema(schema, { body: "Hi" }, { source: "post" });
		expectTypeOf(value.body).toEqualTypeOf<string>();
		expect(value).toEqual({ body: "Hi" });
	});

	test("gives every issue at its path, and throws them as a 400", () => {
		const data = { "a/b": 1.5, extra: 1 };
		expect(jsonSchemaIssues(schema, data, { source: "post" })).toEqual([
			{
				path: ["body"],
				code: "required",
				message: "is required",
				source: "post",
			},
			{
				path: ["extra"],
				code: "undeclared_key",
				message: "is not declared",
				source: "post",
			},
			{
				path: ["a/b"],
				code: "invalid_type",
				message: "must be integer",
				source: "post",
			},
		]);
		const error = (() => {
			try {
				return checkJsonSchema(schema, data, { source: "post" });
			} catch (thrown) {
				return thrown;
			}
		})() as InstanceType<typeof InvalidJsonData>;
		expect(error).toBeInstanceOf(InvalidJsonData);
		expect(error.details.issues).toHaveLength(3);
		expect(error.message).toBe(
			'Invalid JSON data for "post": /body: is required; /extra: is not declared; /a/b: must be integer',
		);
		expect(statusOf(error)).toBe(400);
	});

	test("a schema loaded at runtime gives a JsonValue", () => {
		const loaded: unknown = JSON.parse('{ "type": "number" }');
		const value = checkJsonSchema(loaded, 1);
		expectTypeOf(value).toEqualTypeOf<JsonValue>();
		expect(value).toBe(1);
	});

	test("rejects what is not JSON before the schema sees it", () => {
		expect(
			jsonSchemaIssues({ type: "object" }, { at: new Date(0) }),
		).toMatchObject([{ path: ["at"], code: "invalid_value", source: "json" }]);
		expect(() => checkJsonSchema({ type: 2 } as never, {})).toThrow(
			InvalidJsonSchema,
		);
	});

	test("in the before of a standard use case: data checked by a schema loaded at runtime", async () => {
		class ContentType extends entityOf(
			blueprintOf((ctx) => ({ slug: ctx.slug, schema: ctx.json })),
			{ unique: ["slug"] },
		) {}
		class Entry extends entityOf(
			blueprintOf((ctx) => ({ type: ctx.slug, data: ctx.json })),
			{ change: ["data"] },
		) {}
		const provider = inMemoryProvider();
		const ContentTypes = repositoryOf({
			entity: ContentType,
			provider,
			actions: ["findBySlug", "create"],
		});
		const Entries = repositoryOf({
			entity: Entry,
			provider,
			actions: ["findById", "create", "update"],
		});
		await ContentTypes.create(
			new ContentType({ slug: "post", schema: schema as unknown as JsonValue }),
		);
		const Cms = commandOf({
			name: "Cms",
			transaction: true,
			useCases: (ctx) => ({
				create: ctx.create(Entries, {
					dependencies: { contentTypes: ContentTypes },
					throws: [InvalidJsonData],
					before: async ({ input, dependencies }) => {
						const type = await dependencies.contentTypes.findBySlug(input.type);
						checkJsonSchema(type?.schema, input.data, {
							source: input.type,
						});
					},
				}),
			}),
		});
		const { item } = await Cms.run("create", {
			type: "post",
			data: { body: "Hi" },
		});
		expect(item.data).toEqual({ body: "Hi" });
		const error = await Cms.run("create", {
			type: "post",
			data: { body: "" },
		}).catch((thrown) => thrown);
		expect(error.name).toBe("InvalidJsonData");
		expect(error.details.issues).toEqual([
			{
				path: ["body"],
				code: "invalid_value",
				message: "must not have fewer than 1 characters",
				source: "post",
			},
		]);
		expect(statusOf(error)).toBe(400);
	});
});
