import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateInProject } from "../src/spec-file";
import { redactMessage, typecheck } from "../src/typecheck";
import { type Connected, connect, makeProject, removeProject } from "./project";

const dirs: string[] = [];
const clients: Connected[] = [];
afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
});
afterAll(() =>
	Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))),
);

/** A project (real path) beside a directory outside it with a module and a spec. */
async function scratch(): Promise<{ root: string; outside: string }> {
	const base = await realpath(await mkdtemp(join(tmpdir(), "afora-mcp-sec-")));
	dirs.push(base);
	const root = join(base, "project");
	const outside = join(base, "outside");
	await mkdir(join(root, "src/domain"), { recursive: true });
	await mkdir(outside);
	await writeFile(join(outside, "evil.ts"), "export const fn = () => 1;\n");
	await writeFile(
		join(outside, "afora.json"),
		JSON.stringify({
			version: 1,
			name: "OUTSIDE-SECRET",
			blueprints: { Leak: { fields: { a: "string" } } },
		}),
	);
	return { root, outside };
}

const codes = (
	issues: readonly { code: string; path: readonly (string | number)[] }[],
) => issues.map(({ code, path }) => `${code}@${path.join(".")}`);

describe("validateInProject", () => {
	test("SEC-05: a module or extends whose loaded file is a link out is refused", async () => {
		const { root, outside } = await scratch();
		await symlink(join(outside, "evil.ts"), join(root, "src/evil.ts"));
		await mkdir(join(root, "shared"));
		await symlink(join(outside, "afora.json"), join(root, "shared/afora.json"));
		const { issues, extended } = await validateInProject(
			{ root },
			{
				version: 1,
				extends: ["./shared"],
				services: { clock: { import: "../evil#fn" } },
			},
		);
		expect(codes(issues)).toContain("outside_project@services.clock.import");
		expect(codes(issues)).toContain("outside_project@extends.0");
		// The spec outside was not read.
		expect(JSON.stringify(extended)).not.toContain("OUTSIDE-SECRET");
	});

	test("SEC-06: an extended spec whose output.dir leaves the project is refused", async () => {
		const { root } = await scratch();
		await mkdir(join(root, "shared"));
		for (const dir of ["../../outside", "/etc/evil", "../node_modules/x"]) {
			await writeFile(
				join(root, "shared/afora.json"),
				JSON.stringify({
					version: 1,
					output: { dir },
					blueprints: { Shared: { fields: { a: "string" } } },
				}),
			);
			const { issues } = await validateInProject(
				{ root },
				{
					version: 1,
					extends: ["./shared"],
					blueprints: { Mine: { fields: { s: "Shared" } } },
				},
			);
			const unresolved = issues.find((i) => i.code === "unresolved_extends");
			expect(unresolved?.message, dir).toContain("output.dir");
		}
	});

	test("SEC-17: an output.dir that a file system folds to node_modules is refused", async () => {
		const { root } = await scratch();
		const { issues } = await validateInProject(
			{ root },
			{ version: 1, output: { dir: "node_moduleſ/.bin" } },
		);
		expect(codes(issues)).toContain("outside_project@output.dir");
	});
});

describe("SEC-18: the application an agent may import", () => {
	const projects: string[] = [];
	afterAll(() => Promise.all(projects.map(removeProject)));
	const setup = async (
		files: Record<string, string>,
		options: { app?: string } = {},
	) => {
		const dir = await makeProject(files);
		projects.push(dir);
		const client = await connect({ project: dir, ...options });
		clients.push(client);
		return { dir, client };
	};
	const SIDE_EFFECT =
		"import { writeFileSync } from 'node:fs'; writeFileSync('SIDE_EFFECT', 'yes'); export {};\n";

	test("SEC-18: a file in node_modules or .git, or that is not a module, is refused", async () => {
		const { dir, client } = await setup({
			"node_modules/pkg/index.ts": SIDE_EFFECT,
			".git/hooks/x.ts": SIDE_EFFECT,
			".env": "DATABASE_URL=postgres://admin:hunter2@db/prod\n",
			"deploy.sh": "#!/bin/sh\nexport AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI\n",
			"data.json": '{"secret":"hunter2"}\n',
		});
		for (const app of [
			"node_modules/pkg/index.ts#App",
			"Node_Modules/pkg/index.ts#App",
			".git/hooks/x.ts#App",
			".env#App",
			"deploy.sh#App",
			"data.json#App",
		]) {
			for (const tool of ["afora_project", "afora_extract"]) {
				const result = await client.call(tool, { app });
				expect(result.isError, `${tool} ${app}`).toBe(true);
				expect(String(result.data)).not.toContain("hunter2");
				expect(String(result.data)).not.toContain("wJalrXUtnFEMI");
			}
		}
		expect(await Bun.file(join(dir, "SIDE_EFFECT")).exists()).toBe(false);
	}, 60_000);

	test("SEC-18: started with --app, only that module may be imported", async () => {
		const { dir, client } = await setup(
			{
				"src/app.ts": "export const App = 1;\n",
				"scripts/reset-db.ts": SIDE_EFFECT,
			},
			{ app: "src/app.ts#App" },
		);
		for (const tool of ["afora_project", "afora_extract"]) {
			const result = await client.call(tool, {
				app: "scripts/reset-db.ts#App",
			});
			expect(result.isError, tool).toBe(true);
			expect(String(result.data)).toContain("--app");
		}
		expect(await Bun.file(join(dir, "SIDE_EFFECT")).exists()).toBe(false);
	}, 60_000);

	test("SEC-18: a module that fails to import is not echoed back", async () => {
		const { client } = await setup({
			"src/secrets.js": "const k = 'sk_live_LEAKME';\nthis is not js\n",
			"src/boom.ts": "const token = 'sk_live_BOOM';\nthrow new Error(token);\n",
		});
		for (const app of ["src/secrets.js#App", "src/boom.ts#App"]) {
			const result = await client.call("afora_extract", { app });
			expect(result.isError, app).toBe(true);
			expect(String(result.data)).not.toContain("sk_live");
			expect(String(result.data)).not.toContain("not js");
			expect(String(result.data)).toContain("import_failed");
		}
	}, 60_000);
});

describe("SEC-32: the diagnostics afora_generate returns", () => {
	const projects: string[] = [];
	afterAll(() => Promise.all(projects.map(removeProject)));

	test("SEC-32: the literal values of a project module are not echoed back", async () => {
		const dir = await makeProject({
			"src/secrets.ts":
				// biome-ignore lint/suspicious/noTemplateCurlyInString: a template literal of the module
				'export const config = { db: { url: "postgres://admin:hunter2@db/prod" }, key: "sk_live_LEAKME", pin: 98765, tag: `t_${"x"}` } as const;\n',
		});
		projects.push(dir);
		const client = await connect({ project: dir });
		clients.push(client);
		const spec = {
			version: 1,
			services: { leak: { import: "../secrets#config" } },
			useCases: {
				Peek: {
					input: { fields: { key: "string" } },
					response: { fields: { value: "string" } },
					dependencies: { leak: "leak" },
					implementation: { import: "../secrets#config" },
				},
			},
		};
		expect((await client.call("afora_spec_write", { spec })).data.written).toBe(
			true,
		);
		const result = await client.call("afora_generate", {});
		const { typecheck } = result.data;
		expect(typecheck.ran).toBe(true);
		expect(typecheck.ok).toBe(false);
		expect(typecheck.diagnostics.length).toBeGreaterThan(0);
		for (const diagnostic of typecheck.diagnostics) {
			expect(diagnostic.file).toMatch(/^src\/domain\//);
			expect(diagnostic.line).toBeGreaterThan(0);
			expect(diagnostic.code).toMatch(/^TS\d+$/);
		}
		// What the agent can act on stays: the type that was expected.
		expect(JSON.stringify(typecheck)).toContain("'ServiceFactory'");
		const text = JSON.stringify(result.data);
		for (const secret of ["hunter2", "sk_live", "98765", "t_x", "postgres"]) {
			expect(text).not.toContain(secret);
		}
	}, 120_000);
});

describe("SEC-32: redacting a tsc message", () => {
	test("SEC-32: literals and quoted types are redacted, plain names kept", () => {
		expect(
			redactMessage(
				// biome-ignore lint/suspicious/noTemplateCurlyInString: a template literal type as tsc prints it
				"Type '{ readonly a: \"it's \\\" x\"; b: 5; c: `x${string}` }' is not assignable to type 'ServiceFactory'. Property 'x.y' is missing; '123'",
			),
		).toBe(
			"Type '…' is not assignable to type 'ServiceFactory'. Property 'x.y' is missing; '…'",
		);
	});

	test("SEC-32: a message full of escaped quotes is redacted in linear time", () => {
		const start = performance.now();
		for (const message of [
			`"${'\\"'.repeat(100_000)}`,
			`\`${"\\`".repeat(100_000)}`,
			"'a".repeat(100_000),
		]) {
			redactMessage(message);
		}
		expect(performance.now() - start).toBeLessThan(200);
	});
});

describe("SEC-33: a spec file that is not valid JSON", () => {
	test("SEC-33: an extended file that is not JSON is reported without its text or the project path", async () => {
		const { root } = await scratch();
		await mkdir(join(root, "config"));
		for (const text of [
			'{"Stripe": sk_live_ABCDEFGHIJ0123}\n',
			"{\"Stripe\": 'sk_live_ABCDEFGHIJ0123'}\n",
		]) {
			await writeFile(join(root, "config/appsettings.json"), text);
			await expectNoText(root);
		}
	});

	const expectNoText = async (root: string) => {
		const { issues } = await validateInProject(
			{ root },
			{ version: 1, extends: ["./config/appsettings.json"] },
		);
		const unresolved = issues.find((i) => i.code === "unresolved_extends");
		expect(unresolved?.message).toContain("config/appsettings.json");
		expect(unresolved?.message).toContain("not valid JSON");
		for (const text of ["sk_live", "Stripe", root]) {
			expect(JSON.stringify(issues)).not.toContain(text);
		}
	};

	test("SEC-33: an afora.json that is not JSON is reported without its text", async () => {
		const dir = await makeProject({
			"afora.json": '{"version": 1, "name": sk_live_ABCDEFGHIJ0123}\n',
		});
		const client = await connect({ project: dir });
		clients.push(client);
		try {
			const result = await client.call("afora_spec_read", {});
			expect(result.isError).toBe(true);
			expect(String(result.data)).toContain("not valid JSON");
			expect(String(result.data)).not.toContain("sk_live");
			expect(String(result.data)).not.toContain("name");
		} finally {
			await removeProject(dir);
		}
	});
});

describe("SEC-39: an output.dir on another drive", () => {
	test("SEC-39: validateInProject refuses an output.dir with a drive or a root", async () => {
		const { root } = await scratch();
		for (const dir of ["D:\\evil", "D:/evil", "D:evil", "\\outside"]) {
			const { issues } = await validateInProject({ root } as never, {
				version: 1,
				output: { dir },
			});
			expect(codes(issues), dir).toContain("invalid_output@output.dir");
		}
	});
});

describe("SEC-41: the tsc afora_generate runs", () => {
	/** A project without TypeScript, a tsc in a parent's node_modules/.bin and one on the PATH. */
	async function decoys(): Promise<{ root: string; ran: string[] }> {
		const base = await realpath(
			await mkdtemp(join(tmpdir(), "afora-mcp-tsc-")),
		);
		dirs.push(base);
		const root = join(base, "project");
		await mkdir(root);
		await writeFile(join(root, "tsconfig.json"), "{}");
		const ran: string[] = [];
		for (const dir of [join(base, "node_modules/.bin"), join(base, "bin")]) {
			await mkdir(dir, { recursive: true });
			const marker = join(dir, "ran");
			ran.push(marker);
			const tsc = join(dir, "tsc");
			await writeFile(tsc, `#!/bin/sh\ntouch "${marker}"\n`);
			await chmod(tsc, 0o755);
		}
		return { root, ran };
	}

	test("SEC-41: without TypeScript in the project, no other tsc runs", async () => {
		const { root, ran } = await decoys();
		const path = process.env.PATH;
		process.env.PATH = `${dirname(ran[1] as string)}:${path}`;
		try {
			const result = await typecheck(root, []);
			expect(result.ran).toBe(false);
			expect(result.ran === false && result.reason).toContain(
				"TypeScript is not installed",
			);
		} finally {
			process.env.PATH = path;
		}
		for (const marker of ran) expect(existsSync(marker), marker).toBe(false);
	}, 60_000);

	test("SEC-41: the TypeScript of the project runs", async () => {
		const { root, ran } = await decoys();
		await mkdir(join(root, "node_modules"));
		await symlink(
			join(import.meta.dir, "../../../node_modules/typescript"),
			join(root, "node_modules/typescript"),
		);
		await mkdir(join(root, "src"));
		await writeFile(join(root, "src/a.ts"), "export const a: number = 'x';\n");
		await writeFile(
			join(root, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { strict: true, types: [] },
				include: ["src"],
			}),
		);
		const result = await typecheck(root, ["src/a.ts"]);
		expect(result.ran).toBe(true);
		expect(result.ran && result.diagnostics.map((d) => d.code)).toEqual([
			"TS2322",
		]);
		for (const marker of ran) expect(existsSync(marker), marker).toBe(false);
	}, 120_000);
});

describe("SEC-53: the reason afora_generate gives when tsc fails", () => {
	/** A project whose TypeScript (5.x) prints pretty output, with an error in a module it did not generate. */
	async function prettyProject(): Promise<string> {
		const { root } = await scratch();
		await mkdir(join(root, "node_modules"));
		await symlink(
			join(
				import.meta.dir,
				"../../../node_modules/typescript-language-service",
			),
			join(root, "node_modules/typescript"),
		);
		await writeFile(
			join(root, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { pretty: true, strict: true, types: [] },
				include: ["src"],
			}),
		);
		await writeFile(
			join(root, "src/config.ts"),
			"export const port: string = 5432; // pass=hunter2\n",
		);
		await writeFile(join(root, "src/domain/a.ts"), "export const a = 1;\n");
		return root;
	}

	test("SEC-53: a tsconfig with pretty output still gives parsed diagnostics", async () => {
		const root = await prettyProject();
		const result = await typecheck(root, ["src/domain/a.ts"]);
		expect(JSON.stringify(result)).not.toContain("hunter2");
		expect(result.ran).toBe(true);
		expect(result.ran && result.ok).toBe(true);
		expect(result.ran && result.otherErrors).toBe(1);
	}, 120_000);

	test("SEC-53: a tsc that fails without a diagnostic is not echoed back", async () => {
		const { root } = await scratch();
		const ts = join(root, "node_modules/typescript");
		await mkdir(join(ts, "bin"), { recursive: true });
		await writeFile(
			join(ts, "package.json"),
			JSON.stringify({ name: "typescript", bin: { tsc: "./bin/tsc" } }),
		);
		await writeFile(
			join(ts, "bin/tsc"),
			"console.log('src/config.ts:1:1 - export const key = sk_live_LEAKME');\nprocess.exit(2);\n",
		);
		await writeFile(join(root, "tsconfig.json"), "{}");
		const result = await typecheck(root, []);
		expect(result.ran).toBe(false);
		const reason = result.ran === false ? result.reason : "";
		expect(reason).toContain("2");
		for (const text of ["sk_live", "LEAKME", "config.ts", "export"]) {
			expect(reason).not.toContain(text);
		}
	}, 60_000);
});

describe("SEC-54: a package named by extends", () => {
	test("SEC-54: a package outside the project's node_modules is not read", async () => {
		const { root } = await scratch();
		const parent = join(dirname(root), "node_modules/parentpkg");
		await mkdir(parent, { recursive: true });
		await writeFile(join(parent, "package.json"), '{"name":"parentpkg"}');
		await writeFile(
			join(parent, "afora.json"),
			JSON.stringify({
				version: 1,
				name: "OUTSIDE-PACKAGE",
				blueprints: { Outside: { fields: { a: "string" } } },
			}),
		);
		const { issues, extended } = await validateInProject(
			{ root },
			{ version: 1, extends: ["parentpkg"] },
		);
		expect(codes(issues)).toContain("unresolved_extends@extends");
		expect(JSON.stringify({ issues, extended })).not.toContain(
			"OUTSIDE-PACKAGE",
		);
	});
});

describe("SEC-55: the messages of unresolved_extends", () => {
	test("SEC-55: no message carries the project path or a path outside it", async () => {
		const { root } = await scratch();
		const base = dirname(root);
		const broken = join(base, "node_modules/brokenpkg");
		await mkdir(broken, { recursive: true });
		await writeFile(join(broken, "package.json"), '{"name":"brokenpkg"}');
		await writeFile(join(broken, "afora.json"), "{ not json");
		for (const ref of ["no-such-package-xyz", "brokenpkg", "./missing.json"]) {
			const { issues } = await validateInProject(
				{ root },
				{ version: 1, extends: [ref] },
			);
			const unresolved = issues.find((i) => i.code === "unresolved_extends");
			expect(unresolved, ref).toBeDefined();
			expect(JSON.stringify(issues), ref).not.toContain(base);
			expect(JSON.stringify(issues), ref).not.toContain(tmpdir());
		}
	});
});
