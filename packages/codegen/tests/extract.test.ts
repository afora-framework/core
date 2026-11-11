import { afterAll, describe, expect, test } from "bun:test";
import { join, posix } from "node:path";
import {
	applicationOf,
	blueprintOf,
	entityOf,
	enumOf,
	environmentOf,
	Integer,
	inMemoryProvider,
	listOf,
	optionalOf,
	propertyOf,
	recordOf,
	repositoryOf,
	toOpenAPI,
} from "@afora/core";
import { Type } from "typebox";
import {
	extractSpec,
	generate,
	normalizeSpec,
	type ResolvedSpec,
	type Spec,
	validateSpec,
} from "../src";
import {
	authSpec,
	blogSpec,
	extendsContext,
	extendsSpec,
	kitchenSpec,
	quickstartSpec,
} from "./fixtures";
import { makeProject, removeProject } from "./project";
import { variantSpec } from "./roundtrip/fixtures/variant";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

async function generated(
	specs: Record<
		string,
		{ spec: Spec; extended?: Record<string, ResolvedSpec> }
	>,
) {
	const files = Object.entries(specs).flatMap(([dir, { spec, extended }]) =>
		generate(spec, extended).map((file) => ({
			...file,
			path: posix.join(dir, file.path),
		})),
	);
	const dir = await makeProject(files, {}, ["**/*.ts"]);
	projects.push(dir);
	return dir;
}

describe("normalizeSpec", () => {
	test("shorthand and object forms are the same", () => {
		const a: Spec = {
			version: 1,
			blueprints: { B: { fields: { x: "Age[]?", y: "text" } } },
		};
		const b: Spec = {
			version: 1,
			output: { dir: "src/domain" },
			blueprints: {
				B: {
					fields: {
						x: { type: "Age", optional: true, list: true },
						y: { type: "text", optional: false, with: {} },
					},
				},
			},
		};
		expect(normalizeSpec(a)).toEqual(normalizeSpec(b));
		expect(normalizeSpec(a).output?.dir).toBe("src/domain");
	});

	test("drops what a property or plugin already implies", () => {
		const spec: Spec = {
			version: 1,
			entities: {
				A: {
					fields: { slug: "slug", pw: "password", name: "text" },
					unique: ["slug", "name", "id"],
					sensitive: ["pw"],
					plugins: ["authenticatable"],
					change: ["password"],
				},
			},
		};
		expect(normalizeSpec(spec).entities?.A).toEqual({
			fields: {
				slug: { type: "slug" },
				pw: { type: "password" },
				name: { type: "text" },
			},
			unique: ["name"],
			plugins: ["authenticatable"],
		});
	});
});

describe("round trip: spec -> generate -> import -> extractSpec", () => {
	const cases: [string, Spec, Record<string, ResolvedSpec>?][] = [
		["quickstart", quickstartSpec],
		["blog", blogSpec],
		["kitchen sink", kitchenSpec],
		["variant", variantSpec],
	];
	for (const [name, spec] of cases) {
		test(name, async () => {
			expect(validateSpec(spec)).toEqual([]);
			const dir = await generated({ ".": { spec } });
			const domain = await import(
				join(dir, spec.output?.dir ?? "", "index.ts")
			);
			const extracted = extractSpec(domain.App, {
				outputDir: spec.output?.dir,
			});
			expect(validateSpec(extracted)).toEqual([]);
			expect(normalizeSpec(extracted)).toEqual(normalizeSpec(spec));
			// and the extracted spec generates the same code
			expect(generate(extracted)).toEqual(generate(spec));
		});
	}

	test("an extending spec keeps its extends", async () => {
		const dir = await generated({
			auth: { spec: authSpec },
			journal: { spec: extendsSpec, extended: extendsContext },
		});
		const journal = await import(join(dir, "journal/src/journal/index.ts"));
		const extracted = extractSpec(journal.App, {
			outputDir: "src/journal",
			extends: { auth: "../auth/afora.json" },
		});
		expect(extracted.extends).toEqual(["../auth/afora.json"]);
		expect(Object.keys(extracted.entities ?? {})).toEqual(["Entry"]);
		expect(validateSpec(extracted, extendsContext)).toEqual([]);
		expect(normalizeSpec(extracted, extendsContext)).toEqual(
			normalizeSpec(extendsSpec, extendsContext),
		);
		const app = await import(join(dir, "auth/src/auth/index.ts"));
		expect(
			normalizeSpec(extractSpec(app.App, { outputDir: "src/auth" })),
		).toEqual(normalizeSpec(authSpec));
	});

	test("metadata names round trip as ordinary record and entity fields", async () => {
		const spec: Spec = {
			version: 1,
			name: "MetadataFields",
			output: { dir: "src/domain" },
			records: {
				Details: {
					fields: { blueprint: "string", options: "string" },
					sensitive: ["options"],
				},
			},
			entities: {
				Item: {
					fields: { blueprint: "string", options: "Details" },
					change: ["blueprint"],
				},
			},
			repositories: {
				Items: { entity: "Item", actions: ["create", "findById"] },
			},
		};
		expect(validateSpec(spec)).toEqual([]);
		const dir = await generated({ ".": { spec } });
		const { App } = await import(join(dir, "src/domain/index.ts"));
		const item = await App.repositories.Items.create({
			blueprint: "draft",
			options: { blueprint: "nested", options: "secret" },
		});
		expect(
			(await App.repositories.Items.findById(item.id)).toJSON(),
		).toMatchObject({
			blueprint: "draft",
			options: { blueprint: "nested", options: "********" },
		});
		expect(normalizeSpec(extractSpec(App))).toEqual(normalizeSpec(spec));
	});

	test("a versioned entity and increment round trip", async () => {
		const spec: Spec = {
			version: 1,
			name: "Counting",
			output: { dir: "src/domain" },
			entities: {
				Counter: {
					fields: { name: "text", views: "integer" },
					change: ["views"],
					versioned: true,
				},
			},
			repositories: {
				Counters: {
					entity: "Counter",
					actions: ["create", "increment", "update", "findById"],
				},
			},
		};
		expect(validateSpec(spec)).toEqual([]);
		expect(
			generate(spec).find((file) => file.path.endsWith("entities.ts"))
				?.contents,
		).toContain("versioned: true");
		const dir = await generated({ ".": { spec } });
		const { App } = await import(join(dir, "src/domain/index.ts"));
		const counter = await App.repositories.Counters.create({
			name: "a",
			views: 0,
		});
		const next = await App.repositories.Counters.increment(counter.id, {
			views: 2,
		});
		expect([next.views, next.version]).toEqual([2, 2]);
		const extracted = extractSpec(App);
		expect(extracted.entities?.Counter?.versioned).toBe(true);
		expect(normalizeSpec(extracted)).toEqual(normalizeSpec(spec));
	});

	test("the shorthand is used where it says the same", async () => {
		const dir = await generated({ ".": { spec: blogSpec } });
		const domain = await import(join(dir, "src/domain/index.ts"));
		const extracted = extractSpec(domain.App);
		expect(extracted.entities?.User?.fields).toEqual({
			name: "text",
			email: "email",
			slug: "slug",
			password: "password",
			age: "Age?",
			address: "Address",
			tags: "string[]",
		});
		expect(extracted.properties?.Age).toEqual({
			base: "integer",
			with: { min: 0, max: 150, description: "In years" },
		});
	});
});

describe("hand-written application -> extractSpec -> generate", () => {
	test("gives the same OpenAPI schemas", async () => {
		const Age = Integer.with({ min: 0, max: 150 });
		const Status = enumOf(["draft", "published"]);
		const Address = blueprintOf((ctx) => ({
			street: ctx.string,
			zip: ctx.string({ pattern: /^\d{5}$/ }),
		}));
		class User extends entityOf(
			blueprintOf((ctx) => ({
				name: ctx.text,
				email: ctx.email,
				password: ctx.password,
				age: optionalOf(Age),
				address: Address,
				tags: listOf(ctx.string, { maxItems: 3 }),
			})),
			{ unique: ["email"], change: ["name"] },
		) {}
		class Post extends entityOf(
			blueprintOf((ctx) => ({
				title: ctx.text,
				status: Status,
				author: User,
				coauthors: ctx.list.optional.string,
			})),
		) {}
		class Tag extends recordOf(blueprintOf((ctx) => ({ label: ctx.string }))) {}
		const Database = environmentOf(
			blueprintOf((ctx) => ({ DATABASE_URL: ctx.url, PORT: ctx.integer })),
		);
		const Users = repositoryOf({
			entity: User,
			actions: ["findById", "findByEmail", "create"],
			environmentDependencies: Database,
		});
		const Posts = repositoryOf({
			entity: Post,
			actions: ["findById", "findManyByAuthor", "create"],
			relations: [Users],
		});
		const App = applicationOf({
			name: "hand",
			properties: { Age, Status },
			blueprints: { Address },
			records: { Tag },
			entities: { User, Post },
			environments: { Database },
			repositories: { Users, Posts },
			provider: inMemoryProvider(),
		});

		const spec = extractSpec(App);
		expect(validateSpec(spec)).toEqual([]);
		expect(spec.entities?.User?.fields?.age).toBe("Age?");
		const dir = await generated({ ".": { spec } });
		const domain = await import(join(dir, "src/domain/index.ts"));
		expect(
			toOpenAPI({ User: domain.User, Post: domain.Post, Tag: domain.Tag }),
		).toEqual(toOpenAPI({ User, Post, Tag }));
		expect(domain.User.options).toEqual(User.options);
		expect(domain.Posts.actions).toEqual(Posts.actions);
	});

	test("a property with custom handlers becomes an opaque import", () => {
		const Shout = propertyOf({
			name: "shout",
			schema: Type.String(),
			preHandle: (value: string) => value.toUpperCase(),
		});
		class Note extends recordOf(
			blueprintOf((ctx) => ({ body: Shout, title: ctx.text })),
		) {}
		const App = applicationOf({ name: "notes", records: { Note } });
		const spec = extractSpec(App, { imports: { shout: "./shout" } });
		expect(spec.properties).toEqual({
			Shout: { opaque: true, ref: "Shout", import: "./shout" },
		});
		expect(spec.records?.Note?.fields).toEqual({
			body: "Shout",
			title: "text",
		});
		expect(validateSpec(spec)).toEqual([]);
		const properties = generate(spec).find((file) =>
			file.path.endsWith("properties.ts"),
		);
		expect(properties?.contents).toContain('import { Shout } from "./shout";');
	});
});
