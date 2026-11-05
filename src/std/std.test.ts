import { describe, expect, expectTypeOf, test } from "bun:test";
import { Type } from "typebox";
import { listOf } from "../core/blueprint/list";
import { optionalOf } from "../core/blueprint/optional";
import type { BlueprintValue } from "../core/blueprint/types/blueprint.interface";
import { recordOf } from "../core/record/record";
import { blueprintOf } from "./blueprint";
import { Std } from "./blueprint-plugin";
import { Email, Ip, Phone, Url } from "./properties/contact";
import { enumOf } from "./properties/enum";
import { SchemaProperty } from "./properties/headless";
import { Id, Slug } from "./properties/identity";
import {
	isPasswordHash,
	PASSWORD_MAX_LENGTH,
	Password,
	passwordIssues,
} from "./properties/password";
import { BooleanProperty, Integer, Text } from "./properties/primitives";
import { CreatedAt, DateTime, DeletedAt, UpdatedAt } from "./properties/time";

describe("Password", () => {
	test("hash() hashes a strong plain password with argon2id", async () => {
		const password = await Password.hash("Str0ng!pass");

		expect(password).toBeInstanceOf(Password);
		expect(password.value).toStartWith("$argon2id$");
		expect(isPasswordHash(password.value)).toBe(true);
	});

	test("hash() rejects a weak plain password, listing every broken rule", async () => {
		await expect(Password.hash("abc")).rejects.toThrow(
			/at least 7 characters.*uppercase letter.*number.*special character/,
		);
		await expect(Password.hash("Abcdefg1")).rejects.toThrow(
			"special character",
		);
		await expect(Password.hash("ABCDEF!1")).rejects.toThrow("lowercase letter");
		await expect(Password.hash("Abcdef!g")).rejects.toThrow("number");
	});

	test("passwordIssues accepts any listed special character", () => {
		for (const char of "!@#$%^&*()-_=+[]{}|\\;:'\",.<>/?`~") {
			expect(passwordIssues(`Abcdef1${char}`)).toEqual([]);
		}
	});

	test("a plain password longer than the maximum is rejected", async () => {
		const long = `Aa1!${"a".repeat(PASSWORD_MAX_LENGTH - 3)}`;

		expect(passwordIssues(long)).toEqual([
			`must have at most ${PASSWORD_MAX_LENGTH} characters`,
		]);
		expect(
			passwordIssues(`Aa1!${"a".repeat(PASSWORD_MAX_LENGTH - 4)}`),
		).toEqual([]);
		await expect(Password.hash(long)).rejects.toThrow("at most 128 characters");
	});

	test("the constructor keeps an argon2 hash and rejects a plain password", async () => {
		const hash = (await Password.hash("Str0ng!pass")).value;

		expect(new Password(hash).value).toBe(hash);
		expect(() => new Password("Str0ng!pass")).toThrow(
			'Invalid value for property "password"',
		);
	});

	test("verifies an input against the stored hash", async () => {
		const stored = new Password((await Password.hash("Str0ng!pass")).value);

		expect(await stored.verify("Str0ng!pass")).toBe(true);
		expect(await stored.verify("wrong")).toBe(false);
		expect(stored.verifySync("Str0ng!pass")).toBe(true);
		expect(stored.verifySync("Str0ng!pas")).toBe(false);
	});

	test("demo() returns a Password", () => {
		expect(Password.demo().verifySync("Demo@123")).toBe(true);
	});
});

describe("Id", () => {
	test("generates a UUID v7", () => {
		const a = Id.generate();
		const b = Id.generate();

		expect(a.value).not.toBe(b.value);
		expect(a.value[14]).toBe("7");
	});

	test("rejects other UUID versions and lower-cases the value", () => {
		expect(() => new Id(crypto.randomUUID())).toThrow('"id"');
		expect(new Id("01A173D2-051C-77BB-8166-A371E999573E").value).toBe(
			"01a173d2-051c-77bb-8166-a371e999573e",
		);
	});
});

describe("contact", () => {
	test("Email trims and lower-cases", () => {
		expect(new Email("  Ana@Example.COM ").value).toBe("ana@example.com");
		expect(() => new Email("not-an-email")).toThrow();
	});

	test("a value of the wrong type is rejected before preHandle", () => {
		expect(() => new Email(123 as never)).toThrow(
			'Invalid value for property "email"',
		);
		expect(() => new Phone(null as never)).toThrow(
			'Invalid value for property "phone"',
		);
		expect(() => new Ip({} as never)).toThrow(
			'Invalid value for property "ip"',
		);
	});

	test("Phone is normalized to E.164", () => {
		expect(new Phone("+55 (11) 99999-9999").value).toBe("+5511999999999");
		expect(() => new Phone("11999999999")).toThrow();
	});

	test("Url and Ip", () => {
		expect(new Url("https://example.com/a?b=1").value).toBe(
			"https://example.com/a?b=1",
		);
		expect(() => new Url("example")).toThrow();
		expect(new Ip("::1").value).toBe("::1");
		expect(new Ip("10.0.0.1").value).toBe("10.0.0.1");
		expect(() => new Ip("999.0.0.1")).toThrow();
	});
});

describe("primitives and time", () => {
	test("Slug, Text, Integer and Boolean", () => {
		expect(new Slug("my-post-1").value).toBe("my-post-1");
		expect(() => new Text("   ")).toThrow();
		expect(() => new Integer(1.5)).toThrow();
		expect(new BooleanProperty(true).value).toBe(true);
	});

	test("timestamps are ISO date-times", () => {
		expect(new Date(CreatedAt.now().value).getTime()).not.toBeNaN();
		expect(() => new DateTime("yesterday")).toThrow();
		expect(new DeletedAt(undefined).value).toBeUndefined();
	});

	test("now() makes an instance of its class at the current time", () => {
		const before = Date.now();

		expect(DateTime.now()).toBeInstanceOf(DateTime);
		expect(CreatedAt.now()).toBeInstanceOf(CreatedAt);
		expect(UpdatedAt.now()).toBeInstanceOf(UpdatedAt);
		expect(DeletedAt.now()).toBeInstanceOf(DeletedAt);
		expect(Date.parse(UpdatedAt.now().value ?? "")).toBeGreaterThanOrEqual(
			before,
		);
		expectTypeOf(CreatedAt.now()).toEqualTypeOf<CreatedAt>();
		expectTypeOf(DeletedAt.now()).toEqualTypeOf<DeletedAt>();
	});

	test("timestamps keep their names, and only UpdatedAt and DeletedAt are optional", () => {
		expect(
			[DateTime, CreatedAt, UpdatedAt, DeletedAt].map((Property) => [
				Property.name,
				Property.type.name,
				Property.type.optional,
			]),
		).toEqual([
			["DateTime", "dateTime", false],
			["CreatedAt", "createdAt", false],
			["UpdatedAt", "updatedAt", true],
			["DeletedAt", "deletedAt", true],
		]);
		expect(new UpdatedAt(undefined).value).toBeUndefined();
		expect(DeletedAt.demo().value).toBeUndefined();
		expect(() => new CreatedAt(undefined as never)).toThrow("is required");
	});
});

describe("Slug", () => {
	test("slugifies the value: lower-case, no special characters", () => {
		expect(new Slug("  Olá Mundo! ").value).toBe("ola-mundo");
		expect(new Slug("Not A Slug").value).toBe("not-a-slug");
		expect(new Slug("Hello, World!").value).toBe("hello-world");
		expect(new Slug("my-post-1").value).toBe("my-post-1");
	});

	test("a value with nothing left to slugify is invalid", () => {
		expect(() => new Slug("!!!")).toThrow();
		expect(() => new Slug("   ")).toThrow();
	});

	test("an optional Slug is still a Slug, and slugifies", () => {
		const OptionalSlug = optionalOf(Slug);
		expect(OptionalSlug.prototype instanceof Slug).toBe(true);
		expect(new OptionalSlug("Olá").value).toBe("ola");
		expect(new OptionalSlug(undefined).value).toBeUndefined();
	});
});

describe("SchemaProperty", () => {
	const Post = Type.Object({
		title: Type.String({ minLength: 3 }),
		tags: Type.Array(Type.String()),
	});

	test("holds a TypeBox schema and validates data against it", () => {
		const schema = new SchemaProperty(Post);

		expect(schema.value).toBe(Post);
		expect(schema.match({ title: "Hello", tags: [] })).toBe(true);
		expect(schema.match({ title: "Hi", tags: [] })).toBe(false);
		expect(schema.errors({ title: "Hi", tags: [] })).toEqual([
			"/title: must not have fewer than 3 characters",
		]);
	});

	test("serialize and deserialize round-trip the schema", () => {
		const json = new SchemaProperty(Post).serialize();
		const schema = SchemaProperty.deserialize(json);

		expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(Post)));
		expect(schema.serialize()).toBe(json);
		expect(schema.match({ title: "Hello", tags: ["a"] })).toBe(true);
		expect(schema.match({ title: "Hello", tags: [1] })).toBe(false);
	});

	test("rejects values that are not a JSON Schema object", () => {
		expect(() => new SchemaProperty({ type: "strin" } as never)).toThrow(
			'Invalid value for property "schema"',
		);
		expect(() => new SchemaProperty(true as never)).toThrow('"schema"');
		expect(() => SchemaProperty.deserialize("{not json")).toThrow('"schema"');
		expect(() => SchemaProperty.deserialize('"string"')).toThrow('"schema"');
	});
});

describe("enumOf", () => {
	const Status = enumOf(["draft", "published"]);

	test("accepts only the listed values", () => {
		expect(new Status("published").value).toBe("published");
		expectTypeOf(new Status("draft").value).toEqualTypeOf<
			"draft" | "published"
		>();
		// @ts-expect-error not a listed value
		expect(() => new Status("archived")).toThrow(
			'Invalid value for property "enum"',
		);
		expect(Status.safeParse("archived")).toMatchObject({
			issues: [{ code: "invalid_value", source: "enum" }],
		});
	});

	test("demo() is the first value unless `default` is given", () => {
		expect(Status.demo().value).toBe("draft");
		expect(
			enumOf(["draft", "published"], { default: "published" }).demo().value,
		).toBe("published");
	});

	test("takes numbers, a name and `optional`", () => {
		const Level = enumOf([1, 2, 3], { name: "level", optional: true });

		expect(new Level(2).value).toBe(2);
		expect(new Level(undefined).value).toBeUndefined();
		expect(() => new Level(4 as never)).toThrow('property "level"');
	});

	test("is in the blueprint context as `ctx.enumOf`", () => {
		const Post = blueprintOf((ctx) => ({
			title: ctx.text,
			status: ctx.enumOf(["draft", "published"], { name: "status" }),
		}));

		expect(Std.factories?.enumOf).toBe(enumOf);
		expect(Post.safeParse({ title: "Hi", status: "draft" })).toEqual({
			value: { title: "Hi", status: "draft" },
		});
		expect(Post.safeParse({ title: "Hi", status: "x" })).toMatchObject({
			issues: [{ path: ["status"], source: "status" }],
		});
		expectTypeOf<BlueprintValue<typeof Post.properties>>().toEqualTypeOf<{
			title: string;
			status: "draft" | "published";
		}>();
	});

	test("goes in lists and optional fields, as any property", () => {
		const Post = blueprintOf((ctx) => ({
			tags: listOf(ctx.enumOf(["news", "tech"]), { minItems: 1 }),
			status: optionalOf(ctx.enumOf(["draft", "published"])),
			level: ctx.enumOf([1, 2, 3], { optional: true }),
			grid: listOf(listOf(ctx.enumOf([0, 1]))),
		}));

		expect(Post.safeParse({ tags: ["news"], grid: [[0, 1], [1]] })).toEqual({
			value: { tags: ["news"], grid: [[0, 1], [1]] },
		});
		expect(Post.safeParse({ tags: [], grid: [] })).toHaveProperty("issues");
		expect(
			Post.safeParse({ tags: ["sports"], status: "x", level: 4, grid: [[2]] }),
		).toMatchObject({
			issues: [
				{ path: ["tags", 0] },
				{ path: ["status"] },
				{ path: ["level"] },
				{ path: ["grid", 0, 0] },
			],
		});
		expectTypeOf<BlueprintValue<typeof Post.properties>>().toEqualTypeOf<{
			tags: ("news" | "tech")[];
			status?: "draft" | "published";
			level?: 1 | 2 | 3;
			grid: (0 | 1)[][];
		}>();
	});

	test("composes with ctx.listOf and ctx.optionalOf", () => {
		const Post = blueprintOf((ctx) => ({
			tags: ctx.listOf(ctx.enumOf(["news", "tech"]), { minItems: 1 }),
			status: ctx.optionalOf(ctx.enumOf(["draft", "published"])),
			drafts: ctx.optionalOf(ctx.listOf(ctx.enumOf([1, 2]))),
		}));

		expect(Post.safeParse({ tags: ["tech"] })).toEqual({
			value: { tags: ["tech"] },
		});
		expect(
			Post.safeParse({ tags: ["x"], status: "x", drafts: [3] }),
		).toMatchObject({
			issues: [
				{ path: ["tags", 0] },
				{ path: ["status"] },
				{ path: ["drafts", 0] },
			],
		});
		expectTypeOf<BlueprintValue<typeof Post.properties>>().toEqualTypeOf<{
			tags: ("news" | "tech")[];
			status?: "draft" | "published";
			drafts?: (1 | 2)[];
		}>();
	});

	test("is a record field, its Standard Schema and its changes checked", async () => {
		class Post extends recordOf(
			blueprintOf((ctx) => ({
				status: ctx.enumOf(["draft", "published"], { name: "status" }),
			})),
			{ change: ["status"] },
		) {}
		const post = new Post({ status: "draft" });

		post.change.status("published");
		expect(post.status).toBe("published");
		expect(() => post.change.status("x" as never)).toThrow('"status"');

		const result = await Post["~standard"].validate({ status: "x" });
		expect(result.issues?.[0]).toMatchObject({ path: ["status"] });
	});
});

test("every std property has a valid demo", () => {
	const properties: { demo(): unknown }[] = Object.values(Std.properties);

	for (const Property of properties) {
		expect(() => Property.demo()).not.toThrow();
	}
});

test("blueprints pick from Std", async () => {
	const User = blueprintOf([Std], (ctx) => ({
		id: ctx.id,
		email: ctx.email,
		password: ctx.password,
		createdAt: ctx.createdAt,
		updatedAt: ctx.updatedAt,
		deletedAt: ctx.deletedAt,
	}));

	expectTypeOf<BlueprintValue<typeof User.properties>>().toEqualTypeOf<{
		id: string;
		email: string;
		password: string;
		createdAt: string;
		updatedAt?: string;
		deletedAt?: string;
	}>();
	expect(
		User.schema.match({
			id: Id.generate().value,
			email: "a@b.co",
			password: (await Password.hash("Str0ng!pass")).value,
			createdAt: CreatedAt.now().value,
		}),
	).toBe(true);
});

test("blueprintOf uses Std when given only the definition", () => {
	const User = blueprintOf((ctx) => ({
		email: ctx.email,
		password: ctx.password,
	}));

	expect(User.plugins).toEqual([Std]);
	expect(User.properties).toEqual({ email: Email, password: Password });
	expectTypeOf<BlueprintValue<typeof User.properties>>().toEqualTypeOf<{
		email: string;
		password: string;
	}>();
	// @ts-expect-error `name` is not in Std
	expect(() => blueprintOf((ctx) => ({ name: ctx.name }))).toThrow(
		'Property "name" of the blueprint is not declared.',
	);
});
