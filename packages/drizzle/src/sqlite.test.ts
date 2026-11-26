import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	entityOf,
	repositoryOf,
	Serial,
	useCaseOf,
} from "@afora/core";
import {
	type RepositoryContext,
	type SchemaChange,
	type SchemaPlan,
	schemaLockOf,
} from "@afora/core/adapters";
import { providerContract } from "@afora/core/testing";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	getTableConfig,
	integer,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import {
	type DrizzleProvider,
	drizzleCatalogOf,
	drizzleProvider,
	drizzleTableOf,
	providers,
} from "./index";

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
		Serials: sqliteTable("serials", {
			id: integer("id").primaryKey({ autoIncrement: true }),
			email: text("email").unique(),
			name: text("name"),
		}),
	};
	for (const table of ["accounts", "one", "two"]) {
		sqlite.run(
			`CREATE TABLE ${table} (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, age INTEGER, active INTEGER, address TEXT, tags TEXT, "group" INTEGER, n INTEGER, visits INTEGER, version INTEGER, deletedAt TEXT, expiresAt TEXT, schema_version INTEGER)`,
		);
	}
	sqlite.run(
		"CREATE TABLE serials (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, name TEXT)",
	);
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

	it("names the factory of the tables for one dialect or both", () => {
		expect(drizzleCatalogOf({ dialect: "sqlite" })).toEqual([
			{
				name: "drizzle",
				module: "@afora/drizzle",
				export: "drizzleProvider",
				tables: { export: "drizzleTableOf", dialect: "sqlite" },
			},
		]);
		expect(
			drizzleCatalogOf({ dialect: ["sqlite", "postgres"] })[0].tables.dialect,
		).toEqual(["sqlite", "postgres"]);
		expect(() => drizzleCatalogOf({ dialect: "mysql" as never })).toThrow();
		expect(() => drizzleCatalogOf({ dialect: [] })).toThrow();
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

	it("stores Serial entities with the ids the database assigns", async () => {
		const sqlite = new Database(":memory:");
		sqlite.run(
			"CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, createdAt TEXT NOT NULL, updatedAt TEXT, deletedAt TEXT, title TEXT NOT NULL)",
		);
		const tickets = sqliteTable("tickets", {
			id: integer("id").primaryKey({ autoIncrement: true }),
			createdAt: text("createdAt").notNull(),
			updatedAt: text("updatedAt"),
			deletedAt: text("deletedAt"),
			title: text("title").notNull(),
		});
		class Ticket extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string })),
			{ id: Serial, change: ["title"] },
		) {}
		const Tickets = repositoryOf({
			entity: Ticket,
			provider: drizzleProvider({
				db: drizzle(sqlite),
				tables: { Ticket: tickets },
			}),
			actions: ["create", "findById", "update", "delete", "findCursor"],
		});
		const made: number[] = [];
		for (let index = 1; index <= 11; index++) {
			made.push((await Tickets.create({ title: `T${index}` })).id);
		}
		expect(made).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
		const found = await Tickets.findById(2);
		expect(found?.title).toBe("T2");
		await Tickets.update((found as Ticket).change.title("Two"));
		expect((await Tickets.findById(2))?.title).toBe("Two");
		await Tickets.delete(11);
		// AUTOINCREMENT never gives an id twice.
		expect((await Tickets.create({ title: "T12" })).id).toBe(12);
		const pages: number[][] = [];
		let after: string | undefined;
		do {
			const page = await Tickets.findCursor({ limit: 4, after });
			pages.push(page.items.map((ticket) => ticket.id));
			after = page.next;
		} while (after !== undefined);
		expect(pages).toEqual([
			[1, 2, 3, 4],
			[5, 6, 7, 8],
			[9, 10, 12],
		]);
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

describe("SEC-20: findBy<Key> and findManyBy<Key> with a missing value", () => {
	function members() {
		const sqlite = new Database(":memory:");
		sqlite.run(
			"CREATE TABLE members (id TEXT PRIMARY KEY, createdAt TEXT, updatedAt TEXT, deletedAt TEXT, name TEXT, code TEXT UNIQUE, team TEXT)",
		);
		const table = sqliteTable("members", {
			id: text("id").primaryKey(),
			createdAt: text("createdAt"),
			updatedAt: text("updatedAt"),
			deletedAt: text("deletedAt"),
			name: text("name"),
			code: text("code"),
			team: text("team"),
		});
		class Member extends entityOf(
			blueprintOf((ctx) => ({
				name: ctx.string,
				code: ctx.optional.string,
				team: ctx.optional.string,
			})),
			{ name: "Member", unique: ["code"] },
		) {}
		return repositoryOf({
			entity: Member,
			provider: drizzleProvider({
				db: drizzle(sqlite),
				tables: { Member: table },
			}),
			actions: ["create", "findByCode", "findManyByTeam"],
		});
	}

	it("SEC-20: a missing value matches no row, a stored null included", async () => {
		const Members = members();
		await Members.create({ name: "Ana" });
		await Members.create({ name: "Bia", code: "code-bia", team: "core" });
		expect(await Members.findByCode(undefined as never)).toBeUndefined();
		expect(await Members.findByCode(null as never)).toBeUndefined();
		expect(await Members.findManyByTeam(undefined as never)).toEqual([]);
		expect(await Members.findManyByTeam(null as never)).toEqual([]);
		expect((await Members.findByCode("code-bia"))?.name).toBe("Bia");
	});

	it("SEC-21: an { in } object is not read as a membership", async () => {
		const Members = members();
		await Members.create({ name: "Bia", code: "code-bia", team: "core" });
		await expect(
			Members.findByCode({ in: ["code-bia"] } as never),
		).rejects.toMatchObject({ name: "InvalidRepositoryQuery" });
		await expect(
			Members.findManyByTeam({ in: ["core"] } as never),
		).rejects.toMatchObject({ name: "InvalidRepositoryQuery" });
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

	it("returns nothing in apply mode, { deferred: true } in file mode", async () => {
		const apply = drizzleProvider({
			db: drizzle(notesDatabase()),
			tables: { Note: notes },
			migrations: "apply",
		});
		expect(await apply.migrate?.(context, plan())).toBeUndefined();
		const file = join(
			await mkdtemp(join(tmpdir(), "afora-drizzle-")),
			"0001_afora.sql",
		);
		const written = drizzleProvider({
			db: drizzle(notesDatabase()),
			tables: { Note: notes },
			migrations: { file },
		});
		expect((await written.migrate?.(context, plan())) as unknown).toEqual({
			deferred: true,
		});
		// Nothing to write (the file was applied): the backfill can run.
		expect(
			await written.migrate?.(
				{ ...context, schema: undefined } as RepositoryContext,
				{ entity: "Other", destructive: false, changes: [] },
			),
		).toBeUndefined();
	});

	describe("a renamed key whose column has another SQL name", () => {
		const people = sqliteTable("people", {
			id: text("id").primaryKey(),
			displayName: text("display_name"),
		});
		const rename: SchemaPlan = {
			entity: "Note",
			destructive: false,
			changes: [
				change({
					key: "displayName",
					change: "renamed",
					from: "fullName",
					class: "declared",
				}),
			],
		};
		const bare = { ...context, schema: undefined } as RepositoryContext;
		const peopleDatabase = (column: string) => {
			const sqlite = new Database(":memory:");
			sqlite.run(`CREATE TABLE people (id TEXT PRIMARY KEY, ${column} TEXT)`);
			sqlite.run(`INSERT INTO people VALUES ('p1', 'Ada')`);
			return sqlite;
		};
		const peopleColumns = (sqlite: Database) =>
			(
				sqlite.query("PRAGMA table_info(people)").all() as { name: string }[]
			).map((column) => column.name);

		it("renames the snake_case column of the old key", async () => {
			const sqlite = peopleDatabase("full_name");
			const provider = drizzleProvider({
				db: drizzle(sqlite),
				tables: { Note: people },
				migrations: "apply",
			});
			await provider.migrate?.(bare, rename);
			expect(peopleColumns(sqlite)).toEqual(["id", "display_name"]);
			expect(sqlite.query("SELECT display_name FROM people").all()).toEqual([
				{ display_name: "Ada" },
			]);
		});

		it("renames the column named as the old key", async () => {
			const sqlite = peopleDatabase("fullName");
			const provider = drizzleProvider({
				db: drizzle(sqlite),
				tables: { Note: people },
				migrations: "apply",
			});
			await provider.migrate?.(bare, rename);
			expect(peopleColumns(sqlite)).toEqual(["id", "display_name"]);
		});

		it("refuses in apply mode when no source column is found", async () => {
			const sqlite = peopleDatabase("nickname");
			const provider = drizzleProvider({
				db: drizzle(sqlite),
				tables: { Note: people },
				migrations: "apply",
			});
			const error = await provider
				.migrate?.(bare, rename)
				.catch((error: Error) => error);
			expect((error as Error).message).toContain('"fullName"');
			expect(peopleColumns(sqlite)).toEqual(["id", "nickname"]);
		});

		it("adds the column with a note in file mode when no source column is found", async () => {
			const file = join(
				await mkdtemp(join(tmpdir(), "afora-drizzle-")),
				"0001_afora.sql",
			);
			const provider = drizzleProvider({
				db: drizzle(peopleDatabase("nickname")),
				tables: { Note: people },
				migrations: { file },
			});
			await provider.migrate?.(bare, rename);
			const written = await readFile(file, "utf8");
			expect(written).toContain(
				'-- Note: renamed "displayName" from "fullName"',
			);
			expect(written).toEndWith(
				'ALTER TABLE "people" ADD COLUMN "display_name" text;\n',
			);
		});
	});

	it("starts the file again on the next run of app.migrate", async () => {
		const sqlite = notesDatabase();
		const file = join(
			await mkdtemp(join(tmpdir(), "afora-drizzle-")),
			"0001_afora.sql",
		);
		const tags = sqliteTable("tags", {
			id: text("id").primaryKey(),
			label: text("label"),
		});
		sqlite.run(`CREATE TABLE tags (id TEXT PRIMARY KEY)`);
		const provider = drizzleProvider({
			db: drizzle(sqlite),
			tables: { Note: notes, Tag: tags },
			migrations: { file },
		});
		class Tag extends entityOf(
			blueprintOf((ctx) => ({ label: ctx.string })),
			{ name: "Tag" },
		) {}
		const tagContext = {
			...context,
			entity: Tag,
			name: "TagRepository",
			schema: undefined,
		} as unknown as RepositoryContext;
		const tagPlan: SchemaPlan = {
			entity: "Tag",
			destructive: false,
			changes: [
				{
					...change({ key: "label", change: "added-optional" }),
					entity: "Tag",
				},
			],
		};
		// One run: every entity once, the file gathers them.
		await provider.migrate?.(context, plan());
		await provider.migrate?.(tagContext, tagPlan);
		const first = await readFile(file, "utf8");
		expect(first).toContain('ALTER TABLE "notes" ADD COLUMN "locale"');
		expect(first).toEndWith('ALTER TABLE "tags" ADD COLUMN "label" text;\n');

		// The next run (Note again) starts the file over instead of appending.
		await provider.migrate?.(context, plan());
		await provider.migrate?.(tagContext, tagPlan);
		expect(await readFile(file, "utf8")).toBe(first);
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

		// The plan of another entity in the same run adds to the file.
		await provider.migrate?.(
			{ ...context, schema: undefined } as RepositoryContext,
			{
				entity: "Other",
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

// Tables derived from entities (drizzleTableOf).

/** The CREATE TABLE and CREATE INDEX statements of a derived SQLite table. */
function createStatementsOf(table: unknown): string[] {
	const config = getTableConfig(table as never);
	const columns = config.columns.map((column) => {
		const parts = [`"${column.name}"`, column.getSQLType()];
		if (column.primary) parts.push("PRIMARY KEY");
		if ((column as { autoIncrement?: boolean }).autoIncrement)
			parts.push("AUTOINCREMENT");
		if (column.notNull && !column.primary) parts.push("NOT NULL");
		if (column.isUnique) parts.push("UNIQUE");
		return parts.join(" ");
	});
	return [
		`CREATE TABLE "${config.name}" (${columns.join(", ")})`,
		...config.indexes.map(
			(index) =>
				`CREATE INDEX "${index.config.name}" ON "${config.name}" (${index.config.columns
					.map((column) => `"${(column as { name: string }).name}"`)
					.join(", ")})`,
		),
	];
}

/** The entity of the contract kit, with every key its rows hold. */
class ContractAccount extends entityOf(
	blueprintOf((ctx) => ({
		email: ctx.optionalOf(ctx.string),
		name: ctx.optionalOf(ctx.string),
		age: ctx.optionalOf(ctx.integer),
		active: ctx.optionalOf(ctx.boolean),
		address: ctx.optionalOf(
			blueprintOf((c) => ({ city: c.string, zip: c.optionalOf(c.string) })),
		),
		tags: ctx.optionalOf(ctx.listOf(ctx.string)),
		group: ctx.optionalOf(ctx.integer),
		n: ctx.optionalOf(ctx.integer),
		visits: ctx.optionalOf(ctx.integer),
	})),
	{
		name: "Accounts",
		unique: ["email"],
		versioned: true,
		expires: { after: { days: 1 } },
		schemaVersion: 2,
	},
) {}
class ContractSerial extends entityOf(
	blueprintOf((ctx) => ({
		email: ctx.optionalOf(ctx.string),
		name: ctx.optionalOf(ctx.string),
	})),
	{ name: "Serials", id: Serial, unique: ["email"] },
) {}

function derivedContractDatabase() {
	const sqlite = new Database(":memory:");
	// The kit writes rows without createdAt nor version.
	const overrides = () => ({
		createdAt: text("createdAt"),
		version: integer("version"),
	});
	const account = (name: string) =>
		drizzleTableOf(ContractAccount, {
			dialect: "sqlite",
			name,
			overrides: overrides(),
		});
	const tables = {
		Accounts: account("accounts"),
		One: account("one"),
		Two: account("two"),
		Serials: drizzleTableOf(ContractSerial, {
			dialect: "sqlite",
			name: "serials",
			overrides: { createdAt: text("createdAt") },
		}),
	};
	for (const table of Object.values(tables))
		for (const statement of createStatementsOf(table)) sqlite.run(statement);
	return { sqlite, db: drizzle(sqlite), tables };
}

describe("over tables derived by drizzleTableOf", () => {
	providerContract(
		{ describe, it, expect },
		() =>
			drizzleProvider({ ...derivedContractDatabase(), migrations: "apply" }),
		{ indexes: true },
	);
});

describe("drizzleTableOf on SQLite", () => {
	class Team extends entityOf(
		blueprintOf((ctx) => ({ title: ctx.string })),
		{
			name: "Team",
		},
	) {}
	class Member extends entityOf(
		blueprintOf((ctx) => ({
			name: ctx.string,
			email: ctx.email,
			age: ctx.optionalOf(ctx.integer),
			score: ctx.number,
			active: ctx.boolean,
			born: ctx.optionalOf(ctx.date),
			address: ctx.optionalOf(blueprintOf((c) => ({ city: c.string }))),
			tags: ctx.listOf(ctx.string),
			team: Team,
		})),
		{ name: "Member", unique: ["email"] },
	) {}

	it("stores and reads every kind of key through a repository", async () => {
		const sqlite = new Database(":memory:");
		const tables = {
			Team: drizzleTableOf(Team, { dialect: "sqlite" }),
			Member: drizzleTableOf(Member, {
				dialect: "sqlite",
				indexes: { byAge: { where: ["age"], orderBy: "name" } },
			}),
		};
		for (const table of Object.values(tables))
			for (const statement of createStatementsOf(table)) sqlite.run(statement);
		const provider = drizzleProvider({ db: drizzle(sqlite), tables });
		const Teams = repositoryOf({
			entity: Team,
			provider,
			actions: ["create"],
		});
		const Members = repositoryOf({
			entity: Member,
			provider,
			relations: [Teams],
			indexes: { byAge: { where: ["age"], orderBy: "name" } },
			actions: ["create", "findByEmail", "findMany"],
		});
		const team = await Teams.create(new Team({ title: "Core" }));
		await Members.create(
			new Member({
				name: "Ana",
				email: "ana@example.com",
				age: 30,
				score: 9.5,
				active: true,
				born: "1990-05-01",
				address: { city: "Rio" },
				tags: ["a", "b"],
				team,
			}),
		);
		const found = await Members.findByEmail("ana@example.com");
		expect(found?.toJSON()).toMatchObject({
			name: "Ana",
			age: 30,
			score: 9.5,
			active: true,
			born: "1990-05-01",
			address: { city: "Rio" },
			tags: ["a", "b"],
			team: { id: team.id, title: "Core" },
		});
		expect(sqlite.query("SELECT team, active, tags FROM member").get()).toEqual(
			{ team: team.id, active: 1, tags: '["a","b"]' },
		);
		expect(
			(
				await Members.findMany({
					where: { age: 30 },
					orderBy: [{ key: "name" }],
				})
			).length,
		).toBe(1);
		const indexes = sqlite.query("PRAGMA index_list(member)").all() as {
			name: string;
		}[];
		expect(indexes.map((index) => index.name)).toContain("member_by_age");
	});

	it("gives Serial ids the database assigns", async () => {
		class Ticket extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string })),
			{ name: "Ticket", id: Serial },
		) {}
		const sqlite = new Database(":memory:");
		const table = drizzleTableOf(Ticket, { dialect: "sqlite" });
		for (const statement of createStatementsOf(table)) sqlite.run(statement);
		const Tickets = repositoryOf({
			entity: Ticket,
			provider: drizzleProvider({
				db: drizzle(sqlite),
				tables: { Ticket: table },
			}),
			actions: ["create"],
		});
		const first = await Tickets.create(new Ticket({ title: "a" }));
		const second = await Tickets.create(new Ticket({ title: "b" }));
		expect([first.id, second.id]).toEqual([1, 2]);
	});
});

describe("the migration journal", () => {
	class Note extends entityOf(
		blueprintOf((ctx) => ({
			title: ctx.string,
			tags: ctx.optionalOf(ctx.listOf(ctx.string)),
		})),
		{ name: "Note" },
	) {}
	class NoteV1 extends entityOf(
		blueprintOf((ctx) => ({ title: ctx.string })),
		{ name: "Note" },
	) {}
	const appOf = (
		entity: typeof Note | typeof NoteV1,
		provider: DrizzleProvider,
	) =>
		applicationOf({
			name: "notes",
			entities: { Note: entity },
			repositories: {
				Notes: repositoryOf({ entity, provider, actions: ["findMany"] }),
			},
		});
	const lock = schemaLockOf(
		appOf(
			NoteV1,
			drizzleProvider({ db: drizzle(new Database(":memory:")), tables: {} }),
		).describe(),
	);
	const database = () => {
		const sqlite = new Database(":memory:");
		for (const statement of createStatementsOf(
			drizzleTableOf(NoteV1, { dialect: "sqlite", name: "note" }),
		))
			sqlite.run(statement);
		return sqlite;
	};
	const tables = { Note: drizzleTableOf(Note, { dialect: "sqlite" }) };

	it("records each applied plan in afora_migrations and skips it on the next run", async () => {
		const sqlite = database();
		const plans: unknown[] = [];
		const provider = drizzleProvider({
			db: drizzle(sqlite),
			tables,
			migrations: "apply",
		});
		const migrate = provider.migrate?.bind(provider);
		Object.assign(provider, {
			migrate: (...args: Parameters<NonNullable<typeof migrate>>) => {
				plans.push(args[1]);
				return migrate?.(...args);
			},
		});
		const app = appOf(Note, provider);
		const first = await app.migrate({ mode: "apply", lock });
		expect(first.entities.Note?.alreadyApplied).toBe(false);
		expect(
			(sqlite.query("PRAGMA table_info(note)").all() as { name: string }[]).map(
				(column) => column.name,
			),
		).toContain("tags");
		const rows = sqlite
			.query("SELECT entity, checksum, plan, applied_at FROM afora_migrations")
			.all() as Record<string, string>[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.entity).toBe("Note");
		expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.parse(rows[0]?.plan ?? "{}").changes[0].key).toBe("tags");

		const second = await app.migrate({ mode: "apply", lock });
		expect(second.entities.Note?.alreadyApplied).toBe(true);
		expect(plans).toHaveLength(1);

		// A new process over the same database finds the journal there.
		const rerun = appOf(
			Note,
			drizzleProvider({ db: drizzle(sqlite), tables, migrations: "apply" }),
		);
		expect(
			(await rerun.migrate({ mode: "apply", lock })).entities.Note
				?.alreadyApplied,
		).toBe(true);
		expect(
			sqlite.query("SELECT count(*) AS n FROM afora_migrations").get(),
		).toEqual({ n: 1 });
	});

	it("is absent without migrations and with migrations: { file }", async () => {
		const file = join(
			await mkdtemp(join(tmpdir(), "afora-drizzle-")),
			"0001_afora.sql",
		);
		const sqlite = database();
		const written = drizzleProvider({
			db: drizzle(sqlite),
			tables,
			migrations: { file },
		});
		expect(written.journal).toBeUndefined();
		expect(
			drizzleProvider({ db: drizzle(sqlite), tables }).journal,
		).toBeUndefined();
		await appOf(Note, written).migrate({ mode: "apply", lock });
		expect(
			sqlite
				.query("SELECT name FROM sqlite_master WHERE name = 'afora_migrations'")
				.all(),
		).toEqual([]);
	});
});
