import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BANNER } from "@afora/codegen";
import { type Connected, connect, makeProject, removeProject } from "./project";

const projects: string[] = [];
const clients: Connected[] = [];
afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
});
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

async function setup(
	files: Record<string, string> = {},
	options: { app?: string } = {},
) {
	const dir = await makeProject(files);
	projects.push(dir);
	const client = await connect({ project: dir, ...options });
	clients.push(client);
	return { dir, client };
}

const exists = (path: string) => Bun.file(path).exists();

const blog = {
	address: {
		kind: "blueprint",
		name: "Address",
		declaration: { fields: { street: "string", zip: "string" } },
	},
	status: {
		kind: "property",
		name: "Status",
		declaration: { enum: ["draft", "published"] },
	},
	user: {
		kind: "entity",
		name: "User",
		declaration: {
			fields: {
				name: "text",
				email: "email",
				password: "password",
				address: "Address",
				tags: "string[]",
			},
			unique: ["email"],
			change: ["name"],
		},
	},
	post: {
		kind: "entity",
		name: "Post",
		declaration: {
			fields: { title: "text", status: "Status", author: "User" },
		},
	},
	users: {
		kind: "repository",
		name: "Users",
		declaration: {
			entity: "User",
			actions: ["findById", "findByEmail", "create"],
		},
	},
	posts: {
		kind: "repository",
		name: "Posts",
		declaration: {
			entity: "Post",
			actions: ["findById", "findManyByAuthor", "create"],
			relations: ["Users"],
		},
	},
};

describe("the server", () => {
	test("lists the tools with a JSON Schema each", async () => {
		const { client } = await setup();
		const { tools } = await client.client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"afora_catalog",
			"afora_extract",
			"afora_generate",
			"afora_spec_read",
			"afora_spec_remove",
			"afora_spec_upsert",
			"afora_spec_validate",
			"afora_spec_write",
		]);
		for (const tool of tools) {
			expect(tool.description?.length).toBeGreaterThan(40);
			expect(tool.inputSchema.type).toBe("object");
		}
		const upsert = tools.find((tool) => tool.name === "afora_spec_upsert");
		expect(upsert?.inputSchema.required).toEqual([
			"kind",
			"name",
			"declaration",
		]);
		expect(JSON.stringify(upsert?.inputSchema)).toContain("#/$defs/Field");
		expect(upsert).toBeDefined();
		const schema = (upsert as { inputSchema: { $defs?: object } }).inputSchema;
		expect(schema.$defs).toHaveProperty("Field");
		expect(
			tools.find((tool) => tool.name === "afora_catalog")?.annotations
				?.readOnlyHint,
		).toBe(true);
	});

	test("serves the schema, the catalog and the guide as resources", async () => {
		const { client } = await setup();
		const { resources } = await client.client.listResources();
		expect(resources.map((r) => r.uri).sort()).toEqual([
			"afora://catalog",
			"afora://spec/guide",
			"afora://spec/schema",
		]);
		const read = async (uri: string) =>
			(await client.client.readResource({ uri })).contents[0] as {
				text: string;
				mimeType: string;
			};
		const schema = JSON.parse((await read("afora://spec/schema")).text);
		expect(schema.title).toBe("afora.json");
		const catalog = JSON.parse((await read("afora://catalog")).text);
		expect(
			catalog.properties.some((p: { name: string }) => p.name === "email"),
		).toBe(true);
		const guide = await read("afora://spec/guide");
		expect(guide.mimeType).toBe("text/markdown");
		expect(guide.text).toContain("findManyBy<Key>");
		await expect(
			client.client.readResource({ uri: "afora://nope" }),
		).rejects.toThrow();
	});

	test("an unknown tool or bad input is an error, not a crash", async () => {
		const { client } = await setup();
		expect((await client.call("nope")).isError).toBe(true);
		const bad = await client.call("afora_spec_upsert", {
			kind: "widget",
			name: "X",
			declaration: {},
		});
		expect(bad.isError).toBe(true);
		expect(bad.data).toContain("kind");
		expect((await client.call("afora_spec_validate", {})).isError).toBe(true);
	});
});

describe("catalog -> upsert -> validate -> generate", () => {
	test("builds a blog in a project, type-checks it and reports no diagnostics", async () => {
		const { dir, client } = await setup();

		const catalog = await client.call("afora_catalog");
		expect(
			catalog.data.properties.map((p: { name: string }) => p.name),
		).toContain("slug");
		expect(
			catalog.data.recordPlugins.map((p: { name: string }) => p.name),
		).toContain("authenticatable");

		const none = await client.call("afora_spec_read");
		expect(none.data.source).toBe("none");

		for (const step of [
			blog.address,
			blog.status,
			blog.user,
			blog.post,
			blog.users,
			blog.posts,
		]) {
			const result = await client.call("afora_spec_upsert", step);
			expect(result.data.written, JSON.stringify(result.data)).toBe(true);
			expect(result.data.action).toBe("added");
		}
		const onDisk = JSON.parse(await readFile(join(dir, "afora.json"), "utf8"));
		expect(Object.keys(onDisk)).toEqual([
			"version",
			"properties",
			"blueprints",
			"entities",
			"repositories",
		]);
		expect(Object.keys(onDisk.entities)).toEqual(["User", "Post"]);

		const replaced = await client.call("afora_spec_upsert", {
			...blog.status,
			declaration: { enum: ["draft", "published", "archived"] },
		});
		expect(replaced.data.action).toBe("replaced");

		const validation = await client.call("afora_spec_validate");
		expect(validation.data).toEqual({ valid: true, issues: [] });

		const preview = await client.call("afora_generate", { dryRun: true });
		expect(preview.data.dryRun).toBe(true);
		expect(preview.data.files.map((f: { path: string }) => f.path)).toContain(
			"src/domain/entities.ts",
		);
		expect(await exists(join(dir, "src/domain"))).toBe(false);

		const generated = await client.call("afora_generate");
		expect(generated.data.generated, JSON.stringify(generated.data)).toBe(true);
		expect(generated.data.written).toContain("src/domain/index.ts");
		expect(generated.data.typecheck).toMatchObject({
			ran: true,
			ok: true,
			diagnostics: [],
		});
		const entities = await readFile(
			join(dir, "src/domain/entities.ts"),
			"utf8",
		);
		expect(entities.startsWith(BANNER)).toBe(true);
		expect(entities).toContain("export class User extends entityOf(");

		const again = await client.call("afora_generate");
		expect(again.data.written).toEqual([]);
	}, 120_000);

	test("the type check returns only the diagnostics of generated files", async () => {
		const { client } = await setup({
			"src/other.ts": "export const broken: number = 'x';\n",
		});
		await client.call("afora_spec_write", {
			spec: { version: 1, entities: { Note: { fields: { title: "text" } } } },
		});
		const result = await client.call("afora_generate");
		expect(result.data.typecheck).toMatchObject({
			ran: true,
			ok: true,
			diagnostics: [],
			otherErrors: 1,
		});
	}, 120_000);

	test("reports the TypeScript errors of the generated code", async () => {
		// A project whose @afora/core exports nothing: the generated files fail to compile.
		const { dir, client } = await setup();
		await writeFile(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noEmit: true,
					types: [],
					moduleResolution: "bundler",
					module: "Preserve",
					paths: { "@afora/core": ["./stub.d.ts"] },
				},
				include: ["src"],
			}),
		);
		await writeFile(join(dir, "stub.d.ts"), "export {};\n");
		await client.call("afora_spec_write", {
			spec: { version: 1, entities: { Note: { fields: { title: "text" } } } },
		});
		const result = await client.call("afora_generate");
		expect(result.data.typecheck.ran).toBe(true);
		expect(result.data.typecheck.ok).toBe(false);
		expect(result.data.typecheck.diagnostics[0].file).toStartWith(
			"src/domain/",
		);
		expect(result.data.typecheck.diagnostics[0].code).toBe("TS2305");
	}, 120_000);

	test("without a tsconfig it says it did not type check", async () => {
		const { dir, client } = await setup();
		await Bun.file(join(dir, "tsconfig.json")).delete();
		await client.call("afora_spec_write", { spec: { version: 1 } });
		const result = await client.call("afora_generate");
		expect(result.data.typecheck).toEqual({
			ran: false,
			reason: "The project has no tsconfig.json.",
		});
	});
});

describe("safety", () => {
	test("an invalid upsert does not write", async () => {
		const { dir, client } = await setup();
		const result = await client.call("afora_spec_upsert", {
			kind: "entity",
			name: "Post",
			declaration: { fields: { author: "Ghost" } },
		});
		expect(result.data.written).toBe(false);
		expect(result.data.issues[0]).toMatchObject({
			code: "unknown_type",
			path: ["entities", "Post", "fields", "author", "type"],
		});
		expect(await exists(join(dir, "afora.json"))).toBe(false);

		await client.call("afora_spec_write", { spec: { version: 1 } });
		const before = await readFile(join(dir, "afora.json"), "utf8");
		const again = await client.call("afora_spec_upsert", {
			kind: "entity",
			name: "Bad",
			declaration: { fields: { id: "text" } },
		});
		expect(again.data.issues.map((i: { code: string }) => i.code)).toContain(
			"identity_key",
		);
		expect(await readFile(join(dir, "afora.json"), "utf8")).toBe(before);
	});

	test("an invalid spec_write does not write; a valid one does", async () => {
		const { dir, client } = await setup();
		const bad = await client.call("afora_spec_write", { spec: { version: 2 } });
		expect(bad.data.written).toBe(false);
		expect(await exists(join(dir, "afora.json"))).toBe(false);
		const good = await client.call("afora_spec_write", {
			spec: { version: 1, name: "x" },
		});
		expect(good.data.written).toBe(true);
		expect(JSON.parse(await readFile(join(dir, "afora.json"), "utf8"))).toEqual(
			{ version: 1, name: "x" },
		);
	});

	test("removing something that is referenced is refused", async () => {
		const { dir, client } = await setup();
		for (const step of [blog.address, blog.user, blog.users])
			await client.call("afora_spec_upsert", step);
		const refused = await client.call("afora_spec_remove", {
			kind: "entity",
			name: "User",
		});
		expect(refused.data.written).toBe(false);
		expect(
			JSON.parse(await readFile(join(dir, "afora.json"), "utf8")).entities.User,
		).toBeDefined();
		const removed = await client.call("afora_spec_remove", {
			kind: "repository",
			name: "Users",
		});
		expect(removed.data).toMatchObject({ written: true, action: "removed" });
		expect(
			JSON.parse(await readFile(join(dir, "afora.json"), "utf8")).repositories,
		).toBeUndefined();
		expect(
			(
				await client.call("afora_spec_remove", {
					kind: "repository",
					name: "Nope",
				})
			).isError,
		).toBe(true);
	});

	test("an output.dir outside the project is rejected", async () => {
		const { dir, client } = await setup();
		const result = await client.call("afora_spec_write", {
			spec: {
				version: 1,
				output: { dir: "../outside" },
				blueprints: { A: { fields: { x: "text" } } },
			},
		});
		expect(result.data.written).toBe(false);
		expect(result.data.issues[0].code).toBe("invalid_output");
		// even a hand-edited afora.json cannot make the generator leave the project
		await writeFile(
			join(dir, "afora.json"),
			JSON.stringify({
				version: 1,
				output: { dir: "../outside" },
				blueprints: { A: { fields: { x: "text" } } },
			}),
		);
		const generated = await client.call("afora_generate");
		expect(generated.data.generated).toBe(false);
		expect(await exists(resolve(dir, "../outside"))).toBe(false);
	});

	test("a symlinked output directory that leaves the project is refused", async () => {
		const { dir, client } = await setup();
		const outside = join(tmpdir(), `afora-outside-${Date.now()}`);
		await mkdir(outside, { recursive: true });
		await mkdir(join(dir, "src"));
		await symlink(outside, join(dir, "src/domain"));
		await client.call("afora_spec_write", {
			spec: { version: 1, blueprints: { A: { fields: { x: "text" } } } },
		});
		const generated = await client.call("afora_generate");
		expect(generated.data.generated).toBe(false);
		expect(generated.data.refused.length).toBeGreaterThan(0);
		expect(await exists(join(outside, "index.ts"))).toBe(false);
	});

	test("a symlinked afora.json that leaves the project is not written through", async () => {
		const { dir, client } = await setup();
		const outside = join(tmpdir(), `afora-spec-${Date.now()}.json`);
		await writeFile(outside, '{"version":1}');
		await symlink(outside, join(dir, "afora.json"));
		const result = await client.call("afora_spec_write", {
			spec: { version: 1, name: "hacked" },
		});
		expect(result.isError).toBe(true);
		expect(await readFile(outside, "utf8")).toBe('{"version":1}');
	});

	test("a file that is not generated is never overwritten, and nothing else is written", async () => {
		const { dir, client } = await setup({
			"src/domain/index.ts": "export const mine = 1;\n",
		});
		await client.call("afora_spec_write", {
			spec: { version: 1, blueprints: { A: { fields: { x: "text" } } } },
		});
		const result = await client.call("afora_generate");
		expect(result.data.generated).toBe(false);
		expect(result.data.refused[0].path).toBe("src/domain/index.ts");
		expect(await readFile(join(dir, "src/domain/index.ts"), "utf8")).toBe(
			"export const mine = 1;\n",
		);
		expect(await exists(join(dir, "src/domain/blueprints.ts"))).toBe(false);
	});

	test("a generated file left over is removed only when it carries the banner", async () => {
		const { dir, client } = await setup();
		await client.call("afora_spec_write", {
			spec: {
				version: 1,
				blueprints: { A: { fields: { x: "text" } } },
				environments: { Env: { fields: { PORT: "integer" } } },
			},
		});
		await client.call("afora_generate", { typecheck: false });
		expect(await exists(join(dir, "src/domain/environments.ts"))).toBe(true);
		await client.call("afora_spec_remove", {
			kind: "environment",
			name: "Env",
		});
		await writeFile(
			join(dir, "src/domain/properties.ts"),
			"export const mine = 1;\n",
		);
		const result = await client.call("afora_generate", { typecheck: false });
		expect(result.data.removed).toEqual(["src/domain/environments.ts"]);
		expect(await exists(join(dir, "src/domain/environments.ts"))).toBe(false);
		expect(await readFile(join(dir, "src/domain/properties.ts"), "utf8")).toBe(
			"export const mine = 1;\n",
		);
	});

	test("the application to extract must be inside the project", async () => {
		const { client } = await setup();
		const result = await client.call("afora_extract", {
			app: "../../etc/app.ts#App",
		});
		expect(result.isError).toBe(true);
		expect(result.data).toContain("outside the project");
	});
});

describe("extract from an application", () => {
	const core = resolve(import.meta.dir, "../../../src/index.ts");
	const app = `import { applicationOf, blueprintOf, entityOf, repositoryOf } from "@afora/core";
console.log("a log that must not break the extraction");
class Note extends entityOf(blueprintOf((ctx) => ({ title: ctx.text, tags: ctx.list.string }))) {}
const Notes = repositoryOf({ entity: Note, actions: ["findById", "create"] });
export const App = applicationOf({ name: "notes", entities: { Note }, repositories: { Notes } });
`;
	void core;

	test("afora_extract gives the spec, validated, without writing", async () => {
		const { dir, client } = await setup({ "src/app.ts": app });
		const result = await client.call("afora_extract", {
			app: "src/app.ts#App",
		});
		expect(result.isError, JSON.stringify(result.data)).toBe(false);
		expect(result.data.spec).toEqual({
			version: 1,
			name: "notes",
			output: { dir: "src/domain" },
			entities: { Note: { fields: { title: "text", tags: "string[]" } } },
			repositories: {
				Notes: { entity: "Note", actions: ["findById", "create"] },
			},
		});
		expect(result.data.valid).toBe(true);
		expect(await exists(join(dir, "afora.json"))).toBe(false);
	}, 60_000);

	test("afora_spec_read falls back to the configured application, and upsert builds on it", async () => {
		const { dir, client } = await setup(
			{ "src/app.ts": app },
			{ app: "src/app.ts#App" },
		);
		const read = await client.call("afora_spec_read");
		expect(read.data.source).toBe("app");
		expect(read.data.spec.entities.Note).toBeDefined();
		const upsert = await client.call("afora_spec_upsert", {
			kind: "blueprint",
			name: "Extra",
			declaration: { fields: { x: "text" } },
		});
		expect(upsert.data.written).toBe(true);
		const saved = JSON.parse(await readFile(join(dir, "afora.json"), "utf8"));
		expect(Object.keys(saved.entities)).toEqual(["Note"]);
		expect(Object.keys(saved.blueprints)).toEqual(["Extra"]);
		expect((await client.call("afora_spec_read")).data.source).toBe("file");
	}, 60_000);

	test("reports an application that cannot be imported", async () => {
		const { client } = await setup({
			"src/app.ts": "throw new Error('boom');\n",
		});
		const result = await client.call("afora_extract", {
			app: "src/app.ts#App",
		});
		expect(result.isError).toBe(true);
		expect(result.data).toContain("boom");
		expect(
			(await client.call("afora_extract", { app: "src/missing.ts#App" }))
				.isError,
		).toBe(true);
		expect((await client.call("afora_extract", {})).isError).toBe(true);
	}, 60_000);
});

describe("extends", () => {
	test("a spec that extends another one in the project is validated and generated with it", async () => {
		const { dir, client } = await setup();
		await mkdir(join(dir, "auth"), { recursive: true });
		await writeFile(
			join(dir, "auth/afora.json"),
			JSON.stringify({
				version: 1,
				name: "auth",
				output: { dir: "src/auth" },
				entities: {
					Account: { fields: { name: "text" }, plugins: ["authenticatable"] },
				},
			}),
		);
		const ok = await client.call("afora_spec_write", {
			spec: {
				version: 1,
				name: "journal",
				extends: ["./auth/afora.json"],
				entities: { Entry: { fields: { owner: "Account", title: "text" } } },
			},
		});
		expect(ok.data.written, JSON.stringify(ok.data)).toBe(true);
		const missing = await client.call("afora_spec_validate", {
			spec: { version: 1, extends: ["./nope/afora.json"] },
		});
		expect(missing.data.issues[0].code).toBe("unresolved_extends");
		const generated = await client.call("afora_generate", { typecheck: false });
		expect(generated.data.generated).toBe(true);
		expect(
			await readFile(join(dir, "src/domain/entities.ts"), "utf8"),
		).toContain('import { Account } from "../../auth/src/auth";');
	});
});
