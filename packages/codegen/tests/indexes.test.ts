import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
	extractSpec,
	generate,
	normalizeSpec,
	type Spec,
	specSchema,
	validateSpec,
} from "../src";
import { makeProject, removeProject } from "./project";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

function spec(repository: Record<string, unknown> = {}): Spec {
	return {
		version: 1,
		name: "indexes",
		output: { dir: "src/domain" },
		blueprints: { Language: { fields: { code: "string" } } },
		entities: {
			Entry: {
				fields: {
					type: "string",
					status: "string",
					owner: "string",
					rank: "integer",
					secret: "string",
					meta: "Language",
				},
				sensitive: ["secret"],
			},
		},
		repositories: {
			Entries: {
				entity: "Entry",
				actions: ["create", "findMany", "explain"],
				...repository,
			},
		},
	};
}

const INDEXES = {
	byTypeStatus: { where: ["type", "status"], orderBy: "rank" },
	byOwner: { where: ["owner"] },
};

test("indexes and scans validate, generate, plan and round trip", async () => {
	const input = spec({ indexes: INDEXES, scans: "reject" });
	expect(validateSpec(input)).toEqual([]);
	expect(Value.Check(specSchema, input)).toBe(true);
	const dir = await makeProject(generate(input));
	projects.push(dir);
	const { App } = await import(join(dir, "src/domain/index.ts"));
	const Entries = App.repositories.Entries;
	expect(await Entries.explain({ where: { owner: "ana" } })).toEqual({
		access: "index",
		index: "byOwner",
	});
	await expect(Entries.findMany({ where: { rank: 1 } })).rejects.toMatchObject({
		name: "InvalidRepositoryQuery",
	});
	expect(App.describe().repositories.Entries).toMatchObject({
		indexes: INDEXES,
		scans: "reject",
	});
	expect(normalizeSpec(extractSpec(App))).toEqual(normalizeSpec(input));
	expect(generate(extractSpec(App))).toEqual(generate(input));
});

test("the default scans and no indexes are canonicalized away", () => {
	expect(normalizeSpec(spec({ indexes: {}, scans: "allow" }))).toEqual(
		normalizeSpec(spec()),
	);
	expect(generate(spec({ indexes: {}, scans: "allow" }))).toEqual(
		generate(spec()),
	);
});

test("rejects indexes on unknown keys", () => {
	const input = spec({
		indexes: { byNope: { where: ["type", "nope"], orderBy: "other" } },
	});
	const issues = validateSpec(input);
	expect(issues).toContainEqual(
		expect.objectContaining({
			code: "unknown_index_key",
			path: ["repositories", "Entries", "indexes", "byNope", "where", 1],
		}),
	);
	expect(issues).toContainEqual(
		expect.objectContaining({
			code: "unknown_index_key",
			path: ["repositories", "Entries", "indexes", "byNope", "orderBy"],
		}),
	);
});

for (const [name, indexes, path] of [
	["sensitive", { a: { where: ["secret"] } }, ["a", "where", 0]],
	["not scalar", { a: { where: ["type"], orderBy: "meta" } }, ["a", "orderBy"]],
	["empty", { a: { where: [] } }, ["a"]],
	["malformed", { a: { where: "type" } }, ["a"]],
	["extra keys", { a: { where: ["type"], unique: true } }, ["a"]],
	["a key twice", { a: { where: ["type", "type"] } }, ["a", "where"]],
	[
		"the same as another",
		{ a: { where: ["type", "status"] }, b: { where: ["status", "type"] } },
		["b"],
	],
	["not an object", [], []],
] as const) {
	test(`rejects an index that is ${name}`, () => {
		expect(validateSpec(spec({ indexes }))).toContainEqual(
			expect.objectContaining({
				code: "invalid_index",
				path: ["repositories", "Entries", "indexes", ...path],
			}),
		);
	});
}

test("rejects an unknown scans policy", () => {
	const input = spec({ scans: "never" });
	expect(validateSpec(input)).toContainEqual(
		expect.objectContaining({
			code: "invalid_option",
			path: ["repositories", "Entries", "scans"],
		}),
	);
	expect(Value.Check(specSchema, input)).toBe(false);
});
