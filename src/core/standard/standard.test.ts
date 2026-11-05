import { expect, expectTypeOf, test } from "bun:test";
import { Type } from "typebox";
import { blueprintOf } from "../../std/blueprint";
import { Email } from "../../std/properties/contact";
import { Slug } from "../../std/properties/identity";
import { Password } from "../../std/properties/password";
import { listOf } from "../blueprint/list";
import { optionalOf } from "../blueprint/optional";
import { propertyOf } from "../property/property";
import { MASK } from "../record/mask";
import { recordOf } from "../record/record";
import type { StandardSchemaV1 } from "./standard-schema";

const Name = propertyOf({
	name: "name",
	schema: Type.String({ minLength: 3 }),
	preHandle: (value) => value.trim(),
});
const Nickname = optionalOf(Name);

const Address = blueprintOf((ctx) => ({ street: ctx.string, zip: ctx.string }));
const Tags = listOf(Name, { maxItems: 2 });

class Author extends recordOf(
	blueprintOf((ctx) => ({ name: ctx.text, password: ctx.password })),
) {}

const PostBlueprint = blueprintOf((ctx) => ({
	title: ctx.text,
	slug: ctx.slug,
	nickname: ctx.optional.string,
	address: Address,
	billing: optionalOf(Address),
	addresses: listOf(Address),
	author: Author,
	tags: Tags,
}));

class Post extends recordOf(PostBlueprint) {}

const password = Password.demo().value;

const validPost = {
	title: "Hello",
	slug: "Olá Mundo",
	address: { street: "Main St", zip: "1" },
	addresses: [{ street: "Side St", zip: "2" }],
	author: { name: "Jane", password },
	tags: ["abc"],
};

/** The result of `validate`, which afora always gives at once. */
function run(
	schema: StandardSchemaV1,
	value: unknown,
): StandardSchemaV1.Result<unknown> {
	const result = schema["~standard"].validate(value);
	if (result instanceof Promise) throw new Error("async");
	return result;
}

/** What a consumer that only knows Standard Schema does: the output, or a throw. */
function check<S extends StandardSchemaV1>(
	schema: S,
	value: unknown,
): StandardSchemaV1.InferOutput<S> {
	const result = schema["~standard"].validate(value);
	if (result instanceof Promise) throw new Error("async");
	if (result.issues) throw new Error(JSON.stringify(result.issues));
	return result.value;
}

test("the types of a property class", () => {
	expectTypeOf<
		StandardSchemaV1.InferInput<typeof Name>
	>().toEqualTypeOf<string>();
	expectTypeOf<
		StandardSchemaV1.InferOutput<typeof Name>
	>().toEqualTypeOf<string>();
	expectTypeOf<
		StandardSchemaV1.InferOutput<typeof Slug>
	>().toEqualTypeOf<string>();
	expectTypeOf<StandardSchemaV1.InferOutput<typeof Nickname>>().toEqualTypeOf<
		string | undefined
	>();
	expectTypeOf<StandardSchemaV1.InferInput<typeof Nickname>>().toEqualTypeOf<
		string | undefined
	>();
});

test("the types of a blueprint", () => {
	type Output = StandardSchemaV1.InferOutput<typeof PostBlueprint>;
	type Input = StandardSchemaV1.InferInput<typeof PostBlueprint>;

	expectTypeOf<Output["address"]>().toEqualTypeOf<{
		street: string;
		zip: string;
	}>();
	expectTypeOf<Output["billing"]>().toEqualTypeOf<
		{ street: string; zip: string } | undefined
	>();
	expectTypeOf<Output["nickname"]>().toEqualTypeOf<string | undefined>();
	expectTypeOf<Output["addresses"]>().toEqualTypeOf<
		{ street: string; zip: string }[]
	>();
	expectTypeOf<Output["author"]>().toEqualTypeOf<InstanceType<typeof Author>>();
	expectTypeOf<Output["tags"]>().toEqualTypeOf<string[]>();
	expectTypeOf<Input["author"]>().toEqualTypeOf<
		InstanceType<typeof Author> | { name: string; password: string }
	>();
	expectTypeOf<Output>().not.toBeAny();
	expectTypeOf<Input>().not.toBeAny();
});

test("the types of an optional blueprint", () => {
	const Billing = optionalOf(Address);
	expectTypeOf<StandardSchemaV1.InferOutput<typeof Billing>>().toEqualTypeOf<
		{ street: string; zip: string } | undefined
	>();
	expectTypeOf<StandardSchemaV1.InferInput<typeof Billing>>().toEqualTypeOf<
		{ street: string; zip: string } | undefined
	>();
});

test("the types of a list", () => {
	const Optional = optionalOf(Tags);
	expectTypeOf<StandardSchemaV1.InferOutput<typeof Tags>>().toEqualTypeOf<
		string[]
	>();
	expectTypeOf<StandardSchemaV1.InferOutput<typeof Optional>>().toEqualTypeOf<
		string[] | undefined
	>();
});

test("the types of a record class, a subclass included", () => {
	expectTypeOf<StandardSchemaV1.InferOutput<typeof Post>>().not.toBeAny();
	expectTypeOf<
		StandardSchemaV1.InferOutput<typeof Post>["title"]
	>().toEqualTypeOf<string>();
	expectTypeOf<InstanceType<typeof Post>>().toExtend<
		StandardSchemaV1.InferOutput<typeof Post>
	>();
	expectTypeOf<StandardSchemaV1.InferInput<typeof Post>>().toEqualTypeOf<
		StandardSchemaV1.InferInput<typeof PostBlueprint>
	>();
});

test("a generic consumer gets the output type, never any", () => {
	const slug = check(Slug, "Olá Mundo");
	const post = check(Post, validPost);
	const address = check(Address, validPost.address);
	const tags = check(Tags, ["abc"]);

	expectTypeOf(slug).toEqualTypeOf<string>();
	expectTypeOf(slug).not.toBeAny();
	expectTypeOf(post).not.toBeAny();
	expectTypeOf(post.title).toEqualTypeOf<string>();
	expectTypeOf(address).toEqualTypeOf<{ street: string; zip: string }>();
	expectTypeOf(tags).toEqualTypeOf<string[]>();
});

test("vendor and version", () => {
	for (const schema of [Name, Address, Tags, Post, optionalOf(Address)]) {
		expect(schema["~standard"].vendor).toBe("afora");
		expect(schema["~standard"].version).toBe(1);
	}
});

test("a property class gives the handled value", () => {
	expect(check(Slug, "Olá Mundo")).toBe("ola-mundo");
	expect(run(Name, "  abc ")).toEqual({ value: "abc" });
	expect(run(Name, "a")).toMatchObject({
		issues: [{ path: [] }],
	});
	expect(run(Name, 42)).toMatchObject({
		issues: [{ path: [] }],
	});
	expect(run(Email, "nope")).toHaveProperty("issues");
});

test("an optional property class accepts undefined, the class it came from does not", () => {
	expect(run(Nickname, undefined)).toEqual({
		value: undefined,
	});
	expect(run(Nickname, "abc")).toEqual({ value: "abc" });
	expect(run(Name, undefined)).toHaveProperty("issues");
});

test("a subclass reads its own Standard Schema", () => {
	expect(Slug["~standard"]).not.toBe(Name["~standard"]);
	expect(run(Slug, "A B")).toEqual({ value: "a-b" });
});

test("a blueprint gives the handled object, records as instances", () => {
	const result = run(PostBlueprint, validPost);
	if (result.issues) throw new Error("expected a value");
	const value = result.value as { slug: string; author: unknown };

	expect(value.slug).toBe("ola-mundo");
	expect(value.author).toBeInstanceOf(Author);
	expect(Object.isFrozen(value)).toBe(true);
});

test("a blueprint reports every issue with its path", () => {
	const result = run(PostBlueprint, {
		...validPost,
		title: 1,
		addresses: [
			{ street: "Side St", zip: 2 },
			{ street: "A", zip: "1" },
		],
		tags: ["abc", "d", "efg"],
		extra: true,
	});
	if (!result.issues) throw new Error("expected issues");
	const paths = result.issues.map((issue) => issue.path);

	expect(paths).toContainEqual(["extra"]);
	expect(paths).toContainEqual(["title"]);
	expect(paths).toContainEqual(["addresses", 0, "zip"]);
	expect(paths).toContainEqual(["tags"]);
	expect(paths).toContainEqual(["tags", 1]);
	for (const issue of result.issues)
		expect(typeof issue.message).toBe("string");
});

test("an optional blueprint accepts undefined", () => {
	const Billing = optionalOf(Address);
	expect(run(Billing, undefined)).toEqual({
		value: undefined,
	});
	expect(run(Billing, validPost.address)).toEqual({
		value: validPost.address,
	});
	expect(run(Billing, {})).toHaveProperty("issues");
	expect(run(Address, undefined)).toHaveProperty("issues");
	expect(Billing["~standard"]).not.toBe(Address["~standard"]);
});

test("a joined blueprint has its own Standard Schema", () => {
	const Joined = Address.join(blueprintOf((ctx) => ({ city: ctx.string })));
	expect(Joined["~standard"]).not.toBe(Address["~standard"]);
	expect(run(Joined, { street: "S", zip: "1", city: "C" })).toEqual({
		value: { street: "S", zip: "1", city: "C" },
	});
	expect(run(Address, { street: "S", zip: "1", city: "C" })).toHaveProperty(
		"issues",
	);
});

test("the Standard Schema does not leak into what is spread or listed", () => {
	expect(Object.keys(Address)).not.toContain("~standard");
	expect(Object.keys(optionalOf(Address))).not.toContain("~standard");
	expect(Object.keys(Tags)).not.toContain("~standard");
});

test("a list gives a frozen array of handled items", () => {
	const result = run(Tags, [" abc ", "defg"]);
	if (result.issues) throw new Error("expected a value");

	expect(result.value).toEqual(["abc", "defg"]);
	expect(Object.isFrozen(result.value)).toBe(true);
	expect(run(Tags, "abc")).toHaveProperty("issues");
	expect(run(Tags, ["a"])).toMatchObject({
		issues: [{ path: [0] }],
	});
	expect(run(Tags, undefined)).toHaveProperty("issues");
	expect(run(optionalOf(Tags), undefined)).toEqual({ value: undefined });
});

test("a record class gives an instance, with its getters and masking", () => {
	const result = run(Author, {
		name: "Jane",
		password,
	});
	if (result.issues) throw new Error("expected a value");
	const author = result.value as InstanceType<typeof Author>;

	expect(author).toBeInstanceOf(Author);
	expect(author.name).toBe("Jane");
	expect(author.toJSON()).toEqual({ name: "Jane", password: MASK });
});

test("a record subclass gives an instance of the subclass", () => {
	const result = run(Post, validPost);
	if (result.issues) throw new Error("expected a value");
	const post = result.value as InstanceType<typeof Post>;

	expect(post).toBeInstanceOf(Post);
	expect(post.slug).toBe("ola-mundo");
	expect(post.author).toBeInstanceOf(Author);
	expect(run(Post, { ...validPost, title: 1 })).toMatchObject({
		issues: [{ path: ["title"] }],
	});
});

test("a plain object for a record field becomes an instance", () => {
	const result = run(PostBlueprint, validPost);
	if (result.issues) throw new Error("expected a value");
	expect((result.value as { author: unknown }).author).toBeInstanceOf(Author);
});

test("an optional record accepts undefined", () => {
	const Maybe = optionalOf(Author);
	expect(run(Maybe, undefined)).toEqual({ value: undefined });
	expect(run(Maybe, { name: "Jane", password })).not.toHaveProperty("issues");
	expect(run(Maybe, 42)).toHaveProperty("issues");
	expect(run(Author, undefined)).toHaveProperty("issues");
});

test("validate never throws for a value of the wrong kind", () => {
	const schemas = [
		Name,
		Nickname,
		Slug,
		Email,
		Password,
		Address,
		optionalOf(Address),
		PostBlueprint,
		Tags,
		Author,
		Post,
		optionalOf(Author),
	];
	for (const schema of schemas) {
		for (const value of [null, 42, "x", [], true, () => 1, Symbol("s")]) {
			expect(() => run(schema, value)).not.toThrow();
		}
	}
	for (const schema of [Address, PostBlueprint, Author, Post]) {
		for (const value of [null, 42, "x", []]) {
			expect(run(schema, value)).toHaveProperty("issues");
		}
	}
});

test("validate is synchronous", () => {
	for (const schema of [Name, Address, Tags, Author, Post]) {
		expect(schema["~standard"].validate(null)).not.toBeInstanceOf(Promise);
	}
});

test("the same Standard Schema comes back on every read", () => {
	for (const schema of [Name, Nickname, Slug, Address, Tags, Author, Post]) {
		expect(schema["~standard"]).toBe(schema["~standard"]);
	}
	expect(optionalOf(Address)["~standard"]).toBe(
		optionalOf(Address)["~standard"],
	);
	expect(optionalOf(Author)["~standard"]).toBe(optionalOf(Author)["~standard"]);
	expect(optionalOf(Tags)["~standard"]).toBe(optionalOf(Tags)["~standard"]);
});
