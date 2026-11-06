import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

const sqlite = new Database(process.env.BLOG_DB ?? ":memory:");

sqlite.run(`create table if not exists users (
	id text primary key, createdAt text not null, updatedAt text, deletedAt text,
	name text not null, email text not null unique, password text not null)`);
sqlite.run(`create table if not exists posts (
	id text primary key, createdAt text not null, updatedAt text, deletedAt text,
	title text not null, content text not null, status text not null,
	author text not null, tags text, publishedAt text)`);

export const db = drizzle(sqlite);
