import { expect, expectTypeOf, test } from "bun:test";
import { Type } from "typebox";
import { blueprintOf } from "../../std/blueprint";
import { Email } from "../../std/properties/contact";
import { Id, Slug } from "../../std/properties/identity";
import { Password } from "../../std/properties/password";
import { listOf } from "../blueprint/list";
import { optionalOf } from "../blueprint/optional";
import type { BlueprintValue } from "../blueprint/types/blueprint.interface";
import { ExceptionLayers } from "../exception/enums/exception-layers";
import { Exception } from "../exception/exception";
import { InvalidPropertyValue, PropertyRequired } from "../property/exceptions";
import { propertyOf } from "../property/property";
import {
	InvalidRecordValue,
	UndeclaredRecordProperty,
} from "../record/exceptions";
import { recordOf } from "../record/record";
import { parseCollection, parseField } from "./parse";
import type { Issue, ParseResult } from "./types/parse.interface";

const Address = blueprintOf((ctx) => ({
	street: ctx.string,
	zip: ctx.string,
}));

const Profile = blueprintOf((ctx) => ({
	name: ctx.string,
	address: Address,
	billing: optionalOf(Address),
	addresses: listOf(Address, { minItems: 1, maxItems: 2 }),
	tags: listOf(listOf(ctx.string)),
}));

const profile = {
	name: "Jane",
	address: { street: "Main St", zip: "1" },
	addresses: [{ street: "Main St", zip: "1" }],
	tags: [["a"]],
};

function issuesOf(result: ParseResult<unknown>): readonly Issue[] {
	if (!result.issues) throw new Error("expected issues");
	return result.issues;
}

function paths(result: ParseResult<unknown>): (string | number)[][] {
	return issuesOf(result).map((issue) => [...issue.path]);
}

test("a valid value is handled, frozen and stripped of undefined keys", () => {
	const result = parseCollection(
		Profile.properties,
		{ ...profile, billing: undefined },
		[],
		"test",
	);

	expect(result.issues).toBeUndefined();
	expect(result.issues ?? result).toEqual({ value: profile });
	const value = (result as { value: Record<string, unknown> }).value;
	expect(Object.keys(value)).not.toContain("billing");
	expect(Object.isFrozen(value)).toBe(true);
	expect(Object.isFrozen(value.addresses)).toBe(true);
	expect(Object.isFrozen(value.address)).toBe(true);
});

test("every issue is collected, in the order of the blueprint", () => {
	const result = Profile.safeParse({
		name: 1,
		address: { street: "Main St" },
		addresses: [],
		tags: "x",
	});

	expect(
		issuesOf(result).map(({ code, path }) => [code, path.join(".")]),
	).toEqual([
		["invalid_value", "name"],
		["required", "address.zip"],
		["too_few_items", "addresses"],
		["invalid_type", "tags"],
	]);
});

test("every undeclared key is an issue, first, at its depth", () => {
	const result = Profile.safeParse({
		...profile,
		name: undefined,
		extra: 1,
		address: { ...profile.address, more: 2 },
		addresses: [{ street: "a", zip: "b", other: 3 }],
	});

	expect(
		issuesOf(result).map(({ code, path }) => [code, path.join(".")]),
	).toEqual([
		["undeclared_key", "extra"],
		["required", "name"],
		["undeclared_key", "address.more"],
		["undeclared_key", "addresses.0.other"],
	]);
});

test("a nested issue has the full path, numbers for list items", () => {
	const result = Profile.safeParse({
		...profile,
		addresses: [{ street: "Main St", zip: "1" }, { street: 2 }],
		tags: [["a"], [3]],
	});

	expect(paths(result)).toEqual([
		["addresses", 1, "street"],
		["addresses", 1, "zip"],
		["tags", 1, 0],
	]);
});

test("lists check their size and every item, even when the size is wrong", () => {
	const result = Profile.safeParse({
		...profile,
		addresses: [{}, {}, {}],
	});

	expect(
		issuesOf(result).map(({ code, path }) => [code, path.join(".")]),
	).toEqual([
		["too_many_items", "addresses"],
		["required", "addresses.0.street"],
		["required", "addresses.0.zip"],
		["required", "addresses.1.street"],
		["required", "addresses.1.zip"],
		["required", "addresses.2.street"],
		["required", "addresses.2.zip"],
	]);
	expect(issuesOf(result)[0]?.message).toBe("must have at most 2 items");
});

test("something that is not an object is an invalid_type at its path", () => {
	for (const value of [null, "x", 1, [], undefined]) {
		const [issue] = issuesOf(Profile.safeParse(value));
		expect(issue).toMatchObject({
			code: "invalid_type",
			message: "must be an object",
			path: [],
			source: "blueprint",
		});
	}

	expect(paths(Profile.safeParse({ ...profile, address: "x" }))).toEqual([
		["address"],
	]);
});

test("optional blueprints and lists accept undefined, required ones do not", () => {
	expect(Profile.safeParse({ ...profile, billing: undefined })).toEqual({
		value: profile,
	});
	const [issue] = issuesOf(
		Profile.safeParse({ ...profile, address: undefined }),
	);
	expect(issue).toMatchObject({ code: "required", path: ["address"] });
});

test("a property issue keeps the exception it raised as its cause", () => {
	const [name] = issuesOf(Profile.safeParse({ ...profile, name: 1 }));
	expect(name?.cause).toBeInstanceOf(InvalidPropertyValue);
	expect(name?.source).toBe("string");

	const [zip] = issuesOf(
		Profile.safeParse({ ...profile, address: { street: "Main St" } }),
	);
	expect(zip).toMatchObject({ code: "required", source: "string" });
	expect(zip?.cause).toBeInstanceOf(PropertyRequired);
});

test("parseField handles one field at a path", () => {
	const result = parseField(Address, { street: 1 }, ["billing"], "Order");

	expect(issuesOf(result).map(({ path, source }) => [path, source])).toEqual([
		[["billing", "street"], "string"],
		[["billing", "zip"], "string"],
	]);
	expect(parseField(undefined, 1, ["x"], "Order")).toEqual({
		issues: [
			{
				code: "undeclared_key",
				message: "is not declared",
				path: ["x"],
				source: "Order",
			},
		],
	});
});

const Name = propertyOf({ name: "name", schema: Type.String() });
const Coordinates = propertyOf({
	name: "coordinates",
	schema: Type.Object({
		lat: Type.Number(),
		points: Type.Array(Type.Object({ lng: Type.Number() })),
	}),
});

test("an object schema gives the path of each member that failed", () => {
	const result = Coordinates.safeParse({
		lat: "x",
		points: [{ lng: 1 }, { lng: "y" }],
	});

	expect(paths(result)).toEqual([["lat"], ["points", 1, "lng"]]);

	const nested = parseField(
		Coordinates,
		{ lat: 1, points: [{ lng: "z" }] },
		["where"],
		"test",
	);
	expect(paths(nested)).toEqual([["where", "points", 0, "lng"]]);
	expect(Name.safeParse(1)).toMatchObject({ issues: [{ path: [] }] });
});

test("a handler that throws is an invalid_value issue caused by the exception", () => {
	const Strict = propertyOf({
		name: "strict",
		schema: Type.String(),
		preHandle: (value) => {
			if (value === "boom") throw new Error("boom");
			if (value === "typed") {
				throw new InvalidPropertyValue({
					source: "strict",
					details: { errors: ["typed"] },
				});
			}
			return value;
		},
	});

	const [wrapped] = issuesOf(Strict.safeParse("boom"));
	expect(wrapped).toMatchObject({
		code: "invalid_value",
		message: 'Invalid value for property "strict": boom',
	});
	expect(wrapped?.cause).toBeInstanceOf(InvalidPropertyValue);
	expect(wrapped?.cause?.cause).toBeInstanceOf(Error);

	const [typed] = issuesOf(Strict.safeParse("typed"));
	expect(typed?.cause).toBeInstanceOf(InvalidPropertyValue);
	expect(typed?.cause?.details).toEqual({ errors: ["typed"] });
	expect(() => new Strict("typed")).toThrow(typed?.cause as Exception);
});

test("safeParse of a property gives the handled value, subclasses and optionals too", () => {
	expect(Slug.safeParse("Olá Mundo")).toEqual({ value: "ola-mundo" });
	expect(Email.safeParse("Jane@Example.com")).toEqual({
		value: new Email("Jane@Example.com").value,
	});
	expect(Id.safeParse("01A173D2-051C-77BB-8166-A371E999573E")).toEqual({
		value: "01a173d2-051c-77bb-8166-a371e999573e",
	});
	expect(Id.safeParse("nope")).toMatchObject({
		issues: [{ code: "invalid_value", source: "id" }],
	});
	expect(Password.safeParse("plain").issues).toHaveLength(1);

	expect(Slug.safeParse(undefined)).toMatchObject({
		issues: [{ code: "required", message: "is required" }],
	});
	expect(optionalOf(Slug).safeParse(undefined)).toEqual({ value: undefined });
	expect(optionalOf(Slug).safeParse("A B")).toEqual({ value: "a-b" });

	expectTypeOf(Slug.safeParse("x")).toEqualTypeOf<ParseResult<string>>();
	expectTypeOf(optionalOf(Slug).safeParse("x")).toEqualTypeOf<
		ParseResult<string | undefined>
	>();
});

test("a blueprint safeParse gives the value typed like the blueprint", () => {
	const result = Profile.safeParse(profile);

	expectTypeOf(result).toEqualTypeOf<
		ParseResult<BlueprintValue<(typeof Profile)["properties"]>>
	>();
	expectTypeOf(optionalOf(Profile).safeParse).returns.toEqualTypeOf<
		ParseResult<BlueprintValue<(typeof Profile)["properties"]> | undefined>
	>();
	expect(result).toEqual({ value: profile });
});

test("an optional blueprint accepts undefined and otherwise parses as the original", () => {
	const optional = optionalOf(Profile);

	expect(optional.safeParse(undefined)).toEqual({ value: undefined });
	expect(optional.safeParse(profile)).toEqual({ value: profile });
	expect(paths(optional.safeParse({ ...profile, name: 1 }))).toEqual([
		["name"],
	]);
	expect(Profile.safeParse(undefined).issues).toHaveLength(1);

	const { safeParse } = optional;
	expect(safeParse(undefined)).toEqual({ value: undefined });
});

test("a joined blueprint has safeParse", () => {
	const joined = Address.join(blueprintOf((ctx) => ({ country: ctx.string })));

	expect(paths(joined.safeParse({ street: "a" }))).toEqual([
		["zip"],
		["country"],
	]);
});

const Author = recordOf(
	blueprintOf((ctx) => ({ name: ctx.text, slug: ctx.slug })),
);
class User extends Author {}

const Post = recordOf(
	blueprintOf((ctx) => ({
		title: ctx.text,
		author: User,
		editor: optionalOf(User),
		reviewers: listOf(User),
	})),
);

test("a plain object for a record field becomes an instance, its issues prefixed", () => {
	const ok = Post.safeParse({
		title: "Hello",
		author: { name: "Jane", slug: "Jane Doe" },
		reviewers: [
			{ name: "Ann", slug: "ann" },
			new User({ name: "Bob", slug: "bob" }),
		],
	});

	if (ok.issues) throw new Error("expected a value");
	expect(ok.value).toBeInstanceOf(Post);
	expect(ok.value.author).toBeInstanceOf(User);
	expect(ok.value.author.slug).toBe("jane-doe");
	expect(ok.value.reviewers.every((reviewer) => reviewer instanceof User)).toBe(
		true,
	);
	expect(ok.value.editor).toBeUndefined();

	const bad = Post.safeParse({
		title: "Hello",
		author: { name: "Jane", slug: "!", extra: 1 },
		editor: 3,
		reviewers: [{ name: 1 }],
	} as never);
	expect(issuesOf(bad).map(({ code, path }) => [code, path.join(".")])).toEqual(
		[
			["undeclared_key", "author.extra"],
			["invalid_value", "author.slug"],
			["not_record", "editor"],
			["invalid_value", "reviewers.0.name"],
			["required", "reviewers.0.slug"],
		],
	);
	expect(issuesOf(bad)[2]?.message).toBe(
		'must be an instance of record "User"',
	);
});

test("an instance of the record is kept as it is, anything else is not_record", () => {
	const jane = new User({ name: "Jane", slug: "jane" });
	const result = parseField(User, jane, ["author"], "Post");
	expect(result).toEqual({ value: jane });
	expect((result as { value: unknown }).value).toBe(jane);

	const other = new (recordOf(blueprintOf((ctx) => ({ name: ctx.text }))))({
		name: "x",
	});
	for (const value of ["x", 1, [], other, new Date()]) {
		expect(issuesOf(parseField(User, value, ["author"], "Post"))).toMatchObject(
			[{ code: "not_record", path: ["author"] }],
		);
	}
});

test("safeParse of a record gives an instance of the class it is called on", () => {
	const value = { name: "Jane", slug: "jane" };
	const result = User.safeParse(value);

	if (result.issues) throw new Error("expected a value");
	expect(result.value).toBeInstanceOf(User);
	expect(result.value.name).toBe("Jane");
	expectTypeOf(result.value).toEqualTypeOf<User>();
	expectTypeOf(Author.safeParse(value).issues).toEqualTypeOf<
		readonly Issue[] | undefined
	>();

	const base = Author.safeParse(value);
	if (base.issues) throw new Error("expected a value");
	expect(base.value).toBeInstanceOf(Author);
	expect(base.value).not.toBeInstanceOf(User);
	expect(User.safeParse({ name: "Jane" } as never).issues).toHaveLength(1);
});

test("handlers run once when safeParse builds the instance", () => {
	let calls = 0;
	const Counted = propertyOf({
		name: "counted",
		schema: Type.String(),
		preHandle: (value) => {
			calls++;
			return value;
		},
	});
	class Item extends recordOf(blueprintOf(() => ({ value: Counted }))) {}

	Item.safeParse({ value: "a" });
	expect(calls).toBe(1);
	new Item({ value: "a" });
	expect(calls).toBe(2);
});

test("the constructor throws the exception of the first issue, with all of them", () => {
	const raise = (
		run: () => unknown,
	): Exception<{ key: string; errors?: string[]; issues: Issue[] }> => {
		try {
			run();
		} catch (error) {
			if (error instanceof Exception) return error as never;
			throw error;
		}
		throw new Error("expected an exception");
	};

	const value = { title: "", author: { name: "Jane" }, extra: 1 } as never;
	const undeclared = raise(() => new Post(value));
	expect(undeclared).toBeInstanceOf(UndeclaredRecordProperty);
	expect<unknown>(undeclared.details).toEqual({ key: "extra" });
	expect(
		undeclared.details.issues.map((issue) => issue.path.join(".")),
	).toEqual(["extra", "title", "author.slug", "reviewers"]);

	const property = raise(
		() => new Post({ title: "", author: { name: "Jane" } } as never),
	);
	expect(property.is(InvalidPropertyValue)).toBe(true);
	expect(property.source).toBe(ExceptionLayers.Record);
	expect<unknown>(property.details).toEqual({ key: "title" });
	expect(property.details.issues).toHaveLength(3);
	expect(property.details.issues[0]?.cause).toBeInstanceOf(Exception);

	const record = raise(() => new Post("x" as never));
	expect(record).toBeInstanceOf(InvalidRecordValue);
	expect<unknown>(record.details).toEqual({
		key: "",
		errors: ["must be an object"],
	});
	expect(record.details.issues).toHaveLength(1);

	const nested = raise(
		() =>
			new Post({
				title: "Hello",
				author: { name: "Jane", slug: "!" },
				reviewers: [],
			}),
	);
	expect(nested.is(InvalidPropertyValue)).toBe(true);
	expect<unknown>(nested.details).toEqual({ key: "author.slug" });
});

/** The value of a result that has one. */
function unwrap<Output>(result: ParseResult<Output>): Output {
	if (result.issues) throw new Error("expected a value");
	return result.value;
}

const Titled = blueprintOf((ctx) => ({ title: ctx.string, slug: ctx.string }));

/** Takes the slug from the title, before the blueprint sees the value. */
class Normalized extends recordOf(Titled) {
	constructor(value: { title: string; slug?: string }) {
		super({ ...value, slug: value.title.toLowerCase() });
	}
}

/** Refuses a title of "bad" with an exception of its own. */
class Guarded extends recordOf(Titled) {
	constructor(value: { title: string; slug: string }) {
		super(value);
		if (value.title === "bad") {
			throw new Exception({
				layer: ExceptionLayers.Record,
				name: "BadTitle",
				source: "Guarded",
				message: "is bad",
				details: undefined,
			});
		}
		if (value.title === "worse") throw new TypeError("worse");
	}
}

class Holder extends recordOf(blueprintOf(() => ({ guarded: Guarded }))) {}

test("safeParse and validate return an existing instance as it is", () => {
	const guarded = new Guarded({ title: "ok", slug: "ok" });

	for (const Class of [Guarded, Normalized]) {
		const instance = new Class({ title: "ok", slug: "ok" });
		expect(Class.safeParse(instance)).toEqual({ value: instance });
		expect(unwrap(Class.safeParse(instance))).toBe(instance);
		expect(Class["~standard"].validate(instance)).toEqual({ value: instance });
	}
	expect(optionalOf(Guarded)["~standard"].validate(guarded)).toEqual({
		value: guarded,
	});
	expect(unwrap(Holder.safeParse({ guarded })).guarded).toBe(guarded);
});

test("safeParse turns an error thrown by a subclass constructor into issues", () => {
	const bad = Guarded.safeParse({ title: "bad", slug: "x" });
	expect(bad.issues).toHaveLength(1);
	expect(bad.issues?.[0]).toMatchObject({
		code: "invalid_value",
		path: [],
		source: "Guarded",
	});
	expect(bad.issues?.[0]?.cause?.name).toBe("BadTitle");

	const worse = Guarded["~standard"].validate({ title: "worse", slug: "x" });
	const [issue] = (worse as { issues: readonly Issue[] }).issues;
	expect(issue).toMatchObject({
		code: "invalid_value",
		message: "worse",
		path: [],
		source: "Guarded",
	});
	expect(issue?.cause?.cause).toBeInstanceOf(TypeError);
	expect(issue?.cause?.layer).toBe(ExceptionLayers.Record);

	// The issues of the blueprint still come through, all of them.
	expect(Guarded.safeParse({ title: 1, extra: 1 }).issues?.length).toBe(3);
});

test("a nested record field turns the error of its constructor into issues", () => {
	const result = Holder.safeParse({ guarded: { title: "bad", slug: "x" } });
	expect(result.issues?.[0]).toMatchObject({
		code: "invalid_value",
		path: ["guarded"],
	});
	expect(
		Holder.safeParse({ guarded: { title: "worse", slug: "x" } }).issues?.[0]
			?.path,
	).toEqual(["guarded"]);
});

test("safeParse accepts what a subclass constructor normalizes", () => {
	const input = { title: "Hello" };
	expect(new Normalized(input).slug).toBe("hello");
	expect(unwrap(Normalized.safeParse(input)).slug).toBe("hello");
	expect(Normalized["~standard"].validate(input)).toMatchObject({
		value: { slug: "hello" },
	});
});

function thrownBy(make: () => unknown): Exception {
	try {
		make();
	} catch (error) {
		if (error instanceof Exception) return error;
	}
	throw new Error("expected an Exception");
}

test("a lazy cause equals the exception the constructor throws", () => {
	for (const value of ["nope", 1, ""]) {
		const [issue] = issuesOf(Email.safeParse(value));
		const thrown = thrownBy(() => new Email(value as never));

		expect(issue?.cause).toBeInstanceOf(InvalidPropertyValue);
		expect(issue?.cause?.name).toBe(thrown.name);
		expect(issue?.cause?.layer).toBe(thrown.layer);
		expect(issue?.cause?.source).toBe(thrown.source);
		expect(issue?.cause?.message).toBe(thrown.message);
		expect(issue?.cause?.details).toEqual(thrown.details);
		expect(issue?.cause?.trace).toEqual(thrown.trace);
	}
});

test("a lazy cause is not enumerable, and the same exception on every read", () => {
	const [issue] = issuesOf(Email.safeParse("nope"));
	expect(Object.keys(issue as Issue)).toEqual([
		"message",
		"path",
		"code",
		"source",
	]);
	expect(issue?.cause).toBe(issue?.cause);
});

test("the issues of one failing value share one cause", () => {
	const Point = propertyOf({
		name: "point",
		schema: Type.Object({ x: Type.Number(), y: Type.Number() }),
	});
	const issues = issuesOf(Point.safeParse({ x: "a", y: "b" }));
	expect(issues.map((issue) => issue.path)).toEqual([["x"], ["y"]]);
	expect(issues[0]?.cause).toBe(issues[1]?.cause);
	expect(issues[0]?.cause?.details).toEqual({
		errors: ["/x: must be number", "/y: must be number"],
	});
});

test("a cause survives the issue being placed under a nested path", () => {
	const Wrapper = blueprintOf(() => ({ inner: Address }));
	const [issue] = issuesOf(
		Wrapper.safeParse({ inner: { street: 1, zip: "" } }),
	);
	expect(issue?.path).toEqual(["inner", "street"]);
	expect(issue?.cause).toBeInstanceOf(InvalidPropertyValue);
});

test("deeply nested failures keep their exact paths", () => {
	const Level = blueprintOf(() => ({ items: listOf(Address) }));
	const Deep = blueprintOf(() => ({ levels: listOf(Level) }));
	const result = Deep.safeParse({
		levels: [
			{ items: [{ street: "a", zip: "b" }] },
			{
				items: [
					{ street: "a", zip: "b" },
					{ street: 1, zip: "b", extra: 1 },
				],
			},
		],
	});

	expect(paths(result)).toEqual([
		["levels", 1, "items", 1, "extra"],
		["levels", 1, "items", 1, "street"],
	]);
});

test("only own keys the blueprint does not declare are undeclared", () => {
	expect(Address.safeParse({ street: "a", zip: "b" }).issues).toBeUndefined();

	const bare = Object.assign(Object.create(null), { street: "a", zip: "b" });
	expect(Address.safeParse(bare).issues).toBeUndefined();

	expect(
		paths(Address.safeParse({ street: "a", zip: "b", toString: 1 })),
	).toEqual([["toString"]]);
});
