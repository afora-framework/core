import { afterAll, describe, expect, test } from "bun:test";
import { join, posix } from "node:path";
import {
	applicationOf,
	blueprintOf,
	entityOf,
	enumOf,
	environmentOf,
	fileOf,
	Integer,
	idOf,
	inMemoryProvider,
	Key,
	listOf,
	optionalOf,
	propertyOf,
	recordOf,
	repositoryOf,
	Serial,
	SerialKey,
	TextKey,
	toOpenAPI,
	Uuid,
	UuidKey,
} from "@afora/core";
import { Type } from "typebox";
import {
	ExtractionError,
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

	test("the id strategies of entities round trip", async () => {
		const spec: Spec = {
			version: 1,
			name: "Ids",
			output: { dir: "src/domain" },
			entities: {
				Setting: { fields: { value: "text" }, id: "key" },
				Legacy: { fields: { name: "text" }, id: "uuid" },
				Plain: { fields: { name: "text" }, id: "uuid7" },
				Ticket: { fields: { title: "text" }, id: "serial" },
			},
			repositories: {
				Settings: { entity: "Setting", actions: ["create", "findById"] },
				Legacies: { entity: "Legacy", actions: ["create", "findById"] },
				Tickets: { entity: "Ticket", actions: ["create", "findById"] },
			},
		};
		expect(validateSpec(spec)).toEqual([]);
		const code = generate(spec).find((file) =>
			file.path.endsWith("entities.ts"),
		)?.contents;
		expect(code).toContain("id: Key");
		expect(code).toContain("id: Uuid");
		expect(code).toContain("id: Serial");
		const dir = await generated({ ".": { spec } });
		const { App } = await import(join(dir, "src/domain/index.ts"));
		const setting = await App.repositories.Settings.create({
			id: "seo",
			value: "on",
		});
		expect((await App.repositories.Settings.findById("seo")).id).toBe(
			setting.id,
		);
		const v4 = "6f1c2b9e-3d4a-4e8b-9f2a-1c3b5d7e9f0a";
		await App.repositories.Legacies.create({ id: v4, name: "old" });
		expect((await App.repositories.Legacies.findById(v4)).name).toBe("old");
		const ticket = await App.repositories.Tickets.create({ title: "First" });
		expect(ticket.id).toBe(1);
		expect((await App.repositories.Tickets.findById(1)).title).toBe("First");
		const extracted = extractSpec(App);
		expect(extracted.entities?.Setting?.id).toBe("key");
		expect(extracted.entities?.Legacy?.id).toBe("uuid");
		expect(extracted.entities?.Ticket?.id).toBe("serial");
		expect(extracted.entities?.Plain?.id).toBeUndefined();
		expect(normalizeSpec(extracted)).toEqual(normalizeSpec(spec));
	});

	test("a custom idOf cannot be extracted, even on the property of Key or Uuid", () => {
		const Named = blueprintOf((ctx) => ({ name: ctx.string }));
		const extract = (id: unknown) =>
			extractSpec(
				applicationOf({
					name: "Ids",
					entities: { Thing: entityOf(Named, { id: id as typeof Key }) },
				}),
			);
		expect(extract(Key).entities?.Thing?.id).toBe("key");
		expect(extract(Uuid).entities?.Thing?.id).toBe("uuid");
		expect(extract(Serial).entities?.Thing?.id).toBe("serial");
		for (const custom of [
			idOf(SerialKey),
			idOf(TextKey),
			idOf(UuidKey, () => crypto.randomUUID()),
			idOf(Integer, () => 1),
		]) {
			expect(() => extract(custom)).toThrow(ExtractionError);
		}
	});

	test("an id other than uuid7, uuid, key or serial is invalid", () => {
		const spec = {
			version: 1,
			name: "Ids",
			entities: { Ticket: { fields: { title: "text" }, id: "increment" } },
		} as unknown as Spec;
		expect(validateSpec(spec).map((issue) => issue.path)).toContainEqual([
			"entities",
			"Ticket",
			"id",
		]);
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
	test("keeps file fields and file properties (fileOf)", async () => {
		const Avatar = fileOf({ types: ["image/png", "image/*"], maxBytes: 1000 });
		const Upload = blueprintOf((ctx) => ({
			avatar: Avatar,
			any: ctx.file,
			cover: ctx.fileOf({ maxBytes: 10 }),
			extras: ctx.optionalOf(ctx.listOf(ctx.fileOf({ types: ["text/plain"] }))),
		}));
		const App = applicationOf({
			name: "files",
			properties: { Avatar },
			blueprints: { Upload },
			provider: inMemoryProvider(),
		});
		const spec = extractSpec(App);
		expect(validateSpec(spec)).toEqual([]);
		expect(spec.properties?.Avatar).toEqual({
			file: { types: ["image/png", "image/*"], maxBytes: 1000 },
		});
		expect(spec.blueprints?.Upload?.fields).toEqual({
			avatar: "Avatar",
			any: "file",
			cover: { file: { maxBytes: 10 } },
			extras: { file: { types: ["text/plain"] }, optional: true, list: true },
		});
		const dir = await generated({ ".": { spec } });
		const domain = await import(join(dir, "src/domain/index.ts"));
		expect(toOpenAPI(domain.Upload)).toEqual(toOpenAPI(Upload));
	});

	test("rejects file options that are not media types or a size", () => {
		const issues = validateSpec({
			version: 1,
			blueprints: {
				Upload: {
					fields: {
						a: { file: { types: ["png"] } },
						b: { file: { maxBytes: -1 } },
						c: { file: { other: 1 } },
					},
				},
			},
		} as unknown as Spec);
		expect(issues.map((found) => [found.path.join("."), found.code])).toEqual([
			["blueprints.Upload.fields.a.file.types", "invalid_file"],
			["blueprints.Upload.fields.b.file.maxBytes", "invalid_file"],
			["blueprints.Upload.fields.c.file.other", "unknown_key"],
		]);
	});

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
