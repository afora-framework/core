import { expect, test } from "bun:test";
import { Type } from "typebox";
import { blueprintOf } from "../../std/blueprint";
import { Email } from "../../std/properties/contact";
import { Integer, Text } from "../../std/properties/primitives";
import type { ParseResult } from "../parse/types/parse.interface";
import { propertyOf } from "../property/property";
import { InvalidBlueprintVariant } from "./exceptions";
import { listOf } from "./list";
import { optionalOf } from "./optional";
import { isBlueprintVariant, variantOf } from "./variant";

/** The value of a parse that is expected to accept. */
function accepted<Value>(result: ParseResult<Value>): Value {
	if (result.issues) throw new Error(JSON.stringify(result.issues));
	return result.value;
}

const Trimmed = propertyOf({
	name: "trimmed",
	schema: Type.String({ minLength: 1 }),
	preHandle: (value) => value.trim(),
});
const Click = blueprintOf(() => ({ x: Integer, y: Integer }));
const Signup = blueprintOf(() => ({ email: Email, name: Trimmed }));
const Event = variantOf("type", { click: Click, signup: Signup });

test("a variant field is frozen, branded and keeps what it was given", () => {
	expect(isBlueprintVariant(Event)).toBe(true);
	expect(Object.isFrozen(Event)).toBe(true);
	expect(Event.key).toBe("type");
	expect(Object.keys(Event.variants)).toEqual(["click", "signup"]);
	expect(Event.optional).toBe(false);
	expect(isBlueprintVariant(Click)).toBe(false);
	expect(isBlueprintVariant(listOf(Text))).toBe(false);
});

test("a value is handled by the variant its key names, with the key first", () => {
	const Feed = blueprintOf(() => ({ last: Event }));
	const value = accepted(
		Feed.safeParse({
			last: { name: "  Jane ", email: " Jane@Example.COM ", type: "signup" },
		}),
	);

	expect(value).toEqual({
		last: { type: "signup", email: "jane@example.com", name: "Jane" },
	});
	expect(Object.keys(value.last)).toEqual(["type", "email", "name"]);
	expect(Object.isFrozen(value.last)).toBe(true);
	// The value is told apart by its key.
	if (value.last.type === "signup") {
		const email: string = value.last.email;
		expect(email).toBe("jane@example.com");
	}
});

test("the issues of a variant are those of its blueprint, at its paths", () => {
	const Feed = blueprintOf(() => ({ events: listOf(Event) }));
	const { issues } = Feed.safeParse({
		events: [
			{ type: "click", x: 1, y: 2 },
			{ type: "click", x: "1", extra: true },
			{ type: "signup", email: "nope", name: " " },
		],
	});

	expect(issues?.map(({ path, code }) => [path.join("."), code])).toEqual([
		["events.1.extra", "undeclared_key"],
		["events.1.x", "invalid_value"],
		["events.1.y", "required"],
		["events.2.email", "invalid_value"],
		["events.2.name", "invalid_value"],
	]);
});

test.each([
	["names no variant", { type: "scroll", x: 1 }],
	["is missing", { x: 1, y: 2 }],
	["is not a string", { type: 1 }],
	["is the name of an inherited member", { type: "constructor" }],
])("a value whose key %s gets one issue, at the key", (_, value) => {
	const Feed = blueprintOf(() => ({ last: Event }));

	expect(Feed.safeParse({ last: value }).issues).toEqual([
		{
			code: "invalid_value",
			message: "must be equal to one of the allowed values",
			path: ["last", "type"],
			source: "blueprint",
		},
	] as never);
});

test.each([
	["a string", "click"],
	["an array", [{ type: "click" }]],
	["null", null],
])("%s is not a variant", (_, value) => {
	const Feed = blueprintOf(() => ({ last: Event }));

	expect(
		Feed.safeParse({ last: value }).issues?.map(({ path, code }) => [
			path,
			code,
		]),
	).toEqual([[["last"], "invalid_type"]]);
});

test("a variant field is required unless it is made optional", () => {
	const Required = blueprintOf(() => ({ last: Event }));
	const Optional = blueprintOf(() => ({ last: optionalOf(Event) }));

	expect(Required.safeParse({}).issues?.map(({ code }) => code)).toEqual([
		"required",
	]);
	expect(accepted(Optional.safeParse({}))).toEqual({});
	expect(optionalOf(Event)).toBe(optionalOf(Event));
	expect(optionalOf(optionalOf(Event))).toBe(optionalOf(Event));
	expect(optionalOf(Event).optional).toBe(true);
	expect(
		accepted(Optional.safeParse({ last: { type: "click", x: 1, y: 2 } })),
	).toEqual({ last: { type: "click", x: 1, y: 2 } });
});

test("a context has variantOf, and reserves its name", () => {
	const Feed = blueprintOf((ctx) => ({
		last: ctx.variantOf("kind", { click: Click }),
		all: ctx.listOf(ctx.variantOf("kind", { click: Click, signup: Signup })),
	}));

	expect(
		accepted(Feed.safeParse({ last: { kind: "click", x: 1, y: 2 }, all: [] })),
	).toEqual({ last: { kind: "click", x: 1, y: 2 }, all: [] });
});

test("a variant field has a Standard Schema of its own", () => {
	const result = Event["~standard"].validate({ type: "click", x: 1, y: 2 });

	expect(result).toEqual({ value: { type: "click", x: 1, y: 2 } } as never);
	expect(
		(Event["~standard"].validate({ type: "nope" }) as { issues: unknown[] })
			.issues,
	).toHaveLength(1);
});

test("the schema of a variant field is a union of objects with the key as a literal", () => {
	const Feed = blueprintOf(() => ({ last: Event }));
	const schema = Feed.schema.type.Type() as unknown as {
		properties: {
			last: { anyOf: { properties: object; required: string[] }[] };
		};
	};
	const [click, signup] = schema.properties.last.anyOf;

	expect(Object.keys(click?.properties ?? {})).toEqual(["type", "x", "y"]);
	expect(click?.required).toEqual(["type", "x", "y"]);
	expect(signup?.properties).toMatchObject({ type: { const: "signup" } });
	expect(Feed.schema.match({ last: { type: "click", x: 1, y: 2 } })).toBe(true);
	expect(Feed.schema.match({ last: { type: "signup", x: 1, y: 2 } })).toBe(
		false,
	);
});

test.each<[string, () => unknown]>([
	["no variant", () => variantOf("type", {})],
	["an empty key", () => variantOf("", { click: Click })],
	[
		"a variant that is not a blueprint",
		() => variantOf("type", { click: Integer as never }),
	],
	["a variant that declares the key", () => variantOf("x", { click: Click })],
])("variantOf rejects %s", (_, declare) => {
	expect(declare).toThrow(InvalidBlueprintVariant);
});
