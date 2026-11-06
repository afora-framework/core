import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	createdAt: text("createdAt").notNull(),
	updatedAt: text("updatedAt"),
	deletedAt: text("deletedAt"),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	password: text("password").notNull(),
});

export const posts = sqliteTable("posts", {
	id: text("id").primaryKey(),
	createdAt: text("createdAt").notNull(),
	updatedAt: text("updatedAt"),
	deletedAt: text("deletedAt"),
	title: text("title").notNull(),
	content: text("content").notNull(),
	status: text("status").notNull(),
	author: text("author").notNull(),
	tags: text("tags", { mode: "json" }),
	publishedAt: text("publishedAt"),
});

/** Repository to table, by entity name. */
export const tables = { User: users, Post: posts };
