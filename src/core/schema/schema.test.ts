import { afterEach, expect, test } from "bun:test";
import { type TSchema, Type } from "typebox";
import { Locale, Settings } from "typebox/system";
import { checksOfSchema, errorsOfSchema, schemaOf } from "./schema";

afterEach(() => {
	Locale.Reset();
	Settings.Reset();
});

/** Values of every type, and around every limit the schemas below have. */
const VALUES: readonly unknown[] = [
	undefined,
	null,
	true,
	false,
	0,
	1,
	2,
	3,
	5,
	10,
	11,
	-1,
	-1.5,
	2.5,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	10n,
	"",
	"a",
	"ab",
	"abc",
	"abcdef",
	"ABC",
	"a@b.co",
	"not-an-email",
	"draft",
	"😀",
	"😀😀😀",
	[],
	["a"],
	{},
	{ a: 1 },
	() => 1,
	Symbol("s"),
];

/** Schemas told why without `Errors`: one keyword, several, and annotations. */
const LEAVES: Record<string, TSchema> = {
	string: Type.String(),
	"string, minLength": Type.String({ minLength: 3 }),
	"string, maxLength": Type.String({ maxLength: 2 }),
	"string, length and pattern": Type.String({
		minLength: 2,
		maxLength: 3,
		pattern: "^[a-z]+$",
	}),
	"string, format": Type.String({ format: "email" }),
	"string, format and minLength": Type.String({
		format: "email",
		minLength: 8,
	}),
	"string, annotated": Type.String({
		minLength: 1,
		title: "Name",
		description: "A name",
		default: "x",
		examples: ["x"],
	}),
	"optional string": Type.Optional(Type.String({ minLength: 3 })),
	number: Type.Number(),
	"number, limits": Type.Number({ minimum: 0, maximum: 10 }),
	"number, exclusive limits": Type.Number({
		exclusiveMinimum: 0,
		exclusiveMaximum: 10,
	}),
	"number, multipleOf": Type.Number({ multipleOf: 2 }),
	integer: Type.Integer(),
	"integer, every limit": Type.Integer({
		minimum: 1,
		maximum: 10,
		exclusiveMinimum: 0,
		exclusiveMaximum: 11,
		multipleOf: 5,
	}),
	boolean: Type.Boolean(),
	null: Type.Null(),
	bigint: Type.BigInt(),
	literal: Type.Literal("draft"),
	"literal number": Type.Literal(1),
	enum: Type.Enum(["draft", "abc"]),
	"const without type": Type.Unsafe({ const: "draft" }),
	"several types": Type.Unsafe({ type: ["string", "number"], minLength: 2 }),
	"limits without type": Type.Unsafe({ minLength: 2, minimum: 3 }),
};

/** Schemas only `Errors` can tell about. */
const OTHERS: Record<string, TSchema> = {
	object: Type.Object({ a: Type.Number() }),
	array: Type.Array(Type.String({ minLength: 1 })),
	union: Type.Union([Type.String({ minLength: 3 }), Type.Number()]),
	intersect: Type.Intersect([Type.String(), Type.String({ minLength: 3 })]),
	unknown: Type.Unknown(),
	"a keyword that is not a leaf's": Type.Unsafe({
		type: "string",
		not: { const: "a" },
	}),
	"a limit TypeBox does not read": Type.Unsafe({
		type: "string",
		minLength: "3",
	}),
};

function schemaFor(type: TSchema) {
	const Schema = schemaOf("probe", type);
	return new Schema();
}

for (const [name, type] of Object.entries({ ...LEAVES, ...OTHERS })) {
	test(`the errors of a rejected value are those of TypeBox: ${name}`, () => {
		const schema = schemaFor(type);
		const validator = schema.type as { Errors(value: unknown): unknown };
		const errors = validator.Errors.bind(validator);
		let asked = 0;
		validator.Errors = (value) => {
			asked++;
			return errors(value);
		};
		let rejected = 0;

		for (const value of VALUES) {
			if (schema.match(value)) continue;
			rejected++;
			expect(errorsOfSchema(schema, value)).toEqual(errors(value) as never);
		}
		if (name !== "unknown") expect(rejected).toBeGreaterThan(0);
		// A leaf never asks TypeBox, any other schema always does.
		expect(asked).toBe(name in LEAVES ? 0 : rejected);
	});
}

test("the errors of a leaf follow the locale and the limit of TypeBox", () => {
	const schema = schemaFor(
		Type.Integer({ minimum: 1, maximum: 0, multipleOf: 5 }),
	);

	Locale.Set(Locale.pt_BR);
	expect(errorsOfSchema(schema, 2.5)).toEqual(schema.type.Errors(2.5) as never);
	expect(errorsOfSchema(schema, 2.5).map((error) => error.message)).not.toEqual(
		["must be integer"],
	);

	Settings.Set({ maxErrors: 2 });
	expect(errorsOfSchema(schema, 2.5)).toHaveLength(2);
	expect(errorsOfSchema(schema, 2.5)).toEqual(schema.type.Errors(2.5) as never);
});

test("a format registered later is told as TypeBox tells it", () => {
	const schema = schemaFor(Type.String({ format: "not-a-known-format" }));

	for (const value of ["a", "", 1]) {
		if (schema.match(value)) continue;
		expect(errorsOfSchema(schema, value)).toEqual(
			schema.type.Errors(value) as never,
		);
	}
});

test("the checks of a schema answer as its methods do", () => {
	for (const type of Object.values({ ...LEAVES, ...OTHERS })) {
		const schema = schemaFor(type);
		const made = checksOfSchema(schema);
		// A schema that is not made by `schemaOf` is asked through its methods.
		const asked = checksOfSchema({
			match: (value: unknown) => schema.match(value),
			matchShape: (value: unknown) => schema.matchShape(value),
		} as never);

		for (const value of VALUES) {
			for (const checks of [made, asked]) {
				expect(checks.match(value)).toBe(schema.match(value));
				expect(checks.matchShape(value)).toBe(schema.matchShape(value));
			}
		}
	}
});

// ------------------------------------------------- discriminated unions
const strict = { additionalProperties: false };
const Events = Type.Union([
	Type.Object(
		{ type: Type.Literal("click"), x: Type.Integer({ minimum: 0 }) },
		strict,
	),
	Type.Object(
		{ type: Type.Literal("view"), url: Type.String({ minLength: 1 }) },
		strict,
	),
]);

/** `errorsOfSchema` of `value`, and how many times TypeBox was asked about the whole union. */
function explained(type: TSchema, value: unknown) {
	const schema = schemaFor(type);
	const validator = schema.type as { Errors(value: unknown): unknown };
	const errors = validator.Errors.bind(validator);
	let asked = 0;
	validator.Errors = (candidate) => {
		asked++;
		return errors(candidate);
	};
	return {
		errors: errorsOfSchema(schema, value),
		asked,
		typebox: errors(value) as readonly { message: string }[],
	};
}

test("a discriminated union tells the errors of the variant its key names, and of that one alone", () => {
	const { errors, asked, typebox } = explained(Events, {
		type: "click",
		x: -1,
	});

	expect(errors).toEqual([
		{
			keyword: "minimum",
			schemaPath: "#/anyOf/0/properties/x",
			instancePath: "/x",
			params: { comparison: ">=", limit: 0 },
			message: "must be >= 0",
		},
	]);
	expect(asked).toBe(0);
	// TypeBox also tells what the value lacks to be a view.
	expect(typebox.length).toBeGreaterThan(errors.length);
	// What it says of the variant is what TypeBox says of it.
	expect(typebox).toContainEqual(errors[0] as never);
});

test("a discriminated union tells every error of the variant, in the order of TypeBox", () => {
	const { errors } = explained(Events, { type: "view", extra: 1 });

	expect(
		errors.map(({ keyword, schemaPath, instancePath }) => [
			keyword,
			schemaPath,
			instancePath,
		]),
	).toEqual([
		["required", "#/anyOf/1", ""],
		["boolean", "#/anyOf/1/additionalProperties", "/extra"],
		["additionalProperties", "#/anyOf/1", ""],
	]);
});

test.each([
	["names no variant", { type: "scroll", x: 1 }],
	["is missing", { x: 1 }],
	["is not a literal", { type: { click: true }, x: 1 }],
])("a discriminated union tells one error when its key %s", (_, value) => {
	const { errors, asked } = explained(Events, value);

	expect(errors).toEqual([
		{
			keyword: "enum",
			schemaPath: "#/anyOf",
			instancePath: "/type",
			params: { allowedValues: ["click", "view"] },
			message: "must be equal to one of the allowed values",
		},
	]);
	expect(asked).toBe(0);
});

test("a discriminated union follows the locale and the limit of TypeBox", () => {
	Locale.Set(Locale.pt_BR);
	const [unknown] = explained(Events, { type: "scroll" }).errors;
	expect(unknown?.message).not.toBe(
		"must be equal to one of the allowed values",
	);

	Settings.Set({ maxErrors: 1 });
	expect(explained(Events, { type: "view", extra: 1 }).errors).toHaveLength(1);
});

test("a key with a slash is written as TypeBox writes it in a path", () => {
	const Slashed = Type.Union([
		Type.Object({ "a/b": Type.Literal("x") }),
		Type.Object({ "a/b": Type.Literal("y") }),
	]);

	expect(explained(Slashed, { "a/b": "z" }).errors[0]?.instancePath).toBe(
		"/a~1b",
	);
});

test.each<[string, TSchema, unknown]>([
	["a value that is not an object", Events, "click"],
	["an array", Events, [{ type: "click" }]],
	[
		"variants that share a literal",
		Type.Union([
			Type.Object({ type: Type.Literal("a"), x: Type.Number() }),
			Type.Object({ type: Type.Literal("a"), y: Type.Number() }),
		]),
		{ type: "a" },
	],
	[
		"a key that is optional in a variant",
		Type.Union([
			Type.Object({ type: Type.Literal("a") }),
			Type.Object({ type: Type.Optional(Type.Literal("b")) }),
		]),
		{ type: "c" },
	],
	[
		"a variant that is not an object",
		Type.Union([Type.Object({ type: Type.Literal("a") }), Type.String()]),
		{ type: "c" },
	],
	[
		"a union with a keyword of its own",
		Type.Unsafe({
			not: { required: ["never"] },
			anyOf: [
				Type.Object({ type: Type.Literal("a"), x: Type.Number() }),
				Type.Object({ type: Type.Literal("b"), x: Type.Number() }),
			],
		}),
		{ type: "a", x: "1" },
	],
])("TypeBox tells the errors of %s", (_, type, value) => {
	const { errors, asked, typebox } = explained(type, value);

	expect(errors).toEqual(typebox as never);
	expect(asked).toBe(1);
});

test("a union inside a variant is told by TypeBox, under the variant", () => {
	const Nested = Type.Union([
		Type.Object({
			type: Type.Literal("a"),
			inner: Type.Union([Type.String(), Type.Number()]),
		}),
		Type.Object({ type: Type.Literal("b") }),
	]);
	const { errors } = explained(Nested, { type: "a", inner: true });

	expect(
		errors.every((error) => error.schemaPath.startsWith("#/anyOf/0")),
	).toBe(true);
	expect(errors.at(-1)?.keyword).toBe("anyOf");
});
