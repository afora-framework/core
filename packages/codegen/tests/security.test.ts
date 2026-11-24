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
import { dirname, join, win32 } from "node:path";
import {
	confinePath,
	generate,
	loadSpec,
	projectBoundaryIssues,
	resolveExtended,
	SpecLoadError,
	validateSpec,
	writeGenerated,
} from "../src";
import { inTooling, isInsideWith } from "../src/boundary";

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

describe("SEC-31: printing a spec string with a long run of blanks", () => {
	test("SEC-31: a message with 20000 spaces is generated in linear time", () => {
		const spec = {
			version: 1,
			exceptions: Object.fromEntries([
				["Aaa", { layer: "entity", message: `a${" ".repeat(20_000)}b` }],
				...Array.from({ length: 20 }, (_, i) => [
					`E${i}`,
					{ layer: "entity", message: "m" },
				]),
			]),
		};
		const start = performance.now();
		const files = generate(spec as never);
		expect(performance.now() - start).toBeLessThan(1000);
		expect(
			files.some((file) => file.contents.includes(" ".repeat(20_000))),
		).toBe(true);
	});
});

describe("SEC-33: a spec file that is not valid JSON", () => {
	test("SEC-33: the error names the file, never its text", async () => {
		const { project } = await scratch();
		const file = join(project, "settings.json");
		for (const text of [
			'{\n  "Stripe": sk_live_ABCDEFGHIJ0123\n}\n',
			"{\n  \"Stripe\": 'sk_live_ABCDEFGHIJ0123'\n}\n",
		]) {
			await writeFile(file, text);
			await expectNoText(file);
		}
	});
});

async function expectNoText(file: string): Promise<void> {
	const error = await loadSpec(file).then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(SpecLoadError);
	const message = (error as Error).message;
	expect(message).toContain("not valid JSON");
	expect(message).toContain(file);
	for (const text of ["sk_live", "Stripe", "ABCDEFGHIJ"]) {
		expect(message).not.toContain(text);
	}
}

describe("SEC-39: an output.dir on another drive or root", () => {
	const ROOTED = [
		"D:\\evil",
		"D:/evil",
		"D:evil",
		"C:\\outside",
		"\\outside",
		"\\\\server\\share\\x",
		"//server/share/x",
		"/abs",
	];

	test("SEC-39: validateSpec refuses an output.dir absolute on any platform or with a drive", () => {
		for (const dir of ROOTED) {
			expect(
				validateSpec({ version: 1, output: { dir } }, {}).map(
					({ code, path }) => `${code}@${path.join(".")}`,
				),
				dir,
			).toEqual(["invalid_output@output.dir"]);
		}
		expect(
			validateSpec({ version: 1, output: { dir: "src/domain" } }, {}),
		).toEqual([]);
	});

	test("SEC-39: such an output.dir in an extended spec is refused", async () => {
		const { project } = await scratch();
		await mkdir(join(project, "shared"));
		const file = join(project, "afora.json");
		for (const dir of ROOTED) {
			await writeFile(
				join(project, "shared/afora.json"),
				JSON.stringify({ version: 1, output: { dir } }),
			);
			const refused = resolveExtended(
				{ version: 1, extends: ["./shared"] },
				file,
				{ root: project },
			);
			await expect(refused, dir).rejects.toThrow("output.dir");
		}
	});

	test("SEC-39: a path on another Windows drive is not inside the project", () => {
		expect(isInsideWith(win32, "C:\\proj", "D:\\evil\\x.ts")).toBe(false);
		expect(isInsideWith(win32, "C:\\proj", "C:\\outside\\x.ts")).toBe(false);
		expect(isInsideWith(win32, "C:\\proj", "C:\\proj\\src\\x.ts")).toBe(true);
		expect(isInsideWith(win32, "C:\\proj", "C:\\proj")).toBe(true);
	});
});

describe("SEC-40: tooling directories spelled as Windows also reads them", () => {
	const TOOLING = [
		"node_modules.",
		"node_modules ",
		"node_modules. .",
		"node_modules::$INDEX_ALLOCATION",
		"node_modules:x",
		".git.",
		".git ::$INDEX_ALLOCATION",
		"NODE_M~1",
		"node_m~2",
		"GIT~1",
		"src/GIT~1/hooks",
	];

	test("SEC-40: inTooling and output.dir refuse them", async () => {
		const { project } = await scratch();
		for (const dir of TOOLING) {
			expect(inTooling(dir), dir).toBe(true);
			expect(paths({ version: 1, output: { dir } }, project), dir).toEqual([
				"outside_project@output.dir",
			]);
		}
		for (const dir of [
			"src/domain",
			"node_modules_old",
			"my~1",
			"src/git-hooks",
		]) {
			expect(inTooling(dir), dir).toBe(false);
		}
	});

	test("SEC-40: confinePath refuses them", async () => {
		const { project } = await scratch();
		for (const dir of TOOLING) {
			expect((await confinePath(project, `${dir}/x.ts`)).ok, dir).toBe(false);
		}
	});
});

/** A package `name` in `dir`/node_modules with this afora.json and package.json. */
async function aforaPackage(
	dir: string,
	name: string,
	spec: unknown,
	manifest: Record<string, unknown> = {},
): Promise<string> {
	const pkg = join(dir, "node_modules", name);
	await mkdir(pkg, { recursive: true });
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({ name, ...manifest }),
	);
	await writeFile(
		join(pkg, "afora.json"),
		typeof spec === "string" ? spec : JSON.stringify(spec),
	);
	return pkg;
}

const failure = (promise: Promise<unknown>): Promise<unknown> =>
	promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);

describe("SEC-54: a package named by extends, with a project root", () => {
	const outsideSpec = {
		version: 1,
		name: "OUTSIDE-SPEC",
		blueprints: { Outside: { fields: { a: "string" } } },
	};
	const extend = (project: string, ...refs: string[]) =>
		resolveExtended(
			{ version: 1, extends: refs },
			join(project, "afora.json"),
			{ root: project },
		);

	test("SEC-54: a package in a parent directory's node_modules is not read", async () => {
		const { project } = await scratch();
		await aforaPackage(dirname(project), "parentpkg", outsideSpec);
		const error = await failure(extend(project, "parentpkg"));
		expect(error).toBeInstanceOf(SpecLoadError);
		expect(String(error)).not.toContain("OUTSIDE-SPEC");
		// With node_modules in the project, still only its own packages.
		await mkdir(join(project, "node_modules"));
		expect(await failure(extend(project, "parentpkg"))).toBeInstanceOf(
			SpecLoadError,
		);
	});

	test("SEC-54: a package installed nowhere in the project is not looked up elsewhere", async () => {
		const { project } = await scratch();
		for (const name of ["typescript", "left-pad", "@types/bun"]) {
			expect(await failure(extend(project, name)), name).toBeInstanceOf(
				SpecLoadError,
			);
		}
	});

	test("SEC-54: a package of the project's node_modules that links out is not read", async () => {
		const { project, outside } = await scratch();
		await writeFile(join(outside, "package.json"), '{"name":"linked"}');
		await writeFile(join(outside, "afora.json"), JSON.stringify(outsideSpec));
		await mkdir(join(project, "node_modules"));
		await symlink(outside, join(project, "node_modules/linked"));
		const error = await failure(extend(project, "linked"));
		expect(error).toBeInstanceOf(SpecLoadError);
	});

	test("SEC-54: what a package spec extends stays in the project's node_modules", async () => {
		const { project, outside } = await scratch();
		await writeFile(join(outside, "afora.json"), JSON.stringify(outsideSpec));
		await aforaPackage(dirname(project), "parentpkg", outsideSpec);
		await aforaPackage(project, "by-path", {
			version: 1,
			extends: ["../../../outside"],
		});
		await aforaPackage(project, "by-package", {
			version: 1,
			extends: ["parentpkg"],
		});
		await mkdir(join(project, "config"));
		await writeFile(
			join(project, "config/afora.json"),
			JSON.stringify(outsideSpec),
		);
		await aforaPackage(project, "into-project", {
			version: 1,
			extends: ["../../config"],
		});
		for (const name of ["by-path", "by-package", "into-project"]) {
			const error = await failure(extend(project, name));
			expect(error, name).toBeInstanceOf(SpecLoadError);
		}
	});

	test("SEC-54: a package of the project is read, with what it extends from there", async () => {
		const { project } = await scratch();
		await aforaPackage(
			project,
			"@acme/auth",
			{ version: 1, name: "auth", extends: ["base-spec", "./more"] },
			{ exports: { ".": "./index.js", "./afora.json": "./afora.json" } },
		);
		await mkdir(join(project, "node_modules/@acme/auth/more"));
		await writeFile(
			join(project, "node_modules/@acme/auth/more/afora.json"),
			JSON.stringify({ version: 1, name: "more" }),
		);
		await aforaPackage(project, "base-spec", { version: 1, name: "base" });
		const extended = await extend(project, "@acme/auth");
		const nameOf = (resolved: unknown) =>
			(resolved as { spec?: { name?: string } } | undefined)?.spec?.name;
		const auth = extended["@acme/auth"];
		expect(nameOf(auth)).toBe("auth");
		expect(nameOf(auth?.extends?.["base-spec"])).toBe("base");
		expect(nameOf(auth?.extends?.["./more"])).toBe("more");
		// A package that does not export ./afora.json is not read.
		await aforaPackage(
			project,
			"closed",
			{ version: 1 },
			{ exports: { ".": "./index.js" } },
		);
		expect(await failure(extend(project, "closed"))).toBeInstanceOf(
			SpecLoadError,
		);
	});
});

describe("SEC-55: the messages of resolveExtended with a project root", () => {
	test("SEC-55: no message carries an absolute path", async () => {
		const { project } = await scratch();
		const base = dirname(project);
		await aforaPackage(base, "brokenpkg", "{ not json");
		await aforaPackage(project, "broken-inside", "{ not json");
		await mkdir(join(project, "node_modules/linked-out"), { recursive: true });
		for (const ref of [
			"no-such-package-xyz",
			"brokenpkg",
			"broken-inside",
			"./missing.json",
			"./missing",
		]) {
			const error = await failure(
				resolveExtended(
					{ version: 1, extends: [ref] },
					join(project, "afora.json"),
					{ root: project },
				),
			);
			expect(error, ref).toBeInstanceOf(SpecLoadError);
			const message = (error as Error).message;
			expect(message, ref).not.toContain(base);
			expect(message, ref).not.toContain(tmpdir());
		}
	});
});

describe("SEC-56: a free-form JSON object printed as a literal", () => {
	test("SEC-56: a key whose value prints as the same token is not a shorthand", () => {
		const spec = {
			version: 1,
			name: "blog",
			output: { dir: "src/domain" },
			provider: "inMemory",
			entities: {
				Post: { fields: { title: "text", slug: "slug" }, unique: ["slug"] },
			},
			repositories: {
				Posts: { entity: "Post", actions: ["findById", "create"] },
			},
			useCases: {
				Publish: {
					input: { fields: { title: "text", slug: "slug" } },
					response: { fields: { post: "Post" } },
					dependencies: { posts: "Posts" },
					implementation: {
						steps: [
							{
								build: "Post",
								values: { title: "$input.title", slug: "$input.slug" },
								as: "post",
							},
							{ create: "posts", value: "$post", as: "saved" },
							{ return: { post: "$saved" } },
						],
					},
				},
			},
			commands: { Blog: { useCases: { publish: "Publish" } } },
			outputs: {
				Api: {
					commands: ["Blog"],
					pipe: [
						{
							sink: "openapi",
							options: {
								info: { title: "x", version: "1" },
								servers: [
									{
										url: "/",
										"x-codes": {
											"200": 200,
											true: true,
											null: null,
											'"a"': "a",
											"1.5": 1.5,
										},
									},
								],
							},
						},
					],
				},
			},
		};
		expect(validateSpec(spec)).toEqual([]);
		const outputs = generate(spec as never).find((file) =>
			file.path.endsWith("outputs.ts"),
		);
		const contents = outputs?.contents ?? "";
		expect(contents).toContain('"x-codes"');
		const transpiler = new Bun.Transpiler({ loader: "ts" });
		expect(() => transpiler.transformSync(contents)).not.toThrow();
		for (const property of ['"200": 200', "true: true", "null: null"]) {
			expect(contents).toContain(property);
		}
	});
});
