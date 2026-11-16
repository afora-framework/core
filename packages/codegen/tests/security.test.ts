import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	confinePath,
	generate,
	projectBoundaryIssues,
	resolveExtended,
	SpecLoadError,
	writeGenerated,
} from "../src";

const dirs: string[] = [];
afterAll(() =>
	Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))),
);

/** A project beside a directory `outside` it, both real paths. */
async function scratch(): Promise<{ project: string; outside: string }> {
	const base = await realpath(await mkdtemp(join(tmpdir(), "afora-sec-")));
	dirs.push(base);
	const project = join(base, "project");
	const outside = join(base, "outside");
	await mkdir(join(project, "src/domain"), { recursive: true });
	await mkdir(outside);
	await writeFile(join(outside, "evil.ts"), "export const fn = () => 1;\n");
	await writeFile(
		join(outside, "afora.json"),
		JSON.stringify({ version: 1, blueprints: { Leak: { fields: {} } } }),
	);
	return { project, outside };
}

const paths = (spec: unknown, root: string) =>
	projectBoundaryIssues(spec, root).map(
		({ code, path }) => `${code}@${path.join(".")}`,
	);
const service = (module: string) => ({
	version: 1,
	services: { s: { import: module } },
});

describe("SEC-05: a symlink reached through what the runtime adds to a module", () => {
	test("SEC-05: an extensionless module whose file is a link out is refused", async () => {
		const { project, outside } = await scratch();
		await symlink(join(outside, "evil.ts"), join(project, "src/evil.ts"));
		// As written, and as Bun resolves it (evil -> evil.ts, evil.js -> evil.ts).
		for (const module of ["../evil.ts#fn", "../evil#fn", "../evil.js#fn"]) {
			expect(paths(service(module), project)).toEqual([
				"outside_project@services.s.import",
			]);
		}
	});

	test("SEC-05: a directory module whose index is a link out is refused", async () => {
		const { project, outside } = await scratch();
		await mkdir(join(project, "src/dir"));
		await symlink(join(outside, "evil.ts"), join(project, "src/dir/index.ts"));
		expect(paths(service("../dir#fn"), project)).toEqual([
			"outside_project@services.s.import",
		]);
		// package.json main of a directory module.
		await mkdir(join(project, "src/pkg"));
		await writeFile(
			join(project, "src/pkg/package.json"),
			JSON.stringify({ main: "./main.ts" }),
		);
		await symlink(join(outside, "evil.ts"), join(project, "src/pkg/main.ts"));
		expect(paths(service("../pkg#fn"), project)).toEqual([
			"outside_project@services.s.import",
		]);
	});

	test("SEC-05: an extends of a directory whose afora.json is a link out is refused", async () => {
		const { project, outside } = await scratch();
		await mkdir(join(project, "shared"));
		await symlink(
			join(outside, "afora.json"),
			join(project, "shared/afora.json"),
		);
		for (const ref of ["./shared/afora.json", "./shared", "./shared/"]) {
			expect(paths({ version: 1, extends: [ref] }, project)).toEqual([
				"outside_project@extends.0",
			]);
		}
		await expect(
			resolveExtended(
				{ version: 1, extends: ["./shared"] },
				join(project, "afora.json"),
				{
					root: project,
				},
			),
		).rejects.toBeInstanceOf(SpecLoadError);
	});

	test("SEC-05: modules and extends that stay inside are still accepted", async () => {
		const { project } = await scratch();
		await writeFile(join(project, "src/ok.ts"), "export const fn = 1;\n");
		await mkdir(join(project, "src/dir"));
		await writeFile(
			join(project, "src/dir/index.ts"),
			"export const fn = 1;\n",
		);
		await symlink(join(project, "src/ok.ts"), join(project, "src/alias.ts"));
		await mkdir(join(project, "shared"));
		await writeFile(join(project, "shared/afora.json"), '{"version":1}');
		expect(
			paths(
				{
					version: 1,
					extends: ["./shared"],
					services: {
						a: { import: "../ok#fn" },
						b: { import: "../dir#fn" },
						c: { import: "../alias#fn" },
						d: { import: "../missing#fn" },
					},
				},
				project,
			),
		).toEqual([]);
	});
});

describe("SEC-06: the output.dir of an extended spec is confined", () => {
	test("SEC-06: an extended spec whose output.dir leaves the project is refused", async () => {
		const { project } = await scratch();
		await mkdir(join(project, "shared"));
		const file = join(project, "afora.json");
		const spec = { version: 1, extends: ["./shared"] };
		for (const dir of [
			"../../outside",
			"/etc/evil",
			"../node_modules/x",
			"node_modules/x",
			".git",
		]) {
			await writeFile(
				join(project, "shared/afora.json"),
				JSON.stringify({ version: 1, output: { dir } }),
			);
			const refused = resolveExtended(spec, file, { root: project });
			await expect(refused, dir).rejects.toBeInstanceOf(SpecLoadError);
			await expect(refused, dir).rejects.toThrow("output.dir");
		}
		// The same rules as validateSpec has for the spec it is given.
		await writeFile(
			join(project, "shared/afora.json"),
			JSON.stringify({ version: 1, output: { dir: "src/shared" } }),
		);
		expect(
			Object.keys(await resolveExtended(spec, file, { root: project })),
		).toEqual(["./shared"]);
	});
});

describe("SEC-17: tooling directories spelled with characters a file system folds", () => {
	test("SEC-17: output.dir node_moduleſ (long s) is refused", async () => {
		const { project } = await scratch();
		for (const dir of [
			"node_moduleſ/.bin",
			"NODE_MODULEſ",
			"node_modulesK".replace("sK", "s"),
			".gi̇t",
			"node_modules".replace("m", "\u{FF4D}"),
		]) {
			expect(paths({ version: 1, output: { dir } }, project), dir).toEqual([
				"outside_project@output.dir",
			]);
		}
		expect(
			paths({ version: 1, output: { dir: "src/domínio" } }, project),
		).toEqual([]);
	});

	test("SEC-17: confinePath and writeGenerated refuse node_modules and .git", async () => {
		const { project } = await scratch();
		for (const path of [
			"node_modules/x.ts",
			"node_moduleſ/.bin/x",
			"src/.Git/hooks/pre-commit",
		]) {
			const confined = await confinePath(project, path);
			expect(confined.ok, path).toBe(false);
		}
		expect((await confinePath(project, "src/domain/x.ts")).ok).toBe(true);
		const spec = {
			version: 1 as const,
			output: { dir: "node_moduleſ/.bin" },
			blueprints: { Address: { fields: { street: "string" } } },
		};
		const result = await writeGenerated(project, generate(spec, {}));
		expect(result.written).toEqual([]);
		expect(result.refused.length).toBeGreaterThan(0);
	});
});
