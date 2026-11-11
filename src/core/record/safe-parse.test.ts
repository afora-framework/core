// `Record.safeParse` builds the record through its constructor, and is only
// spared the exception of a value the record rejects.
import { expect, test } from "bun:test";
import { blueprintOf } from "../../std/blueprint";
import { entityOf } from "../../std/entity";
import { listOf } from "../blueprint/list";
import { ExceptionLayers } from "../exception/enums/exception-layers";
import { Exception } from "../exception/exception";
import type { Issue, ParseResult } from "../parse/types/parse.interface";
import { UndeclaredRecordProperty } from "./exceptions";
import { recordOf } from "./record";

const Titled = blueprintOf((ctx) => ({ title: ctx.string, slug: ctx.slug }));

const Declared = recordOf(Titled);
class Extended extends recordOf(Titled) {}

/** Takes the slug from the title, before the record sees the value. */
class Normalized extends recordOf(Titled) {
	constructor(value: { title: string; slug?: string }) {
		super({ ...value, slug: value.slug ?? String(value.title).toLowerCase() });
	}
}

/** Refuses a title of "bad", after the record accepted the value. */
class Guarded extends recordOf(Titled) {
	constructor(value: { title: string; slug: string }) {
		super(value);
		if (value.title === "bad") throw new TypeError("bad title");
	}
}

class Post extends entityOf(Titled) {}

type Thrown = Exception<{ issues: readonly Issue[] }>;

/** The exception `new Class(value)` throws. */
function thrownBy(Class: new (value: never) => unknown, value: unknown) {
	try {
		new Class(value as never);
	} catch (error) {
		return error as Thrown;
	}
	throw new Error("expected an exception");
}

/** What an issue tells, its cause included. */
function described(issues: readonly Issue[] | undefined) {
	return issues?.map((issue) => ({
		code: issue.code,
		message: issue.message,
		path: issue.path,
		source: issue.source,
		cause: issue.cause && {
			name: issue.cause.name,
			layer: issue.cause.layer,
			message: issue.cause.message,
		},
	}));
}

const CLASSES = [Declared, Extended, Normalized, Guarded, Post] as const;
const INVALID: readonly unknown[] = [
	{ title: 1, slug: "!" },
	{ title: "Hello", slug: "!", extra: true },
	{ title: "Hello", slug: "hello", extra: true },
	{ slug: 1 },
	"x",
];

test("safeParse gives the issues of the exception new throws, for any class", () => {
	for (const Class of CLASSES) {
		for (let round = 0; round < 2; round++) {
			for (const value of INVALID) {
				const result = Class.safeParse(value);
				const exception = thrownBy(Class, value);

				expect(result.issues?.length).toBeGreaterThan(0);
				expect(described(result.issues)).toEqual(
					described(exception.details.issues),
				);
			}
		}
	}
});

test("new throws the exception itself, with its trace and cause, around a safeParse", () => {
	for (const Class of CLASSES) {
		expect(Class.safeParse({ title: "Hello", slug: "!" }).issues).toHaveLength(
			1,
		);

		const invalid = thrownBy(Class, { title: "Hello", slug: "!" });
		expect(invalid).toBeInstanceOf(Error);
		expect(invalid.name).toBe("InvalidPropertyValue");
		expect(typeof invalid.stack).toBe("string");
		expect(invalid.layer).toBe(ExceptionLayers.Record);
		expect(invalid.cause).toBeInstanceOf(invalid.constructor);
		expect(invalid.cause).toBeInstanceOf(Error);
		expect(invalid.trace.map((frame) => frame.layer)).toEqual([
			ExceptionLayers.Property,
			ExceptionLayers.Record,
		]);
		expect(Object.isFrozen(invalid.details.issues)).toBe(true);

		const undeclared = thrownBy(Class, { title: "a", slug: "a", extra: 1 });
		expect(undeclared).toBeInstanceOf(Error);
		expect(undeclared.constructor).toBe(UndeclaredRecordProperty);
		expect(undeclared.details).toEqual({ key: "extra" } as never);

		const shape = thrownBy(Class, "x");
		expect(shape).toBeInstanceOf(Error);
		expect(shape.layer).toBe(ExceptionLayers.Record);
	}
});

test("safeParse honors a constructor that normalizes the value", () => {
	const built = Normalized.safeParse({ title: "Hello" });
	if (built.issues) throw new Error("expected a record");
	expect(built.value).toBeInstanceOf(Normalized);
	expect(built.value.slug).toBe("hello");

	// The raw value has no slug: only what the constructor makes of it counts.
	expect(Titled.safeParse({ title: "Hello" }).issues).toHaveLength(1);
	expect(
		Normalized.safeParse({ title: 1 }).issues?.map((issue) => issue.path),
	).toEqual([["title"]]);
});

test("safeParse turns the error of a constructor into one issue", () => {
	const result = Guarded.safeParse({ title: "bad", slug: "bad" });
	expect(result.issues).toHaveLength(1);
	expect(result.issues?.[0]).toMatchObject({
		code: "invalid_value",
		message: "bad title",
		path: [],
		source: "Guarded",
	});
	expect(result.issues?.[0]?.cause?.cause).toBeInstanceOf(TypeError);

	const next = Guarded.safeParse({ title: "good", slug: "good" });
	expect(next.issues).toBeUndefined();
});

test("safeParse builds an entity, and gives the issues of one it rejects", () => {
	const built = Post.safeParse({ title: "Hello", slug: "hello" });
	if (built.issues) throw new Error("expected an entity");
	expect(built.value).toBeInstanceOf(Post);
	expect(typeof built.value.id).toBe("string");
	expect(built.value.createdAt).toBeDefined();

	const rejected = Post.safeParse({ title: 1, slug: "!", extra: true });
	expect(rejected.issues?.map((issue) => [issue.code, issue.path])).toEqual([
		["undeclared_key", ["extra"]],
		["invalid_value", ["title"]],
		["invalid_value", ["slug"]],
	]);
	expect(rejected.issues?.[2]?.cause?.name).toBe("InvalidPropertyValue");
});

test("the records a record holds give their issues at their paths", () => {
	const Holder = recordOf(
		blueprintOf(() => ({
			held: Normalized,
			post: Post,
			list: listOf(Guarded),
		})),
	);
	const valid = { title: "Hello", slug: "hello" };

	const built = Holder.safeParse({ held: valid, post: valid, list: [valid] });
	if (built.issues) throw new Error("expected a record");
	expect(built.value.held).toBeInstanceOf(Normalized);
	expect(built.value.post).toBeInstanceOf(Post);
	expect(built.value.list[0]).toBeInstanceOf(Guarded);

	const rejected = Holder.safeParse({
		held: { title: 1 },
		post: { ...valid, slug: "!" },
		list: [valid, { title: "bad", slug: "bad" }, { ...valid, title: 1 }],
		extra: true,
	});
	expect(rejected.issues?.map((issue) => [issue.code, issue.path])).toEqual([
		["undeclared_key", ["extra"]],
		["invalid_value", ["held", "title"]],
		["invalid_value", ["post", "slug"]],
		["invalid_value", ["list", 1]],
		["invalid_value", ["list", 2, "title"]],
	]);

	// The holder itself still throws its exception when it is built by `new`.
	const exception = thrownBy(Holder, { held: valid, post: valid, list: [1] });
	expect(exception).toBeInstanceOf(Error);
	expect(exception.details.issues).toHaveLength(1);
});

test("a record a constructor builds by new throws its exception during a safeParse", () => {
	const caught: unknown[] = [];

	class Builder extends recordOf(Titled) {
		constructor(value: { title: string; slug: string; other?: unknown }) {
			const { other, ...rest } = value;
			if (other !== undefined) {
				try {
					new Declared(other as never);
				} catch (error) {
					caught.push(error);
				}
			}
			super(rest);
		}
	}

	const invalid = { title: "Hello", slug: "!" };
	const result = Builder.safeParse({ ...invalid, other: invalid });

	expect(result.issues?.map((issue) => issue.path)).toEqual([["slug"]]);
	expect(caught).toHaveLength(1);
	expect(caught[0]).toBeInstanceOf(Error);
	expect((caught[0] as Error).name).toBe("InvalidPropertyValue");
	expect(Object.hasOwn(caught[0] as object, "details")).toBe(true);

	const valid = { title: "Hello", slug: "hello" };
	expect(Builder.safeParse({ ...invalid, other: valid }).issues).toHaveLength(
		1,
	);
	expect(Builder.safeParse({ ...valid, other: valid }).issues).toBeUndefined();
});

test("a record of its own class that a constructor builds first answers as an exception", () => {
	const caught: Thrown[] = [];

	class Tree extends recordOf(Titled) {
		constructor(value: { title: string; slug: string; parent?: unknown }) {
			const { parent, ...rest } = value;
			if (parent !== undefined) {
				try {
					new Tree(parent as never);
				} catch (error) {
					caught.push(error as Thrown);
				}
			}
			super(rest);
		}
	}

	const invalid = { title: "Hello", slug: "!" };
	const direct = thrownBy(Tree, invalid);
	const result = Tree.safeParse({ title: 1, slug: "a", parent: invalid });

	expect(result.issues?.map((issue) => issue.path)).toEqual([["title"]]);
	expect(caught).toHaveLength(1);
	expect(caught[0] instanceof Exception).toBe(true);
	expect(caught[0]?.constructor).toBe(direct.constructor);
	expect(caught[0]?.message).toBe(direct.message);
	expect(caught[0]?.trace).toEqual(direct.trace);
	expect(described(caught[0]?.details.issues)).toEqual(
		described(direct.details.issues),
	);
});

test("a constructor that parses other records is still parsed itself", () => {
	const seen: ParseResult<object>[] = [];

	class Parser extends recordOf(Titled) {
		constructor(value: { title: string; slug: string }) {
			if (typeof value === "object") {
				seen.push(Declared.safeParse({ title: 1 }), Parser.safeParse(1));
			}
			super(value);
		}
	}

	const result = Parser.safeParse({ title: "Hello", slug: "!" });
	expect(result.issues?.map((issue) => issue.path)).toEqual([["slug"]]);
	expect(seen).toHaveLength(2);
	expect(seen[0]?.issues).toHaveLength(2);
	expect(seen[1]?.issues).toHaveLength(1);
	expect(
		Parser.safeParse({ title: "Hello", slug: "hello" }).issues,
	).toBeUndefined();

	// Nothing is left asked of the next record built by `new`.
	expect(thrownBy(Parser, { title: "Hello", slug: "!" })).toBeInstanceOf(Error);
	expect(thrownBy(Declared, { title: "Hello", slug: "!" })).toBeInstanceOf(
		Error,
	);
});

test("a constructor that catches around super sees the exception new would throw", () => {
	const caught: Thrown[] = [];

	class Catching extends recordOf(Titled) {
		constructor(value: { title: string; slug: string }) {
			try {
				super(value);
			} catch (error) {
				caught.push(error as Thrown);
				throw error;
			}
		}
	}
	class Wrapping extends recordOf(Titled) {
		constructor(value: { title: string; slug: string }) {
			try {
				super(value);
			} catch (error) {
				throw new Exception({
					layer: ExceptionLayers.Record,
					name: "Wrapped",
					source: "Wrapping",
					message: `wrapped: ${(error as Error).message}`,
					details: undefined,
					cause: error,
				});
			}
		}
	}

	for (const value of INVALID) {
		const result = Catching.safeParse(value);
		const thrown = thrownBy(Catching, value);
		const [seen, direct] = caught.splice(0) as [Thrown, Thrown];

		expect(direct).toBe(thrown);
		expect(seen).not.toBe(thrown);
		expect(seen instanceof Error).toBe(true);
		expect(seen instanceof Exception).toBe(true);
		expect(seen instanceof thrown.constructor).toBe(true);
		expect(seen.constructor).toBe(thrown.constructor);
		expect(seen.name).toBe(thrown.name);
		expect(seen.message).toBe(thrown.message);
		expect(seen.layer).toBe(thrown.layer);
		expect(seen.source).toBe(thrown.source);
		expect(seen.details).toEqual(thrown.details);
		expect(seen.trace).toEqual(thrown.trace);
		expect(seen.is("InvalidPropertyValue")).toBe(
			thrown.is("InvalidPropertyValue"),
		);
		expect(seen.is(thrown.constructor as never)).toBe(true);
		expect(String(seen)).toBe(String(thrown));
		expect(typeof seen.stack).toBe("string");
		expect("details" in seen).toBe(true);
		expect(Object.keys(seen)).toEqual(Object.keys(thrown));
		expect(JSON.stringify(seen)).toBe(JSON.stringify(thrown));
		// Thrown again as it is, it is still the issues of the record.
		expect(described(result.issues)).toEqual(described(thrown.details.issues));

		const wrapped = Wrapping.safeParse(value);
		expect(wrapped.issues).toHaveLength(1);
		expect(wrapped.issues?.[0]?.message).toBe(
			thrownBy(Wrapping, value).message,
		);
		expect(wrapped.issues?.[0]?.cause?.name).toBe("Wrapped");
		expect(wrapped.issues?.[0]?.cause?.is(thrown.name)).toBe(true);
	}
});
