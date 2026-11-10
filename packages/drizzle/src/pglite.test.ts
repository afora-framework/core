import { afterAll, describe, expect, it } from "bun:test";
import { providerContract } from "@afora/core/testing";
import { PGlite } from "@electric-sql/pglite";
import { boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { drizzleProvider } from "./index";

const accountTable = (name: string) =>
	pgTable(name, {
		id: text("id").primaryKey(),
		email: text("email").unique(),
		name: text("name"),
		age: integer("age"),
		active: boolean("active"),
		address: jsonb("address"),
		tags: jsonb("tags"),
		group: integer("group"),
		n: integer("n"),
		visits: integer("visits"),
		version: integer("version"),
		deletedAt: text("deletedAt"),
		expiresAt: text("expiresAt"),
	});

/** One PGlite instance (Postgres compiled to WASM) serves every case; each gets fresh tables. */
const client = new PGlite();
let round = 0;

// Without it the WASM runtime ends the process with a nonzero exit code.
afterAll(() => client.close());

async function freshDatabase() {
	round += 1;
	const names = {
		Accounts: `accounts_${round}`,
		One: `one_${round}`,
		Two: `two_${round}`,
	};
	for (const table of Object.values(names)) {
		await client.exec(
			`CREATE TABLE ${table} (id text PRIMARY KEY, email text UNIQUE, name text, age integer, active boolean, address jsonb, tags jsonb, "group" integer, n integer, visits integer, version integer, "deletedAt" text, "expiresAt" text)`,
		);
	}
	return {
		db: drizzle(client),
		tables: {
			Accounts: accountTable(names.Accounts),
			One: accountTable(names.One),
			Two: accountTable(names.Two),
		},
	};
}

providerContract(
	{ describe, it, expect },
	async () => drizzleProvider(await freshDatabase()),
	{ indexes: true },
);

describe("repositoryOf on Postgres", () => {
	it("stores entities with uuid ids and rolls a command back", async () => {
		const { blueprintOf, commandOf, entityOf, repositoryOf, useCaseOf } =
			await import("@afora/core");
		const { uuid, timestamp } = await import("drizzle-orm/pg-core");
		const members = pgTable("members", {
			id: uuid("id").primaryKey(),
			createdAt: timestamp("createdAt", { mode: "date", withTimezone: true }),
			updatedAt: timestamp("updatedAt", { mode: "date", withTimezone: true }),
			deletedAt: timestamp("deletedAt", { mode: "date", withTimezone: true }),
			name: text("name").notNull(),
		});
		await client.exec(
			`CREATE TABLE members (id uuid PRIMARY KEY, "createdAt" timestamptz, "updatedAt" timestamptz, "deletedAt" timestamptz, name text NOT NULL)`,
		);
		class Member extends entityOf(
			blueprintOf((ctx) => ({ name: ctx.string })),
		) {}
		const Members = repositoryOf({
			entity: Member,
			provider: drizzleProvider({
				db: drizzle(client),
				tables: { Member: members },
			}),
			actions: ["create", "count", "findMany"],
		});
		class Join extends useCaseOf({
			name: "Join",
			blueprint: blueprintOf((ctx) => ({ name: ctx.string })),
			response: blueprintOf((ctx) => ({ total: ctx.integer })),
			dependencies: { members: Members },
		}) {
			override async execute({ members = this.dependencies.members } = {}) {
				await members.create(new Member(this.input));
				if (this.input.name === "Fail") throw new Error("boom");
				return { total: await members.count() };
			}
		}
		const Commands = commandOf({
			name: "Commands",
			transaction: true,
			useCases: { join: Join },
		});
		expect(await Commands.run("join", { name: "Ana" })).toEqual({ total: 1 });
		await expect(Commands.run("join", { name: "Fail" })).rejects.toBeDefined();
		expect(await Members.count()).toBe(1);
		const [ana] = await Members.findMany({ orderBy: [{ key: "createdAt" }] });
		expect(ana?.name).toBe("Ana");
	});

	it("leaves expired rows out over a timestamp column", async () => {
		const { blueprintOf, entityOf, repositoryOf } = await import("@afora/core");
		const { uuid, timestamp } = await import("drizzle-orm/pg-core");
		const stamp = (name: string) =>
			timestamp(name, { mode: "date", withTimezone: true });
		const sessions = pgTable("sessions", {
			id: uuid("id").primaryKey(),
			createdAt: stamp("createdAt"),
			updatedAt: stamp("updatedAt"),
			deletedAt: stamp("deletedAt"),
			expiresAt: stamp("expiresAt"),
			name: text("name").notNull(),
		});
		await client.exec(
			`CREATE TABLE sessions (id uuid PRIMARY KEY, "createdAt" timestamptz, "updatedAt" timestamptz, "deletedAt" timestamptz, "expiresAt" timestamptz, name text NOT NULL)`,
		);
		class Session extends entityOf(
			blueprintOf((ctx) => ({ name: ctx.string })),
			{ name: "Session", expires: { after: { minutes: 5 } } },
		) {}
		const Sessions = repositoryOf({
			entity: Session,
			provider: drizzleProvider({
				db: drizzle(client),
				tables: { Session: sessions },
			}),
			actions: ["create", "count", "findMany"],
		});
		const old = new Date(Date.now() - 10 * 60_000).toISOString();
		await Sessions.create(new Session({ name: "old", createdAt: old }));
		await Sessions.create({ name: "new" });
		expect((await Sessions.findMany()).map((s) => s.name)).toEqual(["new"]);
		expect(await Sessions.count()).toBe(1);
		expect(await Sessions.count({ withExpired: true })).toBe(2);
	});
});
