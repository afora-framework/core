import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	blueprintOf,
	commandOf,
	entityOf,
	type RepositoryContext,
	repositoryOf,
	type SchemaChange,
	type SchemaPlan,
	useCaseOf,
} from "@afora/core";
import { providerContract } from "@afora/core/testing";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzleProvider, providers } from "./index";

/** Tables for the contract kit: its entity has more keys than its blueprint. */
const accountTable = (name: string) =>
	sqliteTable(name, {
		id: text("id").primaryKey(),
		email: text("email").unique(),
		name: text("name"),
		age: integer("age"),
		active: integer("active", { mode: "boolean" }),
		address: text("address", { mode: "json" }),
		tags: text("tags", { mode: "json" }),
		group: integer("group"),
		n: integer("n"),
		visits: integer("visits"),
		version: integer("version"),
		deletedAt: text("deletedAt"),
		expiresAt: text("expiresAt"),
		schemaVersion: integer("schema_version"),
	});

function contractDatabase() {
	const sqlite = new Database(":memory:");
	const tables = {
		Accounts: accountTable("accounts"),
		One: accountTable("one"),
		Two: accountTable("two"),
	};
	for (const table of ["accounts", "one", "two"]) {
		sqlite.run(
			`CREATE TABLE ${table} (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, age INTEGER, active INTEGER, address TEXT, tags TEXT, "group" INTEGER, n INTEGER, visits INTEGER, version INTEGER, deletedAt TEXT, expiresAt TEXT, schema_version INTEGER)`,
		);
	}
	return { db: drizzle(sqlite), tables };
}

// It takes the declared index and leaves the plan to the database.
providerContract(
	{ describe, it, expect },
	() => drizzleProvider(contractDatabase()),
	{ indexes: true },
);

describe("catalog", () => {
	it("names the factory for codegen", () => {
		expect(providers).toEqual([
			{ name: "drizzle", module: "@afora/drizzle", export: "drizzleProvider" },
		]);
	});
});

// Repository level, over entities.
const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	createdAt: text("createdAt").notNull(),
	updatedAt: text("updatedAt"),
	deletedAt: text("deletedAt"),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	profile: text("profile", { mode: "json" }),
});
const posts = sqliteTable("posts", {
	id: text("id").primaryKey(),
	createdAt: text("createdAt").notNull(),
	updatedAt: text("updatedAt"),
	deletedAt: text("deletedAt"),
	title: text("title").notNull(),
	author: text("author").notNull(),
});

const DDL = [
	`CREATE TABLE users (id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, updatedAt TEXT, deletedAt TEXT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, profile TEXT)`,
	`CREATE TABLE posts (id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, updatedAt TEXT, deletedAt TEXT, title TEXT NOT NULL, author TEXT NOT NULL)`,
];

function world() {
	const sqlite = new Database(":memory:");
	for (const statement of DDL) sqlite.run(statement);
	const provider = drizzleProvider({
		db: drizzle(sqlite),
		tables: { User: users, Post: posts },
	});
	class User extends entityOf(
		blueprintOf((ctx) => ({
			name: ctx.string,
			email: ctx.email,
			profile: ctx.optionalOf(blueprintOf((c) => ({ bio: c.string }))),
		})),
		{ unique: ["email"] },
	) {}
	return { provider, User };
}

describe("repositoryOf", () => {
	it("checks versions and increments atomically", async () => {
		const sqlite = new Database(":memory:");
		sqlite.run(
			`CREATE TABLE pages (id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, updatedAt TEXT, deletedAt TEXT, version INTEGER NOT NULL, title TEXT NOT NULL, views INTEGER NOT NULL)`,
		);
		const pages = sqliteTable("pages", {
			id: text("id").primaryKey(),
			createdAt: text("createdAt").notNull(),
			updatedAt: text("updatedAt"),
			deletedAt: text("deletedAt"),
			version: integer("version").notNull(),
			title: text("title").notNull(),
			views: integer("views").notNull(),
		});
		class Page extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string, views: ctx.integer })),
			{ name: "Page", change: ["title", "views"], versioned: true },
		) {}
		const Pages = repositoryOf({
			entity: Page,
			provider: drizzleProvider({
				db: drizzle(sqlite),
				tables: { Page: pages },
			}),
			actions: ["create", "update", "increment", "findById"],
		});
		const page = await Pages.create({ title: "a", views: 0 });
		const stale = (await Pages.findById(page.id)) as Page;
		const counted = await Pages.increment(page.id, { views: 2 });
		expect([counted.views, counted.version]).toEqual([2, 2]);
		expect(counted.updatedAt).toBeDefined();
		await expect(Pages.update(stale.change.title("b"))).rejects.toMatchObject({
			name: "RepositoryConcurrencyConflict",
			details: { id: page.id, expected: 1, actual: 2 },
		});
		const saved = await Pages.update(counted.change.title("b"));
		expect(saved.version).toBe(3);
		const id = "01a173d2-051c-77bb-8166-a371e999573e";
		const created = await Pages.increment(
			id,
			{ views: 1 },
			{ create: { title: "new" } },
		);
		expect([created.views, created.version]).toEqual([1, 1]);
		const again = await Pages.increment(
			id,
			{ views: 1 },
			{ create: { title: "new" } },
		);
		expect([again.views, again.version]).toEqual([2, 2]);
	});

	it("finds the table by the declared name of a renamed class", async () => {
		const sqlite = new Database(":memory:");
		for (const statement of DDL) sqlite.run(statement);
		const provider = drizzleProvider({
			db: drizzle(sqlite),
			tables: { Post: posts },
		});
		const fields = blueprintOf((ctx) => ({
			title: ctx.string,
			author: ctx.string,
		}));
		// What a minifier does to the class: it gets another name.
		const rename = <Class extends object>(Class: Class): Class =>
			Object.defineProperty(Class, "name", { value: "a" });
		const Post = rename(
			class Post extends entityOf(fields, { name: "Post" }) {},
		);
		const Posts = repositoryOf({
			entity: Post,
			provider,
			actions: ["create", "count"],
		});
		await Posts.create(new Post({ title: "Hello", author: "ana" }));
		expect(await Posts.count()).toBe(1);

		const Unnamed = rename(class Post extends entityOf(fields) {});
		const Lost = repositoryOf({
			entity: Unnamed,
			provider,
			actions: ["count"],
		});
		await expect(Lost.count()).rejects.toMatchObject({
			name: "InvalidRepositoryDeclaration",
		});
	});

	it("pages by cursor over the database", async () => {
		const { provider, User } = world();
		const Users = repositoryOf({
			entity: User,
			provider,
			actions: ["create", "findCursor"],
		});
		const people = ["Caio", "Ana", "Érico", "Bia", "Davi"];
		for (const [index, name] of people.entries()) {
			await Users.create(new User({ name, email: `p${index}@example.com` }));
		}
		const names: string[][] = [];
		let after: string | undefined;
		do {
			const page = await Users.findCursor({
				orderBy: [{ key: "name", direction: "desc" }],
				limit: 2,
				after,
			});
			names.push(page.items.map((user) => user.name));
			after = page.next;
		} while (after !== undefined);
		expect(names).toEqual([["Érico", "Davi"], ["Caio", "Bia"], ["Ana"]]);
	});

	it("creates, finds, updates, pages and removes", async () => {
		const { provider, User } = world();
		const Users = repositoryOf({
			entity: User,
			provider,
			actions: [
				"create",
				"findById",
				"findByEmail",
				"update",
				"delete",
				"findPage",
				"count",
			],
		});
		const ana = await Users.create(
			new User({
				name: "Ana",
				email: "ana@example.com",
				profile: { bio: "hi" },
			}),
		);
		await Users.create(new User({ name: "Bia", email: "bia@example.com" }));
		expect((await Users.findById(ana.id))?.profile?.bio).toBe("hi");
		expect((await Users.findByEmail("bia@example.com"))?.name).toBe("Bia");
		const page = await Users.findPage({ orderBy: [{ key: "name" }], limit: 1 });
		expect(page.total).toBe(2);
		expect(page.items.map((u) => u.name)).toEqual(["Ana"]);
		await expect(
			Users.create(new User({ name: "Dup", email: "ana@example.com" })),
		).rejects.toMatchObject({ name: "RepositoryUniqueViolation" });
		await Users.delete(ana);
		expect(await Users.count()).toBe(1);
	});

	it("soft deletes keep the row and hide it", async () => {
		const { provider, User } = world();
		const Users = repositoryOf({
			entity: User,
			provider,
			deletion: "soft",
			actions: ["create", "findById", "delete", "count", "findMany"],
		});
		const ana = await Users.create(
			new User({ name: "Ana", email: "ana@example.com" }),
		);
		await Users.delete(ana);
		expect(await Users.count()).toBe(0);
		expect(await Users.findById(ana.id)).toBe(undefined);
		expect(await Users.findMany({ withDeleted: true })).toHaveLength(1);
		await expect(
			Users.create(new User({ name: "Ana2", email: "ana@example.com" })),
		).rejects.toMatchObject({ name: "RepositoryUniqueViolation" });
	});

	it("loads nested entities through relations", async () => {
		const sqlite = new Database(":memory:");
		for (const statement of DDL) sqlite.run(statement);
		const provider = drizzleProvider({
			db: drizzle(sqlite),
			tables: { Author: users, Article: posts },
		});
		class Author extends entityOf(
			blueprintOf((ctx) => ({ name: ctx.string, email: ctx.email })),
		) {}
		const Authors = repositoryOf({
			entity: Author,
			provider,
			actions: ["create", "findById"],
		});
		class Article extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string, author: Author })),
		) {}
		const Articles = repositoryOf({
			entity: Article,
			provider,
			actions: ["create", "findById", "findMany"],
			relations: [Authors],
		});
		const ana = await Authors.create(
			new Author({ name: "Ana", email: "ana@example.com" }),
		);
		const article = await Articles.create(
			new Article({ title: "Hi", author: ana }),
		);
		const found = await Articles.findById(article.id);
		expect(found?.author.name).toBe("Ana");
		expect((await Articles.findMany({ where: { author: ana } })).length).toBe(
			1,
		);
	});

	it("a command with transaction: true rolls the writes back", async () => {
		const { provider, User } = world();
		const Users = repositoryOf({
			entity: User,
			provider,
			actions: ["create", "count"],
		});
		const Name = blueprintOf((ctx) => ({ name: ctx.string, email: ctx.email }));
		class Register extends useCaseOf({
			name: "Register",
			blueprint: Name,
			response: blueprintOf((ctx) => ({ total: ctx.integer })),
			dependencies: { users: Users },
		}) {
			override async execute({ users = this.dependencies.users } = {}) {
				await users.create(new User(this.input));
				if (this.input.name === "Fail") throw new Error("boom");
				return { total: await users.count() };
			}
		}
		const Commands = commandOf({
			name: "Commands",
			transaction: true,
			useCases: { register: Register },
		});
		expect(
			await Commands.run("register", { name: "Ana", email: "ana@example.com" }),
		).toEqual({ total: 1 });
		await expect(
			Commands.run("register", { name: "Fail", email: "fail@example.com" }),
		).rejects.toBeDefined();
		expect(await Users.count()).toBe(1);
	});
});

describe("migrate", () => {
	const change = (
		fields: Pick<SchemaChange, "change"> & Partial<SchemaChange>,
	): SchemaChange => ({
		entity: "Note",
		class: "automatic",
		satisfied: true,
		destructive: false,
		...fields,
	});
	const plan = (destructive = false): SchemaPlan => ({
		entity: "Note",
		destructive,
		changes: [
			change({
				key: "title",
				change: "renamed",
				from: "name",
				class: "declared",
			}),
			change({ key: "locale", change: "added-required", class: "declared" }),
			change({ key: "tags", change: "added-optional" }),
			change({ key: "slug", change: "unique-added", class: "check" }),
			change({ key: "legacy", change: "removed", destructive: true }),
			change({ key: "body", change: "type-changed", class: "declared" }),
			change({ key: "meta.color", change: "added-optional" }),
		],
	});
	const notes = sqliteTable("notes", {
		id: text("id").primaryKey(),
		title: text("title"),
		body: text("body"),
		slug: text("slug"),
		locale: text("locale").notNull().default("pt"),
		tags: text("tags", { mode: "json" }),
		schemaVersion: integer("schema_version"),
	});
	class Note extends entityOf(
		blueprintOf((ctx) => ({ title: ctx.string, body: ctx.string })),
		{ name: "Note" },
	) {}
	const context = {
		entity: Note,
		name: "NoteRepository",
		unique: ["id"],
		env: {},
		schema: { version: 2, key: "$v", previousNames: [] },
	} as unknown as RepositoryContext;
	const notesDatabase = () => {
		const sqlite = new Database(":memory:");
		sqlite.run(
			`CREATE TABLE notes (id TEXT PRIMARY KEY, name TEXT, body TEXT, slug TEXT, legacy TEXT)`,
		);
		sqlite.run(
			`INSERT INTO notes (id, name, body, slug, legacy) VALUES ('n1', 'Old', 'b', 's', 'x')`,
		);
		return sqlite;
	};
	const columnsOf = (sqlite: Database) =>
		(sqlite.query("PRAGMA table_info(notes)").all() as { name: string }[]).map(
			(column) => column.name,
		);

	it("is absent without migrations", () => {
		const provider = drizzleProvider({
			db: drizzle(new Database(":memory:")),
			tables: { Note: notes },
		});
		expect(provider.migrate).toBeUndefined();
		expect(() =>
			drizzleProvider({
				db: drizzle(new Database(":memory:")),
				tables: {},
				migrations: "later" as never,
			}),
		).toThrow();
	});

	it("applies the structural changes, destructive ones only when asked", async () => {
		const sqlite = notesDatabase();
		const provider = drizzleProvider({
			db: drizzle(sqlite),
			tables: { Note: notes },
			migrations: "apply",
		});
		await provider.migrate?.(context, plan());
		expect(columnsOf(sqlite)).toEqual([
			"id",
			"title",
			"body",
			"slug",
			"legacy",
			"locale",
			"tags",
			"schema_version",
		]);
		// The rows already stored keep their values, and get the default.
		expect(sqlite.query("SELECT title, locale FROM notes").all()).toEqual([
			{ title: "Old", locale: "pt" },
		]);
		const indexes = sqlite.query("PRAGMA index_list(notes)").all() as {
			name: string;
			unique: number;
		}[];
		expect(
			indexes.some(
				(index) => index.name === "notes_slug_unique" && index.unique,
			),
		).toBe(true);

		// Applied already: nothing to do.
		await provider.migrate?.(context, plan());
		expect(columnsOf(sqlite)).toContain("legacy");

		await provider.migrate?.(context, plan(true));
		expect(columnsOf(sqlite)).not.toContain("legacy");
	});

	it("maps the schema version key to its column", async () => {
		const sqlite = notesDatabase();
		const provider = drizzleProvider({
			db: drizzle(sqlite),
			tables: { Note: notes },
			migrations: "apply",
		});
		await provider.migrate?.(context, plan(true));
		const data = { id: "n2", title: "T", body: "b", locale: "en", $v: 2 };
		await provider.insert(context, data);
		expect(
			sqlite.query("SELECT schema_version FROM notes WHERE id = 'n2'").get(),
		).toEqual({ schema_version: 2 });
		expect(await provider.findOne(context, { where: { id: "n2" } })).toEqual(
			data,
		);
		// A row written before has no version: version 1 for the core.
		expect(await provider.findOne(context, { where: { id: "n1" } })).toEqual({
			id: "n1",
			title: "Old",
			body: "b",
			slug: "s",
			locale: "pt",
		});
		expect(
			(await provider.findMany(context, { where: { $v: 2 } })).map(
				(row) => row.id,
			),
		).toEqual(["n2"]);
		await provider.update(context, { ...data, $v: 3 });
		expect((await provider.findOne(context, { where: { id: "n2" } }))?.$v).toBe(
			3,
		);
	});

	it("a schema version needs its column; an added key, its Drizzle column", async () => {
		const bare = sqliteTable("notes", {
			id: text("id").primaryKey(),
			title: text("name"),
		});
		const provider = drizzleProvider({
			db: drizzle(notesDatabase()),
			tables: { Note: bare },
			migrations: "apply",
		});
		const missing = await provider
			.migrate?.(context, { entity: "Note", destructive: false, changes: [] })
			.catch((error: Error) => error);
		expect((missing as Error).message).toContain("schema_version");
		const unknown = await provider
			.migrate?.({ ...context, schema: undefined } as RepositoryContext, {
				entity: "Note",
				destructive: false,
				changes: [change({ key: "locale", change: "added-optional" })],
			})
			.catch((error: Error) => error);
		expect((unknown as Error).message).toContain('"locale"');
		const write = await provider
			.insert(context, { id: "n3", title: "T", $v: 2 })
			.catch((error: Error) => error);
		expect((write as Error).message).toContain("schema_version");
	});

	it("writes a drizzle-kit migration file instead, one per provider", async () => {
		const sqlite = notesDatabase();
		const file = join(
			await mkdtemp(join(tmpdir(), "afora-drizzle-")),
			"drizzle",
			"0001_afora.sql",
		);
		const provider = drizzleProvider({
			db: drizzle(sqlite),
			tables: { Note: notes },
			migrations: { file },
		});
		await provider.migrate?.(context, plan());
		// The database is left as it was.
		expect(columnsOf(sqlite)).toEqual(["id", "name", "body", "slug", "legacy"]);
		const written = await readFile(file, "utf8");
		const parts = written.split("--> statement-breakpoint\n");
		expect(parts.map((part) => part.trim().split("\n").at(-1))).toEqual([
			'ALTER TABLE "notes" RENAME COLUMN "name" TO "title";',
			'ALTER TABLE "notes" ADD COLUMN "locale" text NOT NULL DEFAULT \'pt\';',
			'ALTER TABLE "notes" ADD COLUMN "tags" text;',
			'CREATE UNIQUE INDEX IF NOT EXISTS "notes_slug_unique" ON "notes" ("slug");',
			'ALTER TABLE "notes" ADD COLUMN "schema_version" integer;',
		]);
		expect(written).toContain(
			'-- Note: removed "legacy" (destructive) is left to',
		);
		// The file runs as it is.
		for (const statement of parts) sqlite.run(statement);
		expect(columnsOf(sqlite)).toContain("schema_version");

		// The next plan of the same provider adds to the file.
		await provider.migrate?.(
			{ ...context, schema: undefined } as RepositoryContext,
			{
				entity: "Note",
				destructive: true,
				changes: [
					change({ key: "legacy", change: "removed", destructive: true }),
				],
			},
		);
		expect(await readFile(file, "utf8")).toEndWith(
			'--> statement-breakpoint\nALTER TABLE "notes" DROP COLUMN "legacy";\n',
		);
	});
});
