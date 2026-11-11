import { afterEach, expect, test } from "bun:test";
import { type TSchema, Type } from "typebox";
import { Locale, Settings } from "typebox/system";
import { checksOfSchema, errorsOfSchema, rawTypeOf, schemaOf } from "./schema";
import type { ISchema } from "./types/schema.interface";

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

/** Schemas that are not leaves; those in `ASKED` are told by `Errors`, the others without it. */
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

/** The schemas above with a keyword only TypeBox tells. */
const ASKED = new Set([
	"intersect",
	"a keyword that is not a leaf's",
	"a limit TypeBox does not read",
]);

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
		// TypeBox is only asked about a keyword that has no explanation here.
		expect(asked).toBe(ASKED.has(name) ? rejected : 0);
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
])(
	"the errors of %s are those of TypeBox, of every variant",
	(_, type, value) => {
		const { errors, typebox } = explained(type, value);

		expect(errors).toEqual(typebox as never);
	},
);

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

// ------------------------------------------- objects, arrays and unions
// Schemas and values made from a seed, so that a failure can be run again.
function generatorOf(seed: number) {
	let state = seed;
	const next = () => {
		state = (state + 0x6d2b79f5) | 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
	const pick = <Item>(items: readonly Item[]) =>
		items[Math.floor(next() * items.length)] as Item;
	const chance = (odds: number) => next() < odds;
	return { pick, chance };
}

const KEYS = ["a", "b", "a/b", "c~d", "type"] as const;

function leafSchema({ pick, chance }: ReturnType<typeof generatorOf>) {
	return pick<() => object>([
		() => ({
			type: "string",
			...(chance(0.5) ? { minLength: pick([1, 2, 3]) } : {}),
			...(chance(0.3) ? { maxLength: pick([1, 2]) } : {}),
			...(chance(0.2) ? { pattern: "^a" } : {}),
			...(chance(0.2) ? { format: "email" } : {}),
		}),
		() => ({
			type: pick(["number", "integer"]),
			...(chance(0.5) ? { minimum: pick([0, 1]) } : {}),
			...(chance(0.3) ? { exclusiveMaximum: pick([2, 3]) } : {}),
			...(chance(0.2) ? { multipleOf: 2 } : {}),
		}),
		() => ({ type: "boolean" }),
		() => ({ type: "null" }),
		() => ({ const: pick(["a", 1, true]) }),
		() => ({
			enum: pick([
				["a", "b"],
				[1, 2],
				["a", 1, null],
			]),
		}),
		() => ({}),
	])();
}

function anySchema(
	random: ReturnType<typeof generatorOf>,
	depth: number,
): object {
	const { pick, chance } = random;
	if (depth === 0 || chance(0.35)) return leafSchema(random);
	return pick<() => object>([
		() => {
			const keys = KEYS.filter(() => chance(0.5));
			const required = keys.filter(() => chance(0.6));
			return {
				...(chance(0.8) ? { type: "object" } : {}),
				...(keys.length > 0 || chance(0.5)
					? {
							properties: Object.fromEntries(
								keys.map((key) => [key, anySchema(random, depth - 1)]),
							),
						}
					: {}),
				...(required.length > 0 ? { required } : {}),
				...(chance(0.5) ? { additionalProperties: false } : {}),
			};
		},
		() => ({
			...(chance(0.8) ? { type: "array" } : {}),
			...(chance(0.8) ? { items: anySchema(random, depth - 1) } : {}),
			...(chance(0.3) ? { minItems: pick([1, 2]) } : {}),
			...(chance(0.3) ? { maxItems: pick([0, 1]) } : {}),
		}),
		() => ({
			anyOf: Array.from({ length: pick([1, 2, 3]) }, () =>
				anySchema(random, depth - 1),
			),
		}),
	])();
}

function anyValue(
	random: ReturnType<typeof generatorOf>,
	depth: number,
): unknown {
	const { pick, chance } = random;
	if (depth === 0 || chance(0.4)) {
		return pick([
			null,
			true,
			false,
			-1,
			0,
			1,
			2,
			2.5,
			3,
			"",
			"a",
			"ab",
			"abc",
			"a@b.co",
			"b",
		]);
	}
	if (chance(0.5)) {
		const keys = [...KEYS, "extra"].filter(() => chance(0.45));
		return Object.fromEntries(
			keys.map((key) => [
				key,
				chance(0.1) ? undefined : anyValue(random, depth - 1),
			]),
		);
	}
	return Array.from({ length: pick([0, 1, 2, 3]) }, () =>
		anyValue(random, depth - 1),
	);
}

test("objects, arrays and unions are told as TypeBox tells them, without asking it", () => {
	// `AFORA_SEED` runs it on other schemas and values.
	const random = generatorOf(Number(process.env.AFORA_SEED ?? 20261111));
	let compared = 0;

	for (let round = 0; round < 400; round++) {
		const generated = anySchema(random, 3);
		// A union at the top could be a discriminated one, told differently on purpose.
		const wrapped = "anyOf" in generated;
		const raw = wrapped
			? { type: "object", properties: { root: generated }, required: ["root"] }
			: generated;
		const schema = schemaFor(Type.Unsafe(raw));
		const validator = schema.type as { Errors(value: unknown): unknown };
		const errors = validator.Errors.bind(validator);
		let asked = 0;
		validator.Errors = (value) => {
			asked++;
			return errors(value);
		};

		for (let sample = 0; sample < 30; sample++) {
			const inner = anyValue(random, 3);
			const value = wrapped ? { root: inner } : inner;
			if (schema.match(value)) continue;
			for (const settings of [{}, { maxErrors: 1 }, { maxErrors: 3 }]) {
				Settings.Reset();
				Settings.Set(settings);
				const told = errorsOfSchema(schema, value);
				const expected = errors(value);
				if (!Bun.deepEquals(told, expected)) {
					// Says which schema and value, which `toEqual` alone would not.
					expect({ raw, value, settings, told }).toEqual({
						raw,
						value,
						settings,
						told: expected,
					} as never);
				}
				compared++;
			}
			Locale.Set(Locale.pt_BR);
			expect(errorsOfSchema(schema, value)).toEqual(errors(value) as never);
			Locale.Reset();
			Settings.Reset();
		}
		expect({ raw, asked }).toEqual({ raw, asked: 0 });
	}
	expect(compared).toBeGreaterThan(10000);
});

test("an optional key given as undefined is checked when TypeBox is told to", () => {
	const schema = schemaFor(
		Type.Object({ a: Type.Optional(Type.String()), b: Type.Number() }),
	);
	const value = { a: undefined, b: "1" };

	expect(errorsOfSchema(schema, value)).toEqual(
		schema.type.Errors(value) as never,
	);
	Settings.Set({ exactOptionalPropertyTypes: true });
	expect(errorsOfSchema(schema, value)).toEqual(
		schema.type.Errors(value) as never,
	);
	expect(errorsOfSchema(schema, value)).toHaveLength(2);
});

test("inherited keys, own hidden keys and holes are read as TypeBox reads them", () => {
	const schema = schemaFor(
		Type.Object(
			{ a: Type.String(), list: Type.Array(Type.Number()) },
			{ additionalProperties: false },
		),
	);
	const hidden = Object.create(
		{ a: 1 },
		{
			secret: { value: 1, enumerable: false },
		},
	);
	// biome-ignore lint/suspicious/noSparseArray: a hole is what is tested
	hidden.list = [1, , "x"];

	expect(errorsOfSchema(schema, hidden)).toEqual(
		schema.type.Errors(hidden) as never,
	);
	expect(
		errorsOfSchema(schema, hidden).map((error) => error.instancePath),
	).toEqual(["/secret", "", "/a", "/list/2"]);
});

test("rawTypeOf gives the schema as it was given, without compiling it", () => {
	const type = Type.Object({ name: Type.String({ minLength: 3 }) });
	const Schema = schemaOf("Named", type);
	const schema = new Schema();
	expect(rawTypeOf(schema)).toBe(type);
	expect(
		(schema as unknown as { validator?: unknown }).validator,
	).toBeUndefined();
	expect(rawTypeOf(schema)).toEqual(schema.type.Type());
	// A schema not made by `schemaOf` is asked through `type`.
	const other: ISchema<typeof type> = {
		match: (value): value is { name: string } => value !== undefined,
		matchShape: () => true,
		errors: () => [],
		toString: () => "",
		get type() {
			return schema.type;
		},
	};
	expect(rawTypeOf(other)).toBe(schema.type.Type());
});
