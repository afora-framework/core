// The specialized paths of a parse must answer exactly as the general one:
// the same value, the same issues (code, path, source, message), in the same
// order, frozen or not. Inputs come from a generator with a fixed seed.
import { afterAll, expect, test } from "bun:test";
import { Type } from "typebox";
import { blueprintOf } from "../../std/blueprint";
import { Email } from "../../std/properties/contact";
import { Slug } from "../../std/properties/identity";
import { Integer, Text } from "../../std/properties/primitives";
import { listOf } from "../blueprint/list";
import { optionalOf } from "../blueprint/optional";
import { variantOf } from "../blueprint/variant";
import { Exception } from "../exception/exception";
import { PropertyRequired } from "../property/exceptions";
import { propertyOf } from "../property/property";
import { recordOf } from "../record/record";
import { parseCollection, parseField, setSpecializedParse } from "./parse";
import type { ParseResult } from "./types/parse.interface";

afterAll(() => {
	setSpecializedParse(true);
});

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
		return value;
	},
});
const Flag = propertyOf({ name: "flag", schema: Type.Boolean() });

/** Only plain properties: the specialized loop. */
const Item = blueprintOf(() => ({
	trimmed: Trimmed,
	upper: Upper,
	nickname: Nickname,
	point: Point,
	throws: Throws,
	flag: Flag,
}));

/** Properties of the std, with their own handlers and schemas. */
const Contact = blueprintOf(() => ({
	name: Text,
	email: Email,
	slug: Slug,
	age: Integer,
}));

class Author extends recordOf(Contact) {}

const Event = variantOf("type", {
	item: Item,
	contact: Contact,
});

/** Properties that only check their value: the compiled check of the whole value. */
const Plain = blueprintOf(() => ({
	count: propertyOf({ name: "count", schema: Type.Integer({ minimum: 0 }) }),
	flag: Flag,
	kind: propertyOf({
		name: "kind",
		schema: Type.Union([Type.Literal("a"), Type.Literal("b")]),
	}),
	uid: propertyOf({ name: "uid", schema: Type.String({ format: "uuid" }) }),
	note: propertyOf({
		name: "note",
		schema: Type.String({ maxLength: 3 }),
		optional: true,
	}),
	tags: propertyOf({ name: "tags", schema: Type.Array(Type.String()) }),
}));

/** Mixed fields: the general path at the top, the specialized one inside. */
const Root = blueprintOf(() => ({
	plain: Plain,
	plains: listOf(Plain),
	item: Item,
	maybe: optionalOf(Item),
	items: listOf(Item, { maxItems: 4 }),
	contacts: listOf(Contact),
	author: Author,
	event: Event,
	flag: Flag,
}));

/** Mulberry32: a small generator, so a failure can be replayed by its seed. */
function generator(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type Random = () => number;

/**
 * How often a generated value is broken: half of the seeds make clean values
 * (the first, valid, choice of each list), so valid paths are compared too.
 */
let noise = 0.12;

function pick<Value>(random: Random, values: readonly Value[]): Value {
	const index = Math.floor(random() * values.length);
	return values[noise === 0 ? 0 : index] as Value;
}

/** A value that breaks something, now and then. */
const ODD: readonly unknown[] = [
	undefined,
	null,
	1,
	"",
	" ",
	true,
	[],
	{},
	"exception",
	"error",
];

function sometimes<Value>(random: Random, value: Value): unknown {
	return random() < noise ? pick(random, ODD) : value;
}

/** An object written in another order, with a key it does not declare, or a key left out. */
function shuffled(
	random: Random,
	value: Record<string, unknown>,
): Record<string, unknown> {
	let entries = Object.entries(value);
	if (random() < 0.1) entries = entries.reverse();
	if (random() < noise * 0.7) entries.push(["extra", 1]);
	if (random() < noise * 0.7 && entries.length > 0) {
		entries.splice(Math.floor(random() * entries.length), 1);
	}
	return Object.fromEntries(entries);
}

function item(random: Random): unknown {
	return sometimes(
		random,
		shuffled(random, {
			trimmed: sometimes(random, `  ${pick(random, ["ab", "a", "abc "])} `),
			upper: sometimes(random, pick(random, ["ab", "x", "hello"])),
			nickname: sometimes(random, pick(random, [undefined, " jo ", "j"])),
			point: sometimes(
				random,
				pick(random, [
					{ x: 1, tags: ["a"] },
					{ x: "1", tags: [] },
					{ x: 2, tags: [1] },
				]),
			),
			throws: sometimes(random, pick(random, ["ok", "exception", "error"])),
			flag: sometimes(random, random() < 0.5),
		}),
	);
}

function contact(random: Random): unknown {
	return sometimes(
		random,
		shuffled(random, {
			name: sometimes(random, pick(random, [" Jane ", "", "Jo"])),
			email: sometimes(
				random,
				pick(random, [" Jane@Example.COM ", "nope", "a@b.co"]),
			),
			slug: sometimes(random, pick(random, ["Olá Mundo", "ok", "!!"])),
			age: sometimes(random, pick(random, [1, -1, 1.5, "2"])),
		}),
	);
}

function root(random: Random): unknown {
	const count = Math.floor(random() * (noise === 0 ? 5 : 6));
	return sometimes(
		random,
		shuffled(random, {
			plain: checkOnly(random),
			plains: Array.from({ length: Math.floor(random() * 4) }, () =>
				checkOnly(random),
			),
			item: item(random),
			maybe: random() < 0.5 ? undefined : item(random),
			items: sometimes(
				random,
				Array.from({ length: count }, () => item(random)),
			),
			contacts: Array.from({ length: Math.floor(random() * 3) }, () =>
				contact(random),
			),
			author: random() < 0.2 ? new Author(VALID_CONTACT) : contact(random),
			event:
				random() < 0.5
					? { type: "item", ...(item(random) as object) }
					: {
							type: pick(random, ["contact", "other"]),
							...(contact(random) as object),
						},
			flag: sometimes(random, true),
		}),
	);
}

const VALID_CONTACT = { name: "Jane", email: "a@b.co", slug: "ok", age: 1 };

function checkOnly(random: Random): unknown {
	return sometimes(
		random,
		shuffled(random, {
			count: sometimes(random, pick(random, [1, 0, -1, 1.5])),
			flag: sometimes(random, random() < 0.5),
			kind: sometimes(random, pick(random, ["a", "b", "c"])),
			uid: sometimes(
				random,
				pick(random, ["0190a6d6-7c4e-7b2a-9f3e-1c2d3e4f5a6b", "nope"]),
			),
			note: sometimes(random, pick(random, [undefined, "ab", "long"])),
			tags: sometimes(random, pick(random, [["x"], [], [1]])),
		}),
	);
}

/** What can be compared of a result: the value, or each issue without its lazy `cause`. */
function comparable(result: ParseResult<unknown>): unknown {
	if (!result.issues) return { value: plain(result.value) };
	return {
		issues: result.issues.map(({ code, path, source, message }) => ({
			code,
			path: [...path],
			source,
			message,
		})),
	};
}

/** `value` with each record as its JSON, so two runs compare by content. */
function plain(value: unknown): unknown {
	if (value instanceof Author) return { record: value.toJSON() };
	if (Array.isArray(value)) return value.map(plain);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, plain(item)]),
		);
	}
	return value;
}

/**
 * Whether every object and array the parse made in `value` is frozen. A record
 * keeps its own state, and the value of a property (`point` and `tags`, an
 * object and an array schema) is kept as the property gives it, as it always was.
 */
function deeplyFrozen(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return true;
	if (value instanceof Author) return true;
	if (!Object.isFrozen(value)) return false;
	return Object.entries(value).every(
		([key, item]) => key === "point" || key === "tags" || deeplyFrozen(item),
	);
}

function both<Value>(run: () => Value): [Value, Value] {
	setSpecializedParse(false);
	const general = run();
	setSpecializedParse(true);
	return [general, run()];
}

const SEEDS = 600;

test("the specialized paths answer as the general one, value and issues", () => {
	let accepted = 0;
	for (let seed = 1; seed <= SEEDS; seed++) {
		const random = generator(seed);
		noise = seed % 2 === 0 ? 0 : 0.12;
		const input = root(random);
		for (const freeze of [false, true]) {
			const [general, special] = both(() =>
				parseCollection(Root.properties, input, ["at"], "test", freeze),
			);
			expect({ seed, freeze, ...(comparable(special) as object) }).toEqual({
				seed,
				freeze,
				...(comparable(general) as object),
			});
			if (!special.issues) {
				if (!freeze) accepted++;
				expect(deeplyFrozen(special.value)).toBe(freeze);
			}
		}
	}
	// The generator must reach valid values too, not only rejections.
	expect(accepted).toBeGreaterThan(SEEDS / 20);
});

test("a field, a list and a blueprint answer as the general path", () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const random = generator(seed);
		noise = seed % 2 === 0 ? 0 : 0.12;
		const list = Array.from({ length: 3 }, () => item(random));
		for (const [field, input] of [
			[listOf(Item), list],
			[Item, list[0]],
			[Contact, contact(random)],
		] as const) {
			const [general, special] = both(() => parseField(field, input, [], "x"));
			expect({ seed, ...(comparable(special) as object) }).toEqual({
				seed,
				...(comparable(general) as object),
			});
		}
	}
});

test("a rejected property keeps the exception it raised as the cause", () => {
	const [general, special] = both(() =>
		Item.safeParse({
			trimmed: "ab",
			upper: "ab",
			point: { x: 1, tags: [] },
			throws: "exception",
			flag: true,
		}),
	);
	const causeOf = (result: ParseResult<unknown>) => result.issues?.[0]?.cause;
	expect(causeOf(special)).toBe(causeOf(general));
	expect(causeOf(special)).toBeInstanceOf(Exception);
});

test("a collection that only checks is compiled once warm, and answers as before", () => {
	const Fresh = blueprintOf(() => ({
		count: propertyOf({ name: "count", schema: Type.Integer() }),
		note: propertyOf({ name: "note", schema: Type.String(), optional: true }),
	}));
	const inputs: unknown[] = [
		{ count: 1 },
		{ count: 1, note: "a" },
		{ count: 1, note: undefined },
		{ note: "a", count: 2 },
		{ count: "1" },
		{ count: 1, extra: true },
		{},
		Object.create({ count: 1 }),
		[],
		null,
	];
	// Past the warm-up, the whole check is in use for every input after it.
	for (let round = 0; round < 3; round++) {
		for (const input of inputs) {
			const [general, special] = both(() => Fresh.safeParse(input));
			expect({ round, input, ...(comparable(special) as object) }).toEqual({
				round,
				input,
				...(comparable(general) as object),
			});
		}
	}
});
