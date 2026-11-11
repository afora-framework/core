import { afterAll, describe, expect, test } from "bun:test";
import { join, posix } from "node:path";
import {
	blueprintOf,
	entityOf,
	listOf,
	optionalOf,
	Password,
	recordOf,
	toOpenAPI,
} from "@afora/core";
import {
	BANNER,
	GENERATED_FILES,
	type GeneratedFile,
	generate,
	InvalidSpecError,
	type Spec,
} from "../src";
import {
	authSpec,
	blogSpec,
	extendsContext,
	extendsSpec,
	quickstartSpec,
} from "./fixtures";
import { BIOME, makeProject, removeProject, run } from "./project";
import { variantSpec } from "./roundtrip/fixtures/variant";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

const prefixed = (files: GeneratedFile[], dir: string): GeneratedFile[] =>
	files.map((file) => ({ ...file, path: posix.join(dir, file.path) }));

const BIOME_CONFIG = JSON.stringify({
	formatter: { indentStyle: "tab" },
	javascript: { formatter: { quoteStyle: "double" } },
	linter: { rules: { preset: "recommended" } },
	assist: { actions: { source: { organizeImports: "on" } } },
});

/** Every fixture with the files it generates. */
const fixtures = {
	quickstart: generate(quickstartSpec),
	blog: generate(blogSpec),
	auth: generate(authSpec),
	journal: generate(extendsSpec, extendsContext),
	variant: generate(variantSpec),
};

describe("snapshots", () => {
	for (const [name, files] of Object.entries(fixtures)) {
		test(name, () => {
			expect(
				Object.fromEntries(files.map((file) => [file.path, file.contents])),
			).toMatchSnapshot();
		});
	}
});

describe("shape", () => {
	test("every file starts with the banner, and ends with a newline", () => {
		for (const files of Object.values(fixtures)) {
			for (const file of files) {
				expect(file.contents.startsWith(`${BANNER}\n`)).toBe(true);
				expect(file.contents.endsWith("\n")).toBe(true);
				expect(file.contents.endsWith("\n\n")).toBe(false);
			}
		}
	});

	test("files are named after the kinds, in output.dir, plus application and index", () => {
		expect(fixtures.blog.map((file) => file.path).sort()).toEqual([
			"src/domain/application.ts",
			"src/domain/blueprints.ts",
			"src/domain/entities.ts",
			"src/domain/environments.ts",
			"src/domain/index.ts",
			"src/domain/properties.ts",
			"src/domain/repositories.ts",
		]);
		for (const file of fixtures.blog) {
			expect(GENERATED_FILES as readonly string[]).toContain(
				posix.basename(file.path),
			);
		}
	});

	test("is deterministic, whatever the order of the keys", () => {
		expect(generate(blogSpec)).toEqual(generate(blogSpec));
		const reversed = Object.fromEntries(
			Object.entries(blogSpec)
				.reverse()
				.map(([key, value]) =>
					value &&
					typeof value === "object" &&
					!Array.isArray(value) &&
					key !== "output"
						? [key, Object.fromEntries(Object.entries(value).reverse())]
						: [key, value],
				),
		) as unknown as Spec;
		expect(generate(reversed)).toEqual(generate(blogSpec));
	});

	test("refuses an invalid spec, with the issues", () => {
		try {
			generate({ version: 1, entities: { X: { fields: { a: "nope" } } } });
			throw new Error("should throw");
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidSpecError);
			expect((error as InvalidSpecError).issues[0]?.code).toBe("unknown_type");
		}
	});

	test("uses ctx only when a field needs it", () => {
		const [file] = generate({
			version: 1,
			blueprints: {
				A: { fields: { n: { fields: { x: "text" } } } },
				B: { fields: { c: "A" } },
			},
		}).filter((f) => f.path.endsWith("blueprints.ts"));
		expect(file?.contents).toContain("export const B = blueprintOf(() => ({");
		expect(file?.contents).toContain("n: blueprintOf((ctx) => ({");
	});

	test("kinds that need each other share one file", () => {
		const spec: Spec = {
			version: 1,
			blueprints: { Box: { fields: { tag: "Tag" } } },
			records: {
				Tag: { fields: { label: "text" } },
				Crate: { fields: { box: "Box" } },
			},
		};
		const files = generate(spec);
		const names = files.map((f) => posix.basename(f.path));
		// Box needs Tag (records) and Crate (records) needs Box: no import cycle between files
		expect(names).toContain("records.ts");
		expect(names).not.toContain("blueprints.ts");
		const records =
			files.find((f) => f.path.endsWith("/records.ts"))?.contents ?? "";
		expect(records).toContain("export class Tag");
		expect(records).toContain("export const Box");
		expect(records.indexOf("class Tag")).toBeLessThan(
			records.indexOf("const Box"),
		);
		expect(records.indexOf("const Box")).toBeLessThan(
			records.indexOf("class Crate"),
		);
	});

	test("opaque properties are imported and re-exported", () => {
		const files = generate({
			version: 1,
			properties: { Raw: { opaque: true, ref: "RawText", import: "../raw" } },
			records: { Note: { fields: { body: "Raw" } } },
		});
		const properties = files.find((f) =>
			f.path.endsWith("properties.ts"),
		)?.contents;
		expect(properties).toContain('import { RawText as Raw } from "../raw";');
		expect(properties).toContain("export { Raw };");
	});
});

describe("generated code", () => {
	async function project() {
		const dir = await makeProject(
			[
				...prefixed(fixtures.quickstart, "quickstart"),
				...prefixed(fixtures.blog, "blog"),
				...prefixed(fixtures.auth, "auth"),
				...prefixed(fixtures.journal, "journal"),
				...prefixed(fixtures.variant, "variant"),
			],
			{},
			["**/*.ts"],
		);
		projects.push(dir);
		return dir;
	}

	test("is clean for Biome (format, lint, organized imports)", async () => {
		const dir = await project();
		await Bun.write(join(dir, "biome.json"), BIOME_CONFIG);
		const result = await run(
			dir,
			BIOME,
			"check",
			`--config-path=${dir}`,
			...["quickstart", "blog", "auth", "journal", "variant"].map((name) =>
				join(dir, name),
			),
		);
		expect(result.output).not.toContain("error");
		expect(result.code).toBe(0);
	});

	test("type-checks", async () => {
		const dir = await project();
		const result = await run(dir, "bunx", "tsc", "--noEmit", "-p", dir);
		expect(result.output).toBe("");
		expect(result.code).toBe(0);
	}, 120_000);

	test("runs: masks the password, stores, finds and loads relations", async () => {
		const dir = await project();
		process.env.DATABASE_URL = "http://localhost/db";
		process.env.PORT = "5432";
		const domain = await import(join(dir, "blog/src/domain/index.ts"));
		const hash = (await Password.hash("Str0ng!Pass")).value;
		const input = {
			name: "Ana",
			email: "ana@example.com",
			slug: "ana",
			password: hash,
			address: { street: "Rua A", zip: "12345-678" },
			tags: ["a"],
		};
		const ana = new domain.User(input);
		expect(ana.toJSON().password).toBe("********");
		expect(JSON.parse(JSON.stringify(ana)).password).toBe("********");

		const created = await domain.Users.create(input);
		const found = await domain.Users.findByEmail("ana@example.com");
		expect(found?.id).toBe(created.id);
		expect(await domain.Users.findBySlug("ana")).toBeDefined();
		expect(
			() => new domain.User({ ...input, address: { street: "x", zip: "bad" } }),
		).toThrow();

		const post = await domain.Posts.create({
			title: "Hello",
			status: "draft",
			author: created,
			coauthors: [],
		});
		const posts = await domain.Posts.findManyByAuthor(created);
		expect(posts.map((p: { id: string }) => p.id)).toEqual([post.id]);
		expect(posts[0].author.email).toBe("ana@example.com");

		const App = domain.App;
		expect(Object.keys(App.entities).sort()).toEqual(["Post", "User"]);
		expect(App.describe().name).toBe("blog");
	});

	test("an extending spec uses the declarations of the one it extends", async () => {
		const dir = await project();
		const journal = await import(join(dir, "journal/src/journal/index.ts"));
		const hash = (await Password.hash("Str0ng!Pass")).value;
		const account = await journal.Accounts.create({
			name: "Bia",
			email: "bia@example.com",
			password: hash,
		});
		expect(account.toJSON().password).toBe("********");
		const entry = await journal.Entries.create({
			title: "Day 1",
			owner: account,
		});
		expect((await journal.Entries.findManyByOwner(account))[0].id).toBe(
			entry.id,
		);
		expect(Object.keys(journal.App.entities).sort()).toEqual([
			"Account",
			"Entry",
		]);
		expect(journal.App.describe().entities.Account.from).toBe("auth");
		expect(journal.App.extends[0].name).toBe("auth");
	});
});

describe("fidelity to hand-written code", () => {
	test("the quick start User has the same OpenAPI schema and options", async () => {
		const dir = await makeProject(fixtures.quickstart);
		projects.push(dir);
		const generated = await import(join(dir, "src/domain/index.ts"));

		const Address = blueprintOf((ctx) => ({
			street: ctx.string,
			zip: ctx.string,
		}));
		class User extends recordOf(
			blueprintOf((ctx) => ({
				email: ctx.email,
				slug: ctx.slug,
				password: ctx.password,
				address: Address,
				tags: listOf(ctx.string, { maxItems: 5 }),
			})),
			{ unique: ["email"], change: ["password"] },
		) {}

		expect(toOpenAPI(generated.User as typeof User)).toEqual(toOpenAPI(User));
		expect(generated.User.options).toEqual(User.options);
		expect(
			Object.keys(
				new generated.User({
					email: "a@b.co",
					slug: "a",
					password: (await Password.hash("Str0ng!Pass")).value,
					address: { street: "s", zip: "z" },
					tags: [],
				}).change,
			),
		).toEqual(
			Object.keys(
				new User({
					email: "a@b.co",
					slug: "a",
					password: (await Password.hash("Str0ng!Pass")).value,
					address: { street: "s", zip: "z" },
					tags: [],
				}).change,
			),
		);
	});

	test("the blog User and Post match a hand-written version", async () => {
		const dir = await makeProject(fixtures.blog);
		projects.push(dir);
		const generated = await import(join(dir, "src/domain/index.ts"));
		const { Integer, enumOf } = await import("@afora/core");
		const Age = Integer.with({ min: 0, max: 150, description: "In years" });
		const Status = enumOf(["draft", "published"]);
		const Address = blueprintOf((ctx) => ({
			street: ctx.string,
			zip: ctx.string({ pattern: /^\d{5}-\d{3}$/ }),
		}));
		class User extends entityOf(
			blueprintOf((ctx) => ({
				name: ctx.text,
				email: ctx.email,
				slug: ctx.slug,
				password: ctx.password,
				age: optionalOf(Age),
				address: Address,
				tags: ctx.list.string,
			})),
			{ unique: ["email"], change: ["name"] },
		) {}
		class Post extends entityOf(
			blueprintOf((ctx) => ({
				title: ctx.text,
				status: Status,
				author: User,
				coauthors: listOf(User),
			})),
		) {}
		expect(toOpenAPI({ User: generated.User, Post: generated.Post })).toEqual(
			toOpenAPI({ User, Post }),
		);
		expect(generated.User.options).toEqual(User.options);
		expect(generated.Post.options).toEqual(Post.options);
	});
});
