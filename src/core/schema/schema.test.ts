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
