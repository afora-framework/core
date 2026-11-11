import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Value } from "typebox/value";
import {
	compactSpec,
	extractSpec,
	generate,
	normalizeSpec,
	type Spec,
	specSchema,
	validateSpec,
} from "../src";
import { makeProject, removeProject, run } from "./project";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

/** v3 of the entry of #28: a fill, a rename, two upgrade steps, a previous name. */
const evolving: Spec = {
	version: 1,
	name: "cms",
	output: { dir: "src/domain" },
	provider: "inMemory",
	entities: {
		Entry: {
			fields: {
				title: { type: "text", renamedFrom: "name" },
				locale: { enum: ["pt", "en"], fill: "pt" },
				summary: { type: "text", with: { max: 280 }, fill: "-" },
			},
			schemaVersion: 3,
			upgrade: {
				"2": { import: "./upgrades#toV2" },
				"3": { import: "./upgrades#toV3" },
			},
			previousNames: ["Post"],
		},
	},
	repositories: {
		Entries: { entity: "Entry", actions: ["create", "findMany"] },
	},
};

// biome-ignore lint/suspicious/noExplicitAny: a JSON draft the tests mutate freely
type Draft = any;
const edit = (change: (copy: Draft) => void): Spec => {
	const copy = JSON.parse(JSON.stringify(evolving));
	change(copy);
	return copy;
};
const codes = (spec: Spec) =>
	validateSpec(spec).map((i) => `${i.code}@${i.path.join(".")}`);
const canonical = (spec: Spec) => compactSpec(normalizeSpec(spec));

describe("schema evolution: validation", () => {
	test("a valid spec has no issues and matches the JSON Schema", () => {
		expect(validateSpec(evolving)).toEqual([]);
		expect(Value.Check(specSchema, evolving)).toBe(true);
	});

	test("schemaVersion, upgrade and previousNames are checked", () => {
		expect(
			codes(
				edit((c) => {
					c.entities.Entry.schemaVersion = 0;
				}),
			),
		).toContain("invalid_option@entities.Entry.schemaVersion");
		expect(
			codes(
				edit((c) => {
					c.entities.Entry.upgrade["4"] = { import: "./upgrades#toV4" };
				}),
			),
		).toContain("invalid_option@entities.Entry.upgrade.4");
		expect(
			codes(
				edit((c) => {
					c.entities.Entry.upgrade["2"] = "toV2";
				}),
			),
		).toContain("invalid_import@entities.Entry.upgrade.2");
		expect(
			codes(
				edit((c) => {
					c.entities.Entry.previousNames = ["Entry"];
				}),
			),
		).toContain("invalid_option@entities.Entry.previousNames.0");
		expect(
			codes(
				edit((c) => {
					c.records = { Note: { fields: { a: "text" }, schemaVersion: 2 } };
				}),
			),
		).toContain("unknown_key@records.Note.schemaVersion");
	});

	test("fill and renamedFrom are checked", () => {
		expect(
			codes(
				edit((c) => {
					c.entities.Entry.fields.locale.fill = "es";
				}),
			),
		).toContain("invalid_enum@entities.Entry.fields.locale.fill");
		expect(
			codes(
				edit((c) => {
					c.entities.Entry.fields.title.renamedFrom = "not a key";
				}),
			),
		).toContain("invalid_field@entities.Entry.fields.title.renamedFrom");
		expect(
			codes(
				edit((c) => {
					c.entities.Entry.fields.tags = {
						type: "slug",
						list: true,
						fill: [],
					};
				}),
			),
		).toContain("invalid_field@entities.Entry.fields.tags");
	});
});

describe("schema evolution: generation", () => {
	test("emits the options of entityOf and the fields' with", () => {
		const entities = generate(evolving).find((f) =>
			f.path.endsWith("entities.ts"),
		)?.contents as string;
		expect(entities).toContain('ctx.text({ renamedFrom: "name" })');
		expect(entities).toContain('ctx.enumOf(["pt", "en"]).with({ fill: "pt" })');
		expect(entities).toContain('ctx.text({ max: 280, fill: "-" })');
		expect(entities).toContain("schemaVersion: 3");
		expect(entities).toContain('previousNames: ["Post"]');
		expect(entities).toMatch(
			/import \{ toV2, toV3 \} from "\.\/upgrades(\.ts)?";/,
		);
		expect(entities).toMatch(/upgrade: \{ "?2"?: toV2, "?3"?: toV3 \}/);
	});
});

describe("schema evolution: round trip", () => {
	// biome-ignore lint/suspicious/noExplicitAny: the generated application is loaded dynamically
	type Any = any;

	test("JSON -> generate -> type-check -> run -> extract is equal", async () => {
		const dir = await makeProject(generate(evolving), {
			"src/domain/upgrades.ts": `export const toV2 = (data: Readonly<Record<string, unknown>>) => ({ ...data });
export const toV3 = (data: Readonly<Record<string, unknown>>) => ({ ...data });
`,
		});
		projects.push(dir);
		const tsc = await run(dir, "bunx", "tsc", "--noEmit", "-p", dir);
		expect(tsc.output).toBe("");
		const domain = (await import(join(dir, "src/domain/index.ts"))) as Any;
		const description = domain.App.describe();
		expect(description.entities.Entry).toMatchObject({
			schemaVersion: 3,
			upgrade: [2, 3],
			previousNames: ["Post"],
		});
		const extracted = extractSpec(domain.App, {
			imports: {
				"entities.Entry.upgrade.2": "./upgrades#toV2",
				"entities.Entry.upgrade.3": "./upgrades#toV3",
			},
		});
		expect(canonical(extracted)).toEqual(canonical(evolving));
	}, 120_000);

	test("extract asks for the import of an upgrade step", () => {
		const core = require(resolve(import.meta.dir, "../../../src/index.ts"));
		class Entry extends core.entityOf(
			core.blueprintOf((ctx: Any) => ({ title: ctx.text })),
			{ name: "Entry", schemaVersion: 2, upgrade: { 2: (d: Any) => d } },
		) {}
		const app = core.applicationOf({ name: "cms", entities: { Entry } });
		expect(() => extractSpec(app)).toThrow("entities.Entry.upgrade.2");
	});
});

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const CORE = JSON.stringify(resolve(import.meta.dir, "../../../src/index.ts"));
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

/** A directory with `app.ts`, exporting `App` with one entity `Entry`. */
async function appDir(entity: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "afora-schema-"));
	dirs.push(dir);
	await write(dir, entity);
	return dir;
}
const write = (dir: string, entity: string) =>
	writeFile(
		join(dir, "app.ts"),
		`import { applicationOf, blueprintOf, entityOf } from ${CORE};
class Entry extends entityOf(${entity}) {}
export const App = applicationOf({ name: "cms", entities: { Entry } });
`,
	);

describe("afora-codegen schema", () => {
	const v1 = `blueprintOf((ctx) => ({ title: ctx.text })), { name: "Entry" }`;

	test("lock writes the lock; check passes on it and fails once stale", async () => {
		const dir = await appDir(v1);
		const lock = await run(dir, "bun", CLI, "schema", "lock", "app.ts#App");
		expect(lock.code).toBe(0);
		const written = JSON.parse(
			await readFile(join(dir, "afora.lock.json"), "utf8"),
		);
		expect(written.entities.Entry.fields.title.optional).toBe(false);
		const ok = await run(dir, "bun", CLI, "schema", "check", "app.ts#App");
		expect(ok.output).toContain("up to date");
		expect(ok.code).toBe(0);

		await write(
			dir,
			`blueprintOf((ctx) => ({ title: ctx.text, note: ctx.optionalOf(ctx.text) })), { name: "Entry" }`,
		);
		const stale = await run(dir, "bun", CLI, "schema", "check", "app.ts#App");
		expect(stale.code).toBe(1);
		expect(stale.output).toContain("Entry.note: added-optional");
		expect(stale.output).toContain("stale");
		const relock = await run(dir, "bun", CLI, "schema", "lock", "app.ts#App");
		expect(relock.code).toBe(0);
	});

	test("an undeclared change fails, with an upgrade stub, and lock refuses it", async () => {
		const dir = await appDir(v1);
		await run(dir, "bun", CLI, "schema", "lock", "app.ts#App");
		await write(
			dir,
			`blueprintOf((ctx) => ({ title: ctx.text, locale: ctx.enumOf(["pt", "en"]) })), { name: "Entry" }`,
		);
		const check = await run(dir, "bun", CLI, "schema", "check", "app.ts#App");
		expect(check.code).toBe(1);
		expect(check.output).toContain(
			"Entry.locale: added-required (declared, unsatisfied)",
		);
		expect(check.output).toContain("schemaVersion must go above 1");
		expect(check.output).toContain("schemaVersion: 2,");
		expect(check.output).toContain(
			"2: (data) => ({ ...data /* locale: ... */ }),",
		);
		const lock = await run(dir, "bun", CLI, "schema", "lock", "app.ts#App");
		expect(lock.code).toBe(1);
		expect(lock.output).toContain("--force");
		const forced = await run(
			dir,
			"bun",
			CLI,
			"schema",
			"lock",
			"app.ts#App",
			"--force",
		);
		expect(forced.code).toBe(0);
	});

	test("a bumped version without its step gets a stub at that version", async () => {
		const dir = await appDir(v1);
		await run(
			dir,
			"bun",
			CLI,
			"schema",
			"lock",
			"app.ts#App",
			"--out",
			"x.lock.json",
		);
		await write(
			dir,
			`blueprintOf((ctx) => ({ title: ctx.integer })), { name: "Entry", schemaVersion: 2 }`,
		);
		const check = await run(
			dir,
			"bun",
			CLI,
			"schema",
			"check",
			"app.ts#App",
			"--lock",
			"x.lock.json",
		);
		expect(check.code).toBe(1);
		expect(check.output).toContain("Entry.title: type-changed");
		expect(check.output).not.toContain("schemaVersion must go above");
		expect(check.output).toContain("convert data.title");
	});

	test("a declared change passes lock; a rename without previousNames fails check", async () => {
		const dir = await appDir(v1);
		await run(dir, "bun", CLI, "schema", "lock", "app.ts#App");
		await write(
			dir,
			`blueprintOf((ctx) => ({ title: ctx.text, locale: ctx.enumOf(["pt", "en"]).with({ fill: "pt" }) })), { name: "Entry" }`,
		);
		expect(
			(await run(dir, "bun", CLI, "schema", "lock", "app.ts#App")).code,
		).toBe(0);
		await writeFile(
			join(dir, "app.ts"),
			`import { applicationOf, blueprintOf, entityOf } from ${CORE};
class Article extends entityOf(blueprintOf((ctx) => ({ title: ctx.text })), { name: "Article" }) {}
export const App = applicationOf({ name: "cms", entities: { Article } });
`,
		);
		const check = await run(dir, "bun", CLI, "schema", "check", "app.ts#App");
		expect(check.code).toBe(1);
		expect(check.output).toContain(
			'The lock holds the entity "Entry", which no entity is named or lists in previousNames.',
		);
	});

	test("check without a lock fails", async () => {
		const dir = await appDir(v1);
		const check = await run(dir, "bun", CLI, "schema", "check", "app.ts#App");
		expect(check.code).toBe(1);
		expect(check.output).toContain("schema lock");
	});
});
