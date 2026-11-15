import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectBoundaryIssues } from "../src";

const root = "/work/project";
const at = (spec: unknown) =>
	projectBoundaryIssues(spec, root).map(
		({ code, path }) => `${code}@${path.join(".")}`,
	);

describe("projectBoundaryIssues", () => {
	test("accepts modules inside the project and packages", () => {
		expect(
			at({
				version: 1,
				extends: ["./auth", "@acme/billing"],
				provider: { import: "../db#provider" },
				useCases: {
					A: { implementation: { import: "../handlers/a#A" } },
					B: {
						implementation: {
							steps: [{ run: "x", fn: { import: "@acme/lib#x" } }],
						},
					},
				},
			}),
		).toEqual([]);
		expect(at(null)).toEqual([]);
		expect(at("nope")).toEqual([]);
	});

	test("a relative module resolves from the output directory", () => {
		// src/domain -> ../../ is the project root; one more leaves it.
		expect(at({ provider: { import: "../../db#provider" } })).toEqual([]);
		expect(at({ provider: { import: "../../../db#provider" } })).toEqual([
			"outside_project@provider.import",
		]);
		expect(
			at({ output: { dir: "out" }, provider: { import: "../../db#p" } }),
		).toEqual(["outside_project@provider.import"]);
	});

	test("refuses absolute paths and URLs, at any depth", () => {
		expect(
			at({
				useCases: {
					A: { implementation: { import: "/etc/a#A" } },
					B: {
						generic: "create",
						options: { before: { import: "file:///tmp/b.ts#b" } },
					},
				},
				outputs: { Api: { pipe: [{ import: "https://evil.test/s.ts#s" }] } },
				publishers: { hub: { import: "C:\\\\x\\\\hub.ts#hub" } },
			}),
		).toEqual([
			"outside_project@useCases.A.implementation.import",
			"outside_project@useCases.B.options.before.import",
			"outside_project@outputs.Api.pipe.0.import",
			"outside_project@publishers.hub.import",
		]);
	});

	test("an extended spec must be inside the project", () => {
		expect(at({ extends: ["../other", "./mine", "/abs/afora.json"] })).toEqual([
			"outside_project@extends.0",
			"outside_project@extends.2",
		]);
	});

	test("a package specifier cannot climb out of its package", () => {
		expect(
			at({
				extends: ["pkg/../../../outside", "@acme/x/./y"],
				provider: { import: "pkg/../../../outside/x.ts#provider" },
				publishers: { hub: { import: "pkg//x#hub" } },
			}),
		).toEqual([
			"outside_project@extends.0",
			"outside_project@extends.1",
			"outside_project@provider.import",
			"outside_project@publishers.hub.import",
		]);
	});

	test("refuses what a runtime reads as another path: backslashes, percent-encoding, control characters", () => {
		// Node and Bun resolve a relative import as a URL: "\\" is "/" and "%2e%2e" is "..".
		expect(
			at({
				provider: { import: "./a\\..\\..\\..\\..\\outside\\x.ts#p" },
				publishers: { hub: { import: "./%2e%2e/%2e%2e/%2e%2e/x#hub" } },
				trace: { import: "./x\n.ts#tracer" },
				extends: ["./a\\..\\..\\.."],
			}),
		).toEqual([
			"outside_project@extends.0",
			"outside_project@provider.import",
			"outside_project@publishers.hub.import",
			"outside_project@trace.import",
		]);
	});

	test("refuses modules built into the runtime", () => {
		const step = (module: string) => ({
			useCases: {
				A: {
					implementation: {
						steps: [{ run: "x", fn: { import: `${module}#x` } }],
					},
				},
			},
		});
		for (const module of ["child_process", "fs", "fs/promises", "bun"]) {
			expect(at(step(module))).toEqual([
				"outside_project@useCases.A.implementation.steps.0.fn.import",
			]);
		}
	});

	test("output.dir stays out of node_modules and .git", () => {
		expect(at({ output: { dir: "src/gen" } })).toEqual([]);
		// Climbing out is `invalid_output`, reported by validateSpec.
		expect(at({ output: { dir: "../x" } })).toEqual([]);
		for (const dir of ["node_modules/pkg", ".git/hooks", "src/.git"]) {
			expect(at({ output: { dir } })).toEqual(["outside_project@output.dir"]);
		}
	});

	describe("symbolic links", () => {
		const dirs: string[] = [];
		afterAll(() =>
			Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))),
		);

		test("a module, an extends or output.dir through a link that leaves the project is refused", async () => {
			const scratch = await mkdtemp(join(tmpdir(), "afora-boundary-"));
			dirs.push(scratch);
			const project = join(scratch, "project");
			await mkdir(join(project, "src/domain"), { recursive: true });
			await mkdir(join(scratch, "outside"));
			await symlink(join(scratch, "outside"), join(project, "shared"));
			await symlink(join(scratch, "outside"), join(project, "src/out"));
			const issues = projectBoundaryIssues(
				{
					extends: ["./shared"],
					provider: { import: "../../shared/db#provider" },
				},
				project,
			).map(({ code, path }) => `${code}@${path.join(".")}`);
			expect(issues).toEqual([
				"outside_project@extends.0",
				"outside_project@provider.import",
			]);
			expect(
				projectBoundaryIssues({ output: { dir: "src/out" } }, project).map(
					({ path }) => path.join("."),
				),
			).toEqual(["output.dir"]);
			// A link that stays inside is fine.
			await symlink(join(project, "src"), join(project, "lib"));
			expect(
				projectBoundaryIssues(
					{ provider: { import: "../../lib/db#provider" } },
					project,
				),
			).toEqual([]);
		});
	});
});
