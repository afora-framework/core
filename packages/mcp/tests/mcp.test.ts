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
			"afora_project",
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
	test("authors soft deletion and rejects invalid modes without changing the spec", async () => {
		const { dir, client } = await setup();
		expect(
			(
				await client.call("afora_spec_upsert", {
					kind: "entity",
					name: "Item",
					declaration: { fields: { name: "string" } },
				})
			).isError,
		).not.toBe(true);
		const repository = {
			kind: "repository",
			name: "Items",
			declaration: {
				entity: "Item",
				actions: ["create", "delete"],
				deletion: "soft",
			},
		};
		expect(
			(await client.call("afora_spec_upsert", repository)).isError,
		).not.toBe(true);
		const before = await Bun.file(join(dir, "afora.json")).text();
		expect(JSON.parse(before).repositories.Items.deletion).toBe("soft");
		const invalid = await client.call("afora_spec_upsert", {
			...repository,
			declaration: { ...repository.declaration, deletion: "archive" },
		});
		expect(invalid.data.written).toBe(false);
		expect(invalid.data.issues).toContainEqual({
			code: "invalid_deletion",
			path: ["repositories", "Items", "deletion"],
			message: 'Expected "hard" or "soft".',
		});
		expect(await Bun.file(join(dir, "afora.json")).text()).toBe(before);
	});

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

	test("authors a variant field, refuses an invalid one and generates code that type-checks", async () => {
		const { dir, client } = await setup();
		const { tools } = await client.client.listTools();
		const upsert = tools.find((tool) => tool.name === "afora_spec_upsert");
		expect(JSON.stringify(upsert?.inputSchema)).toContain('"variant"');
		const guide = (
			await client.client.readResource({ uri: "afora://spec/guide" })
		).contents[0] as { text: string };
		expect(guide.text).toContain('{ "variant": { "key": "type"');

		await client.call("afora_spec_write", {
			spec: {
				version: 1,
				blueprints: {
					Click: { fields: { target: "string" } },
					Signup: { fields: { email: "email" } },
				},
			},
		});
		const event = (of: Record<string, unknown>) => ({
			kind: "entity",
			name: "Event",
			declaration: {
				fields: {
					at: "dateTime",
					what: { variant: { key: "type", of }, list: true },
				},
			},
		});
		const invalid = await client.call(
			"afora_spec_upsert",
			event({ click: "Click", signup: "Missing" }),
		);
		expect(invalid.data.written).toBe(false);
		expect(invalid.data.issues).toContainEqual(
			expect.objectContaining({
				code: "unknown_type",
				path: [
					"entities",
					"Event",
					"fields",
					"what",
					"variant",
					"of",
					"signup",
				],
			}),
		);
		const valid = await client.call(
			"afora_spec_upsert",
			event({ click: "Click", signup: "Signup" }),
		);
		expect(valid.data.written, JSON.stringify(valid.data)).toBe(true);

		const generated = await client.call("afora_generate");
		expect(generated.data.typecheck).toMatchObject({
			ran: true,
			ok: true,
			diagnostics: [],
		});
		const entities = await readFile(
			join(dir, "src/domain/entities.ts"),
			"utf8",
		);
		expect(entities).toContain(
			'what: listOf(ctx.variantOf("type", { click: Click, signup: Signup })),',
		);
	}, 120_000);
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

describe("providers and query actions", () => {
	const providers = [
		{ name: "memory", module: "../providers", export: "memoryProvider" },
	];
	const providersTs = `import { inMemoryProvider, providerOf } from "@afora/core";
export const memoryProvider = (options: { label?: string } = {}) =>
	providerOf({ name: "memory", options: { label: options.label ?? null }, create: () => inMemoryProvider() });
`;
	const repository = {
		kind: "repository",
		name: "Items",
		declaration: {
			entity: "Item",
			actions: ["create", "findMany", "exists", "findPage"],
			provider: { use: "memory", options: { label: "repo" } },
		},
	};

	async function withItem() {
		const { dir, client } = await setup({ "src/providers.ts": providersTs });
		await client.close();
		const configured = await connect({ project: dir, providers });
		clients.push(configured);
		const added = await configured.call("afora_spec_upsert", {
			kind: "entity",
			name: "Item",
			declaration: { fields: { name: "string" } },
		});
		expect(added.data.written, JSON.stringify(added.data)).toBe(true);
		return { dir, client: configured };
	}

	test("the catalog lists the providers; authoring, generating and extracting use them", async () => {
		const { dir, client } = await withItem();
		const catalog = await client.call("afora_catalog");
		expect(catalog.data.providers.map((p: { name: string }) => p.name)).toEqual(
			["inMemory", "memory"],
		);
		expect(
			catalog.data.repositoryActions.map((a: { action: string }) => a.action),
		).toEqual(expect.arrayContaining(["findMany", "exists", "findPage"]));

		expect(
			(await client.call("afora_spec_upsert", repository)).data.written,
		).toBe(true);
		const written = await client.call("afora_spec_write", {
			spec: {
				...JSON.parse(await readFile(join(dir, "afora.json"), "utf8")),
				provider: "inMemory",
			},
		});
		expect(written.data.written, JSON.stringify(written.data)).toBe(true);
		const onDisk = JSON.parse(await readFile(join(dir, "afora.json"), "utf8"));
		expect(Object.keys(onDisk)).toEqual([
			"version",
			"provider",
			"entities",
			"repositories",
		]);

		const generated = await client.call("afora_generate");
		expect(generated.data.generated, JSON.stringify(generated.data)).toBe(true);
		expect(generated.data.typecheck).toMatchObject({
			ok: true,
			diagnostics: [],
		});
		const repositories = await readFile(
			join(dir, "src/domain/repositories.ts"),
			"utf8",
		);
		expect(repositories).toContain('memoryProvider({ label: "repo" })');
		const application = await readFile(
			join(dir, "src/domain/application.ts"),
			"utf8",
		);
		expect(application).toContain("provider: inMemoryProvider()");

		const extracted = await client.call("afora_extract", {
			app: "src/domain/index.ts#App",
		});
		expect(extracted.isError, JSON.stringify(extracted.data)).toBe(false);
		expect(extracted.data.spec.provider).toBe("inMemory");
		expect(extracted.data.spec.repositories.Items.provider).toEqual({
			use: "memory",
			options: { label: "repo" },
		});
		expect(extracted.data.spec.repositories.Items.actions).toEqual([
			"create",
			"findMany",
			"exists",
			"findPage",
		]);
	}, 120_000);

	test("invalid providers are reported and nothing is written", async () => {
		const { dir, client } = await withItem();
		expect(
			(await client.call("afora_spec_upsert", repository)).data.written,
		).toBe(true);
		const before = await readFile(join(dir, "afora.json"), "utf8");
		for (const [provider, code] of [
			[{ use: "postgres" }, "unknown_provider"],
			[{ use: "memory", options: [] }, "invalid_provider"],
			[{ import: "./db.ts" }, "invalid_import"],
		] as const) {
			const result = await client.call("afora_spec_upsert", {
				...repository,
				declaration: { ...repository.declaration, provider },
			});
			expect(result.data.written).toBe(false);
			expect(
				result.data.issues.map((issue: { code: string }) => issue.code),
			).toContain(code);
			expect(await readFile(join(dir, "afora.json"), "utf8")).toBe(before);
		}
		const top = await client.call("afora_spec_write", {
			spec: { ...JSON.parse(before), provider: "memory" },
		});
		expect(top.data.written).toBe(false);
		expect(top.data.issues).toContainEqual(
			expect.objectContaining({ code: "unknown_provider", path: ["provider"] }),
		);
		expect(await readFile(join(dir, "afora.json"), "utf8")).toBe(before);
	});

	test("named providers are written in order and referenced by key", async () => {
		const { dir, client } = await withItem();
		const spec = {
			...JSON.parse(await readFile(join(dir, "afora.json"), "utf8")),
			repositories: {
				Items: { entity: "Item", actions: ["create"], provider: "audt" },
			},
			providers: { main: "inMemory", audit: "inMemory" },
			provider: "main",
		};
		const bad = await client.call("afora_spec_write", { spec });
		expect(bad.data.written).toBe(false);
		expect(bad.data.issues).toContainEqual(
			expect.objectContaining({
				code: "unknown_provider",
				path: ["repositories", "Items", "provider"],
				message: expect.stringContaining("main, audit"),
			}),
		);
		const written = await client.call("afora_spec_write", {
			spec: {
				...spec,
				repositories: {
					Items: { entity: "Item", actions: ["create"], provider: "audit" },
				},
			},
		});
		expect(written.data.written, JSON.stringify(written.data)).toBe(true);
		const onDisk = JSON.parse(await readFile(join(dir, "afora.json"), "utf8"));
		expect(Object.keys(onDisk)).toEqual([
			"version",
			"provider",
			"providers",
			"entities",
			"repositories",
		]);
		const generated = await client.call("afora_generate");
		expect(generated.data.typecheck).toMatchObject({ ok: true });
		expect(
			await readFile(join(dir, "src/domain/repositories.ts"), "utf8"),
		).toContain("provider: Providers.audit");
	}, 120_000);

	test("without the catalog a catalog provider is unknown", async () => {
		const { client } = await setup();
		const result = await client.call("afora_spec_validate", {
			spec: { version: 1, provider: { use: "memory" } },
		});
		expect(result.data.issues[0]).toMatchObject({
			code: "unknown_provider",
			path: ["provider", "use"],
		});
	});

	test("extracting an anonymous provider asks for imports", async () => {
		const app = `import { applicationOf, blueprintOf, entityOf, inMemoryProvider, repositoryOf } from "@afora/core";
class Note extends entityOf(blueprintOf((ctx) => ({ title: ctx.text }))) {}
const Notes = repositoryOf({ entity: Note, actions: ["create"] });
const base = inMemoryProvider();
export const anonymous = { findOne: base.findOne, findMany: base.findMany, insert: base.insert, update: base.update, remove: base.remove, count: base.count };
export const App = applicationOf({ name: "notes", entities: { Note }, repositories: { Notes }, provider: anonymous });
`;
		const { client } = await setup({ "src/app.ts": app });
		const failed = await client.call("afora_extract", {
			app: "src/app.ts#App",
		});
		expect(failed.isError).toBe(true);
		expect(failed.data).toContain("imports");
		expect(failed.data).toContain('"provider"');
		const ok = await client.call("afora_extract", {
			app: "src/app.ts#App",
			imports: { provider: "../app#anonymous" },
		});
		expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
		expect(ok.data.spec.provider).toEqual({ import: "../app#anonymous" });
	}, 60_000);
});

describe("exceptions and use cases", () => {
	const hashTs =
		"export const hashPassword = (plain: unknown) => String(plain);\n";
	const greetTs = `import { GreetBase } from "../domain/greet.use-case";
export class Greet extends GreetBase {
	override async execute() {
		return { greeting: \`Hello, \${this.input.name}!\` };
	}
}
`;
	const declarations = [
		{
			kind: "entity",
			name: "User",
			declaration: {
				fields: { name: "text", email: "email", hash: "string" },
				unique: ["email"],
				sensitive: ["hash"],
			},
		},
		{
			kind: "repository",
			name: "Users",
			declaration: { entity: "User", actions: ["findByEmail", "create"] },
		},
		{
			kind: "exception",
			name: "UserAlreadyExists",
			declaration: { layer: "use-case", message: "Taken." },
		},
		{
			kind: "useCase",
			name: "Register",
			declaration: {
				input: {
					fields: { name: "text", email: "email", plainPassword: "string" },
				},
				response: { fields: { user: "User" } },
				dependencies: { users: "Users" },
				errors: ["UserAlreadyExists"],
				implementation: {
					steps: [
						{
							find: "users.findByEmail",
							args: ["$input.email"],
							as: "existing",
						},
						{
							ensure: "absent",
							value: "$existing",
							error: "UserAlreadyExists",
						},
						{
							run: "hashPassword",
							fn: { import: "../hash#hashPassword" },
							args: ["$input.plainPassword"],
							params: { fields: { plain: "string" } },
							as: "hash",
						},
						{
							build: "User",
							values: {
								name: "$input.name",
								email: "$input.email",
								hash: "$hash",
							},
							as: "user",
						},
						{ create: "users", value: "$user", as: "saved" },
						{ return: { user: "$saved" } },
					],
				},
			},
		},
		{
			kind: "useCase",
			name: "Greet",
			declaration: {
				input: { fields: { name: "text" } },
				response: { fields: { greeting: "string" } },
				implementation: { import: "../handlers/greet#Greet" },
			},
		},
	];

	test("a run with args and no params is refused by afora_spec_validate and afora_spec_upsert", async () => {
		const { dir, client } = await setup({ "src/hash.ts": hashTs });
		for (const declaration of declarations.slice(0, 3)) {
			await client.call("afora_spec_upsert", declaration);
		}
		const register = JSON.parse(JSON.stringify(declarations[3]));
		delete register.declaration.implementation.steps[2].params;
		const before = await readFile(join(dir, "afora.json"), "utf8");
		const upserted = await client.call("afora_spec_upsert", register);
		expect(upserted.data.written).toBe(false);
		expect(upserted.data.issues).toContainEqual(
			expect.objectContaining({
				code: "run_without_params",
				path: ["useCases", "Register", "implementation", "steps", 2, "args"],
			}),
		);
		expect(await readFile(join(dir, "afora.json"), "utf8")).toBe(before);
		const validated = await client.call("afora_spec_validate", {
			spec: {
				...JSON.parse(before),
				useCases: { Register: register.declaration },
			},
		});
		expect(
			validated.data.issues.map((i: { code: string }) => i.code),
		).toContain("run_without_params");
	});

	test("the catalog and the guide teach them", async () => {
		const { client } = await setup();
		const catalog = await client.call("afora_catalog");
		expect(catalog.data.exceptionLayers).toContain("use-case");
		expect(catalog.data.coreExceptions).toContain("RepositoryUniqueViolation");
		const guide = (
			await client.client.readResource({ uri: "afora://spec/guide" })
		).contents[0] as { text: string };
		expect(guide.text).toContain("Exceptions and use cases");
		expect(guide.text).not.toContain("not supported yet");
	});

	test("authors, generates, runs and extracts them; invalid ones are not written", async () => {
		const { dir, client } = await setup({
			"src/hash.ts": hashTs,
			"src/handlers/greet.ts": greetTs,
		});
		for (const declaration of declarations) {
			const result = await client.call("afora_spec_upsert", declaration);
			expect(result.data.written, JSON.stringify(result.data)).toBe(true);
		}
		const spec = JSON.parse(await readFile(join(dir, "afora.json"), "utf8"));
		expect(Object.keys(spec)).toEqual([
			"version",
			"entities",
			"repositories",
			"exceptions",
			"useCases",
		]);

		const before = await readFile(join(dir, "afora.json"), "utf8");
		const bad = await client.call("afora_spec_upsert", {
			kind: "useCase",
			name: "Broken",
			declaration: {
				input: { fields: {} },
				response: { fields: {} },
				implementation: { steps: [{ find: "users.findByEmail", as: "x" }] },
			},
		});
		expect(bad.data.written).toBe(false);
		expect(bad.data.issues.map((i: { code: string }) => i.code)).toEqual(
			expect.arrayContaining(["unknown_dependency", "missing_return"]),
		);
		expect(await readFile(join(dir, "afora.json"), "utf8")).toBe(before);

		const generated = await client.call("afora_generate");
		expect(generated.data.generated, JSON.stringify(generated.data)).toBe(true);
		expect(generated.data.typecheck).toMatchObject({
			ok: true,
			diagnostics: [],
		});
		expect(await exists(join(dir, "src/domain/exceptions.ts"))).toBe(true);
		expect(await exists(join(dir, "src/domain/use-cases.ts"))).toBe(true);

		const missing = await client.call("afora_extract", {
			app: "src/domain/index.ts#App",
		});
		expect(missing.isError).toBe(true);
		expect(missing.data).toContain("useCases.");
		const extracted = await client.call("afora_extract", {
			app: "src/domain/index.ts#App",
			imports: {
				"useCases.Register.run.hashPassword": "../hash#hashPassword",
				"useCases.Greet": "../handlers/greet#Greet",
			},
		});
		expect(extracted.isError, JSON.stringify(extracted.data)).toBe(false);
		expect(extracted.data.valid).toBe(true);
		expect(extracted.data.spec.useCases.Greet.implementation).toEqual({
			import: "../handlers/greet#Greet",
		});
		expect(extracted.data.spec.exceptions.UserAlreadyExists).toEqual({
			layer: "use-case",
			message: "Taken.",
		});
		expect(extracted.data.spec.useCases.Register).toEqual(
			spec.useCases.Register,
		);
	}, 120_000);

	test("removing an exception a use case lists is refused", async () => {
		const { dir, client } = await setup({
			"src/hash.ts": hashTs,
			"src/handlers/greet.ts": greetTs,
		});
		for (const declaration of declarations) {
			await client.call("afora_spec_upsert", declaration);
		}
		const before = await readFile(join(dir, "afora.json"), "utf8");
		const removed = await client.call("afora_spec_remove", {
			kind: "exception",
			name: "UserAlreadyExists",
		});
		expect(removed.data.written).toBe(false);
		expect(await readFile(join(dir, "afora.json"), "utf8")).toBe(before);
	});
});

describe("commands and outputs", () => {
	const stagesTs = `import { transformOf } from "@afora/core";

export const label = transformOf({
	name: "label",
	apply: (operation, options: { tag?: string }) => ({
		...operation,
		tags: [...operation.tags, options.tag ?? "labeled"],
	}),
});
`;
	const eventsTs =
		"export const dispatch = (_events: readonly unknown[]) => {};\n";
	const declarations = [
		{
			kind: "entity",
			name: "User",
			declaration: { fields: { name: "text", email: "email" } },
		},
		{
			kind: "repository",
			name: "Users",
			declaration: { entity: "User", actions: ["findById", "create"] },
		},
		{
			kind: "useCase",
			name: "Register",
			declaration: {
				input: { fields: { name: "text", email: "email" } },
				response: { fields: { user: "User" } },
				dependencies: { users: "Users" },
				implementation: {
					steps: [
						{
							build: "User",
							values: { name: "$input.name", email: "$input.email" },
							as: "user",
						},
						{ create: "users", value: "$user", as: "saved" },
						{ return: { user: "$saved" } },
					],
				},
			},
		},
		{
			kind: "command",
			name: "Accounts",
			declaration: {
				tags: ["public"],
				useCases: { register: "Register" },
				transaction: true,
				events: { import: "../events#dispatch" },
			},
		},
		{
			kind: "output",
			name: "Api",
			declaration: {
				commands: ["Accounts"],
				pipe: [
					{ transform: "select", options: { tags: ["public"] } },
					{ transform: "label", options: { tag: "api" } },
					{
						sink: "openapi",
						options: { info: { title: "Blog", version: "1.0.0" } },
					},
				],
			},
		},
	];

	async function withStages() {
		const dir = await makeProject({
			"src/stages.ts": stagesTs,
			"src/events.ts": eventsTs,
		});
		projects.push(dir);
		const client = await connect({
			project: dir,
			stages: [
				{
					name: "label",
					module: "../stages",
					export: "label",
					kind: "transform",
				},
			],
		});
		clients.push(client);
		return { dir, client };
	}

	test("the catalog lists the stages, built in and supplied", async () => {
		const { client } = await withStages();
		const catalog = await client.call("afora_catalog");
		expect(catalog.data.stages.map((s: { name: string }) => s.name)).toEqual([
			"openapi",
			"select",
			"label",
		]);
		const guide = (
			await client.client.readResource({ uri: "afora://spec/guide" })
		).contents[0] as { text: string };
		expect(guide.text).toContain("Commands and outputs");
	});

	test("authors, generates, builds the document and extracts them", async () => {
		const { dir, client } = await withStages();
		for (const declaration of declarations) {
			const result = await client.call("afora_spec_upsert", declaration);
			expect(result.data.written, JSON.stringify(result.data)).toBe(true);
		}
		const spec = JSON.parse(await readFile(join(dir, "afora.json"), "utf8"));
		expect(Object.keys(spec)).toEqual([
			"version",
			"entities",
			"repositories",
			"useCases",
			"commands",
			"outputs",
		]);

		const before = await readFile(join(dir, "afora.json"), "utf8");
		const bad = await client.call("afora_spec_upsert", {
			kind: "output",
			name: "Broken",
			declaration: {
				commands: ["Accounts"],
				pipe: [{ sink: "nope" }, { transform: "select" }],
			},
		});
		expect(bad.data.written).toBe(false);
		expect(bad.data.issues.map((i: { code: string }) => i.code)).toEqual(
			expect.arrayContaining(["unknown_stage", "sink_not_last"]),
		);
		expect(await readFile(join(dir, "afora.json"), "utf8")).toBe(before);

		const generated = await client.call("afora_generate");
		expect(generated.data.generated, JSON.stringify(generated.data)).toBe(true);
		expect(generated.data.typecheck).toMatchObject({
			ok: true,
			diagnostics: [],
		});
		expect(await exists(join(dir, "src/domain/commands.ts"))).toBe(true);
		expect(await exists(join(dir, "src/domain/outputs.ts"))).toBe(true);

		const missing = await client.call("afora_extract", {
			app: "src/domain/index.ts#App",
		});
		expect(missing.isError).toBe(true);
		expect(missing.data).toContain("commands.Accounts.events");
		const extracted = await client.call("afora_extract", {
			app: "src/domain/index.ts#App",
			imports: { "commands.Accounts.events": "../events#dispatch" },
		});
		expect(extracted.isError, JSON.stringify(extracted.data)).toBe(false);
		expect(extracted.data.valid).toBe(true);
		expect(extracted.data.spec.commands.Accounts).toEqual(
			spec.commands.Accounts,
		);
		expect(extracted.data.spec.outputs.Api).toEqual(spec.outputs.Api);
	}, 120_000);

	test("an unknown stage is rejected without the --stages catalog", async () => {
		const { client } = await setup();
		for (const declaration of declarations.slice(0, 4)) {
			await client.call("afora_spec_upsert", declaration);
		}
		const result = await client.call("afora_spec_upsert", declarations[4]);
		expect(result.data.written).toBe(false);
		expect(result.data.issues.map((i: { code: string }) => i.code)).toContain(
			"unknown_stage",
		);
	});
});
