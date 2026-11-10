import { describe, expect, test } from "bun:test";
import {
	type AnyBlueprint,
	applicationOf,
	blueprintOf,
	diffSchemas,
	type EntityStorageOptions,
	entityOf,
	recordOf,
	type SchemaChange,
	schemaLockOf,
	schemaLockProblemsOf,
} from "../../index";

/** The lock of an application holding one entity named `name`. */
function lockOf(
	blueprint: AnyBlueprint,
	options: EntityStorageOptions & {
		readonly name?: string;
		readonly unique?: readonly string[];
	} = {},
	records: Readonly<Record<string, unknown>> = {},
) {
	const name = options.name ?? "Entry";
	const Entity = entityOf(blueprint, { ...options, name } as never);
	return schemaLockOf(
		applicationOf({
			name: "app",
			entities: { [name]: Entity },
			records,
		} as never).describe(),
	);
}

/** `change`, `key`, `class`, `satisfied` and `destructive` of each change. */
const brief = (changes: readonly SchemaChange[]) =>
	changes.map((change) =>
		[
			change.entity,
			change.key ?? "",
			change.change,
			change.class,
			change.satisfied,
			change.destructive,
			...(change.from === undefined ? [] : [change.from]),
		].join(" "),
	);

describe("schemaLockOf", () => {
	test("gives each entity its version, previous names, unique keys and fields", () => {
		const Address = recordOf(
			blueprintOf((ctx) => ({ city: ctx.text, zip: ctx.optionalOf(ctx.text) })),
			{ name: "Address" },
		);
		const lock = lockOf(
			blueprintOf((ctx) => ({
				title: ctx.text.with({ renamedFrom: "name", description: "Title" }),
				locale: ctx.enumOf(["pt", "en"]).with({ fill: "pt" }),
				email: ctx.email,
				address: Address,
			})),
			{
				schemaVersion: 2,
				upgrade: { 2: (data) => data },
				previousNames: ["Post"],
				unique: ["email"],
			},
			{ Address },
		);
		expect(Object.keys(lock.entities)).toEqual(["Entry"]);
		const entry = lock.entities.Entry;
		expect(entry).toMatchObject({
			schemaVersion: 2,
			upgrade: [2],
			previousNames: ["Post"],
			unique: ["email"],
		});
		expect(Object.keys(entry?.fields ?? {})).toEqual([
			"address",
			"email",
			"locale",
			"title",
		]);
		expect(entry?.fields.title).toMatchObject({
			optional: false,
			renamedFrom: "name",
		});
		expect(entry?.fields.locale?.fill).toBe("pt");
		expect(entry?.fields.email?.unique).toBe(true);
		expect(entry?.fields.address).toMatchObject({
			schema: { type: "object" },
			fields: {
				city: { optional: false },
				zip: { optional: true },
			},
		});
		// Sorted keys: equal applications give equal JSON.
		expect(JSON.stringify(lock)).toBe(
			JSON.stringify(JSON.parse(JSON.stringify(lock))),
		);
	});

	test("equivalent applications give equal locks", () => {
		const make = () =>
			lockOf(blueprintOf((ctx) => ({ b: ctx.integer, a: ctx.text })));
		expect(make()).toEqual(make());
		expect(JSON.stringify(make())).toBe(JSON.stringify(make()));
	});
});

describe("diffSchemas", () => {
	const v1 = lockOf(
		blueprintOf((ctx) => ({
			title: ctx.text,
			status: ctx.enumOf(["draft", "published"]),
			views: ctx.integer.with({ max: 10 }),
			note: ctx.optionalOf(ctx.text),
			legacy: ctx.text,
			meta: blueprintOf((ctx) => ({ lang: ctx.text })),
		})),
	);

	test("nothing changed, nothing to report", () => {
		expect(diffSchemas(v1, v1)).toEqual([]);
	});

	test("classes each change of the issue's table", () => {
		const v2 = lockOf(
			blueprintOf((ctx) => ({
				title: ctx.text.with({ description: "The title" }),
				status: ctx.enumOf(["draft", "published", "archived"]),
				views: ctx.integer.with({ max: 5 }),
				note: ctx.text,
				subtitle: ctx.optionalOf(ctx.text),
				locale: ctx.enumOf(["pt", "en"]),
				meta: blueprintOf((ctx) => ({ lang: ctx.integer })),
			})),
		);
		expect(brief(diffSchemas(v1, v2))).toEqual([
			"Entry legacy removed automatic true true",
			"Entry locale added-required declared false false",
			"Entry meta.lang type-changed declared false false",
			"Entry note made-required declared false false",
			"Entry status loosened automatic true false",
			"Entry subtitle added-optional automatic true false",
			"Entry title metadata automatic true false",
			"Entry views tightened declared false false",
		]);
	});

	test("fill, renamedFrom and an upgrade step satisfy what they declare", () => {
		const v2 = lockOf(
			blueprintOf((ctx) => ({
				heading: ctx.text.with({ renamedFrom: "title" }),
				status: ctx.enumOf(["draft"]),
				views: ctx.integer.with({ max: 10 }),
				note: ctx.optionalOf(ctx.text),
				legacy: ctx.text,
				meta: blueprintOf((ctx) => ({ lang: ctx.text })),
				locale: ctx.enumOf(["pt", "en"]).with({ fill: "pt" }),
			})),
			{ schemaVersion: 2, upgrade: { 2: (data) => data } },
		);
		expect(brief(diffSchemas(v1, v2))).toEqual([
			"Entry heading renamed declared true false title",
			"Entry locale added-required declared true false",
			"Entry status tightened declared true false",
		]);
	});

	test("a step to a version the lock already has does not count", () => {
		const locked = lockOf(
			blueprintOf((ctx) => ({ title: ctx.text })),
			{
				schemaVersion: 2,
				upgrade: { 2: (data) => data },
			},
		);
		const next = lockOf(
			blueprintOf((ctx) => ({ title: ctx.integer })),
			{
				schemaVersion: 2,
				upgrade: { 2: (data) => data },
			},
		);
		expect(brief(diffSchemas(locked, next))).toEqual([
			"Entry title type-changed declared false false",
		]);
	});

	test("unique keys added are checked, removed ones are automatic", () => {
		const a = lockOf(blueprintOf((ctx) => ({ slug: ctx.text })));
		const b = lockOf(
			blueprintOf((ctx) => ({ slug: ctx.text })),
			{
				unique: ["slug"],
			},
		);
		expect(brief(diffSchemas(a, b))).toEqual([
			"Entry slug unique-added check true false",
		]);
		expect(brief(diffSchemas(b, a))).toEqual([
			"Entry slug unique-removed automatic true false",
		]);
	});

	test("entities added, renamed with previousNames, and removed", () => {
		const post = lockOf(
			blueprintOf((ctx) => ({ title: ctx.text })),
			{
				name: "Post",
			},
		);
		const article = lockOf(
			blueprintOf((ctx) => ({ title: ctx.text })),
			{
				name: "Article",
				previousNames: ["Post"],
			},
		);
		const page = lockOf(
			blueprintOf((ctx) => ({ title: ctx.text })),
			{
				name: "Page",
			},
		);
		expect(brief(diffSchemas(post, article))).toEqual([
			"Article  entity-renamed declared true true Post",
		]);
		expect(brief(diffSchemas(post, page))).toEqual([
			"Page  entity-added automatic true false",
			"Post  entity-removed declared false true",
		]);
		expect(schemaLockProblemsOf(post, article)).toEqual([]);
		expect(schemaLockProblemsOf(post, page)).toEqual([
			'The lock holds the entity "Post", which no entity is named or lists in previousNames.',
		]);
	});
});
