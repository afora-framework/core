import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	blueprintOf,
	commandOf,
	entityOf,
	repositoryOf,
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
		deletedAt: text("deletedAt"),
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
			`CREATE TABLE ${table} (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, age INTEGER, active INTEGER, address TEXT, tags TEXT, "group" INTEGER, n INTEGER, deletedAt TEXT)`,
		);
	}
	return { db: drizzle(sqlite), tables };
}

providerContract({ describe, it, expect }, () =>
	drizzleProvider(contractDatabase()),
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
