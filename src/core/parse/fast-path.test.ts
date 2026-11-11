// What the fast paths of a parse must not change: a field of a blueprint
// answers as its property does, and `Record.safeParse` as the constructor.
import { expect, test } from "bun:test";
import { type TString, Type } from "typebox";
import { blueprintOf } from "../../std/blueprint";
import { Email, Url } from "../../std/properties/contact";
import { Id, Slug } from "../../std/properties/identity";
import { Integer, Text } from "../../std/properties/primitives";
import { listOf } from "../blueprint/list";
import { Exception } from "../exception/exception";
import { AbstractProperty } from "../property/abstract-property";
import { AbstractDefineProperty } from "../property/define-property";
import { PropertyStates } from "../property/enums/property-states";
import { PropertyRequired } from "../property/exceptions";
import { propertyOf } from "../property/property";
import type { AnyPropertyConstructor } from "../property/types/property-collection.type";
import type { IPropertyType } from "../property/types/property-type.interface";
import { ReservedRecordKey } from "../record/exceptions";
import { recordOf } from "../record/record";
import { schemaOf } from "../schema/schema";
import { Demo } from "../symbols/demo";
import { State } from "../symbols/state";
import { LazyIssue, movedIssue } from "./issue";
import { parseField } from "./parse";
import type { Issue, ParseResult } from "./types/parse.interface";

const thrown = new PropertyRequired({ source: "thrown" });

const Trimmed = propertyOf({
	name: "trimmed",
	schema: Type.String({ minLength: 2 }),
	preHandle: (value) => value.trim(),
});
const Upper = propertyOf({
	name: "upper",
	schema: Type.String({ minLength: 2 }),
	afterHandle: (value) => value.toUpperCase(),
});
const Both = propertyOf({
	name: "both",
	schema: Type.String({ minLength: 2, maxLength: 4 }),
	preHandle: (value) => value.trim(),
	afterHandle: (value) => `<${value}>`,
});
const Nickname = propertyOf({
	name: "nickname",
	schema: Type.String({ minLength: 2 }),
	optional: true,
	preHandle: (value) => value?.trim(),
});
const Point = propertyOf({
	name: "point",
	schema: Type.Object({ x: Type.Number(), tags: Type.Array(Type.String()) }),
});
const Throws = propertyOf({
	name: "throws",
	schema: Type.String(),
	preHandle: (value) => {
		if (value === "exception") throw thrown;
		if (value === "error") throw new TypeError("boom");
		if (value === "text") throw "nope";
		return value;
	},
});
const ThrowsAfter = propertyOf({
	name: "throwsAfter",
	schema: Type.String(),
	afterHandle: (value) => {
		if (value === "exception") throw thrown;
		if (value === "error") throw new TypeError("boom");
		return value;
	},
});

const codeType: IPropertyType<TString> = {
	[Demo]: "ab",
	name: "code",
	schema: new (schemaOf("code", Type.String({ minLength: 2 })))(),
};

/** A definition written by hand, with a `handle` of its own. */
class CodeDefinition extends AbstractDefineProperty<TString> {
	override get type(): IPropertyType<TString> {
		return codeType;
	}

	protected override handle(value: string): string {
		if (value === "boom") throw new TypeError("internal");
		return super.handle(value.toUpperCase());
	}
}

class Code extends AbstractProperty<TString> {
	static readonly type = codeType;

	protected override createDefinition(): AbstractDefineProperty<TString> {
		return new CodeDefinition();
	}
}

/** A property whose `safeParse` is its own. */
class Custom extends propertyOf({ name: "custom", schema: Type.String() }) {
	static override safeParse(value: unknown): ParseResult<string> {
		return value === "ok"
			? { value: "custom" }
			: {
					issues: [
						{ code: "invalid_value", message: "no", path: [], source: "x" },
					],
				};
	}
}

const PROPERTIES: readonly AnyPropertyConstructor[] = [
	Trimmed,
	Upper,
	Both,
	Nickname,
	Point,
	Throws,
	ThrowsAfter,
	Code as never,
	Custom,
	Email,
	Url,
	Id,
	Slug,
	Integer,
	Text,
	Text.with({ min: 3, max: 5 }),
	Integer.with({ min: 1, multipleOf: 2 }),
];

const VALUES: readonly unknown[] = [
	undefined,
	null,
	"",
	" ",
	"a",
	" a ",
	"ab",
	"  abc  ",
	"abcdefgh",
	"ok",
	"boom",
	"exception",
	"error",
	"text",
	"Jane@Example.com",
	"https://example.com",
	"hello-world",
	0,
	1,
	2,
	3.5,
	-1,
	true,
	[],
	{},
	{ x: 1, tags: ["a"] },
	{ x: "1", tags: [1, "a", 2] },
];

/** What an issue is to who reads it, its cause included. */
function described(issues: readonly Issue[], prefix: readonly string[] = []) {
	return issues.map((issue) => ({
		code: issue.code,
		message: issue.message,
		path: [...prefix, ...issue.path],
		source: issue.source,
		keys: Object.keys(issue),
		cause: issue.cause && {
			name: issue.cause.name,
			message: issue.cause.message,
			details: issue.cause.details,
			trace: issue.cause.trace,
			same: issue.cause === thrown,
		},
	}));
}

test("a field of a blueprint answers as its property does", () => {
	let rejected = 0;

	for (const Property of PROPERTIES) {
		const Holder = blueprintOf(() => ({ held: Property }));
		const List = blueprintOf(() => ({ list: listOf(Property) }));

		for (const value of VALUES) {
			const own = Property.safeParse(value);
			const held = Holder.safeParse({ held: value });
			const listed = List.safeParse({ list: [value] });
			const field = parseField(Property, value, ["at", 0], "field");

			if (own.issues) {
				rejected++;
				if (!held.issues || !listed.issues || !field.issues) {
					throw new Error(`${Property.type.name} accepts a rejected value`);
				}
				expect(described(held.issues)).toEqual(described(own.issues, ["held"]));
				expect(described(listed.issues)).toEqual(
					described(own.issues, ["list", 0] as never),
				);
				expect(described(field.issues)).toEqual(
					described(own.issues, ["at", 0] as never),
				);
			} else {
				expect(held).toEqual({
					value: own.value === undefined ? {} : { held: own.value },
				});
				expect(listed).toEqual({ value: { list: [own.value] } });
				expect(field).toEqual({ value: own.value });
			}
		}
	}
	expect(rejected).toBeGreaterThan(100);
});

test("the issues of one failing field share one cause, built once", () => {
	const Holder = blueprintOf(() => ({ point: Point }));
	const issues = Holder.safeParse({ point: { x: "1", tags: [1, "a", 2] } })
		.issues as readonly Issue[];

	expect(issues.map((issue) => issue.path)).toEqual([
		["point", "x"],
		["point", "tags", 0],
		["point", "tags", 2],
	]);
	expect(issues[0]?.cause).toBeInstanceOf(Exception);
	expect(issues[1]?.cause).toBe(issues[0]?.cause);
	expect(issues[2]?.cause).toBe(issues[0]?.cause);
});

test("a value a discriminated union rejects is told by its variant alone", () => {
	const Event = propertyOf({
		name: "event",
		schema: Type.Union([
			Type.Object({
				type: Type.Literal("click"),
				x: Type.Integer({ minimum: 0 }),
			}),
			Type.Object({
				type: Type.Literal("view"),
				url: Type.String({ minLength: 1 }),
			}),
		]),
	});
	const Feed = blueprintOf(() => ({ events: listOf(Event) }));
	const { issues } = Feed.safeParse({
		events: [
			{ type: "click", x: 1 },
			{ type: "click", x: -1 },
			{ type: "scroll" },
		],
	});

	expect(issues).toEqual([
		{
			message: "must be >= 0",
			path: ["events", 1, "x"],
			code: "invalid_value",
			source: "event",
		},
		{
			message: "must be equal to one of the allowed values",
			path: ["events", 2, "type"],
			code: "invalid_value",
			source: "event",
		},
	] as never);
});

test("a lazy issue moved to another path keeps its cause, off its keys", () => {
	const [issue] = Trimmed.safeParse("a").issues as readonly Issue[];
	const moved = movedIssue(issue as Issue, ["a", 0]);

	expect(issue).toBeInstanceOf(LazyIssue);
	expect(moved).toEqual({
		code: "invalid_value",
		message: "must not have fewer than 2 characters",
		path: ["a", 0],
		source: "trimmed",
	} as never);
	expect(Object.keys(moved)).toEqual(["message", "path", "code", "source"]);
	expect(JSON.parse(JSON.stringify(moved))).toEqual({
		code: "invalid_value",
		message: "must not have fewer than 2 characters",
		path: ["a", 0],
		source: "trimmed",
	});
	expect(moved.cause).toBe(issue?.cause as Exception);
});

test("a definition stops in the state of the step that rejected the value", () => {
	const stateAfter = (
		Property: AnyPropertyConstructor,
		value: unknown,
	): PropertyStates => {
		const definition = (
			Object.create(Property.prototype) as {
				createDefinition(): AbstractDefineProperty<TString>;
			}
		).createDefinition();
		definition.parse(value);
		return definition[State];
	};

	for (const Property of [Trimmed, Upper, Both, Code as never]) {
		expect(stateAfter(Property, "abc")).toBe(PropertyStates.Done);
		expect(stateAfter(Property, undefined)).toBe(PropertyStates.Declared);
		expect(stateAfter(Property, 1)).toBe(PropertyStates.Declared);
		expect(stateAfter(Property, "a")).toBe(PropertyStates.Handling);
	}
	expect(stateAfter(Throws, "error")).toBe(PropertyStates.PreHandling);
	expect(stateAfter(ThrowsAfter, "error")).toBe(PropertyStates.AfterHandling);
	expect(stateAfter(Nickname, undefined)).toBe(PropertyStates.Done);
});

test("a handler that is not declared is not run, and the value is still checked", () => {
	const seen: unknown[] = [];
	const Plain = propertyOf({ name: "plain", schema: Type.String() });
	const Seen = propertyOf({
		name: "seen",
		schema: Type.Object({ tags: Type.Array(Type.String()) }),
		preHandle: (value) => {
			seen.push(value);
			return value;
		},
	});

	expect(new Plain("a").value).toBe("a");
	expect(Plain.safeParse(1).issues?.[0]?.message).toBe("must be string");
	// A value of another shape never reaches a handler.
	const Holder = blueprintOf(() => ({ seen: Seen }));
	expect(Holder.safeParse({ seen: "x" }).issues).toHaveLength(1);
	expect(Holder.safeParse({ seen: { tags: "x" } }).issues).toHaveLength(1);
	expect(seen).toEqual([]);
	expect(Holder.safeParse({ seen: { tags: ["x"] } }).issues).toBeUndefined();
	expect(seen).toEqual([{ tags: ["x"] }]);
});

const Titled = blueprintOf((ctx) => ({
	title: ctx.string,
	slug: ctx.slug,
	tags: listOf(ctx.string, { maxItems: 1 }),
}));

/** Records built from the value as it is: by `recordOf`, and by classes without a constructor of their own. */
const Declared = recordOf(Titled);
class Extended extends recordOf(Titled) {
	readonly built = true;

	get heading(): string {
		return this.title.toUpperCase();
	}
}
class Further extends Extended {}

/** A record whose constructor changes the value before the record sees it. */
class Normalized extends recordOf(Titled) {
	constructor(value: { title: string; slug?: string; tags?: string[] }) {
		super({
			tags: [],
			...value,
			slug: value.slug ?? value.title.toLowerCase(),
		});
	}
}

const INPUTS: readonly unknown[] = [
	{ title: "Hello", slug: "hello", tags: [] },
	{ title: "Hello", slug: "hello", tags: ["a"] },
	{ title: "Hello" },
	{ title: 1, slug: "!", tags: ["a", "b"], extra: true },
	{ slug: "hello", tags: [1] },
	{},
	[],
	"x",
	null,
	undefined,
	1,
];

test("Record.safeParse answers as the constructor does", () => {
	for (const Class of [Declared, Extended, Further, Normalized]) {
		for (let round = 0; round < 2; round++) {
			for (const input of INPUTS) {
				const result = Class.safeParse(input);
				let built: InstanceType<typeof Class> | undefined;
				let error: unknown;
				try {
					built = new Class(input as never);
				} catch (caught) {
					error = caught;
				}

				if (built) {
					if (result.issues) throw new Error("expected a record");
					expect(result.value).toBeInstanceOf(Class);
					expect(result.value.toJSON()).toEqual(built.toJSON());
					expect(Object.isFrozen(result.value.tags)).toBe(true);
				} else if (error instanceof Exception) {
					const { issues } = error.details as { issues: readonly Issue[] };
					expect(described(result.issues as readonly Issue[])).toEqual(
						described(issues),
					);
				} else {
					// An error of the constructor itself, e.g. reading a key of `null`.
					expect(result.issues).toHaveLength(1);
					expect(result.issues?.[0]?.message).toBe((error as Error).message);
					expect(result.issues?.[0]?.cause?.cause).toBeInstanceOf(TypeError);
				}
			}
		}
	}
});

test("a record made by safeParse is one its class built", () => {
	const input = { title: "Hello", slug: "hello", tags: [] };
	// From the first record of a class on.
	for (let round = 0; round < 3; round++) {
		const result = Further.safeParse(input);
		if (result.issues) throw new Error("expected a record");

		expect(result.value).toBeInstanceOf(Further);
		expect(result.value.built).toBe(true);
		expect(result.value.heading).toBe("HELLO");
		expect(result.value.title).toBe("Hello");
	}

	// What is asked of one record is not asked of the next.
	const first = Declared.safeParse(input);
	const second = new Declared({ ...input, title: "Other" });
	if (first.issues) throw new Error("expected a record");
	expect(first.value.title).toBe("Hello");
	expect(second.title).toBe("Other");
	expect(new Declared(input).title).toBe("Hello");
});

test("safeParse keeps reporting a member that hides a key", () => {
	class Hidden extends recordOf(Titled) {
		// @ts-expect-error a key cannot be redeclared, which `new` checks too
		title() {
			return "hidden";
		}
	}

	for (let round = 0; round < 2; round++) {
		const result = (
			Hidden as unknown as { safeParse(value: unknown): ParseResult<object> }
		).safeParse({ title: 1 });
		expect(result.issues).toHaveLength(1);
		expect(result.issues?.[0]?.cause).toBeInstanceOf(ReservedRecordKey);
	}
});

test("a record field made of a plain object is built without its issues being thrown", () => {
	const Holder = recordOf(
		blueprintOf(() => ({ held: Extended, list: listOf(Declared) })),
	);
	const valid = { title: "Hello", slug: "hello", tags: [] };

	const built = Holder.safeParse({ held: valid, list: [valid] });
	if (built.issues) throw new Error("expected a record");
	expect(built.value.held).toBeInstanceOf(Extended);
	expect(built.value.list[0]).toBeInstanceOf(Declared);

	const rejected = Holder.safeParse({
		held: { ...valid, slug: "!" },
		list: [valid, { ...valid, title: 1, tags: ["a", "b"] }],
	});
	expect(
		rejected.issues?.map((issue) => [issue.code, issue.path, issue.source]),
	).toEqual([
		["invalid_value", ["held", "slug"], "slug"],
		["invalid_value", ["list", 1, "title"], "string"],
		["too_many_items", ["list", 1, "tags"], "record"],
	]);
	expect(rejected.issues?.[0]?.cause).toBeInstanceOf(Exception);
});
