import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadSpec, normalizeSpec, SpecLoadError, validateSpec } from "../src";
import { authSpec, blogSpec, extendsSpec } from "./fixtures";
import { run } from "./project";

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const dirs: string[] = [];
async function temp() {
	const dir = await mkdtemp(join(tmpdir(), "afora-cli-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

const json = (value: unknown) => JSON.stringify(value, null, 2);

describe("afora-codegen", () => {
	test("check passes and fails with the issues", async () => {
		const dir = await temp();
		await writeFile(join(dir, "afora.json"), json(blogSpec));
		const ok = await run(dir, "bun", CLI, "check");
		expect(ok.code).toBe(0);
		expect(ok.output).toContain("valid");

		await writeFile(
			join(dir, "bad.json"),
			json({ version: 1, entities: { X: { fields: { a: "nope" } } } }),
		);
		const bad = await run(dir, "bun", CLI, "check", "bad.json");
		expect(bad.code).toBe(1);
		expect(bad.output).toContain("entities.X.fields.a.type: [unknown_type]");
	});

	test("generate writes the code, or --out another directory", async () => {
		const dir = await temp();
		await writeFile(join(dir, "afora.json"), json(blogSpec));
		const result = await run(dir, "bun", CLI, "generate");
		expect(result.code).toBe(0);
		expect(
			await readFile(join(dir, "src/domain/entities.ts"), "utf8"),
		).toContain("class User");
		const again = await run(dir, "bun", CLI, "generate");
		expect(again.output).toContain("up to date");
		await run(dir, "bun", CLI, "generate", "--out", "other/place");
		expect(await Bun.file(join(dir, "other/place/index.ts")).exists()).toBe(
			true,
		);
	});

	test("generate refuses to overwrite a file of its own directory that it did not write", async () => {
		const dir = await temp();
		await writeFile(join(dir, "afora.json"), json(blogSpec));
		await mkdir(join(dir, "src/domain"), { recursive: true });
		await writeFile(join(dir, "src/domain/index.ts"), "export {};\n");
		const result = await run(dir, "bun", CLI, "generate");
		expect(result.code).toBe(1);
		expect(result.output).toContain("refused src/domain/index.ts");
	});

	test("generate follows extends by relative path", async () => {
		const dir = await temp();
		await mkdir(join(dir, "auth"));
		await mkdir(join(dir, "journal"));
		await writeFile(join(dir, "auth/afora.json"), json(authSpec));
		await writeFile(join(dir, "journal/afora.json"), json(extendsSpec));
		const result = await run(join(dir, "journal"), "bun", CLI, "generate");
		expect(result.code).toBe(0);
		const application = await readFile(
			join(dir, "journal/src/journal/application.ts"),
			"utf8",
		);
		expect(application).toContain(
			'import { App as AuthApp } from "../../../auth/src/auth";',
		);
	});

	test("extract prints the spec of an exported application", async () => {
		const dir = await temp();
		const core = resolve(import.meta.dir, "../../../src/index.ts");
		await writeFile(
			join(dir, "app.ts"),
			`import { applicationOf, blueprintOf, recordOf } from ${JSON.stringify(core)};
class Note extends recordOf(blueprintOf((ctx) => ({ title: ctx.text, tags: ctx.list.string }))) {}
export const App = applicationOf({ name: "notes", records: { Note } });
`,
		);
		const result = await run(dir, "bun", CLI, "extract", "app.ts#App");
		expect(result.code).toBe(0);
		expect(JSON.parse(result.output)).toEqual({
			version: 1,
			name: "notes",
			output: { dir: "src/domain" },
			records: { Note: { fields: { title: "text", tags: "string[]" } } },
		});
		const missing = await run(dir, "bun", CLI, "extract", "app.ts#Nope");
		expect(missing.code).toBe(1);
	});
});

describe("loadSpec", () => {
	test("loads the extended specs once, as the same objects", async () => {
		const dir = await temp();
		await mkdir(join(dir, "auth"));
		await mkdir(join(dir, "a"));
		await mkdir(join(dir, "b"));
		await mkdir(join(dir, "top"));
		await writeFile(join(dir, "auth/afora.json"), json(authSpec));
		await writeFile(
			join(dir, "a/afora.json"),
			json({ version: 1, name: "a", extends: ["../auth/afora.json"] }),
		);
		await writeFile(
			join(dir, "b/afora.json"),
			json({ version: 1, name: "b", extends: ["../auth"] }),
		);
		await writeFile(
			join(dir, "top/afora.json"),
			json({ version: 1, extends: ["../a", "../b"] }),
		);
		const loaded = await loadSpec(join(dir, "top/afora.json"));
		expect(Object.keys(loaded.extended)).toEqual(["../a", "../b"]);
		const left = loaded.extended["../a"]?.extends?.["../auth/afora.json"];
		const right = loaded.extended["../b"]?.extends?.["../auth"];
		expect(left).toBe(right as never);
		expect(validateSpec(loaded.spec, loaded.extended)).toEqual([]);
		expect(normalizeSpec(loaded.spec, loaded.extended).extends).toEqual([
			"../a",
			"../b",
		]);
	});

	test("reports a missing file, bad JSON and a cycle", async () => {
		const dir = await temp();
		await expect(loadSpec(join(dir, "nope.json"))).rejects.toBeInstanceOf(
			SpecLoadError,
		);
		await writeFile(join(dir, "bad.json"), "{");
		await expect(loadSpec(join(dir, "bad.json"))).rejects.toThrow(
			"not valid JSON",
		);
		await writeFile(
			join(dir, "loop.json"),
			json({ version: 1, extends: ["./loop.json"] }),
		);
		await expect(loadSpec(join(dir, "loop.json"))).rejects.toThrow("cycle");
	});
});
