import { afterAll, describe, expect, it } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	entityOf,
	repositoryOf,
	Serial,
} from "@afora/core";
import {
	type RepositoryContext,
	type SchemaPlan,
	schemaLockOf,
} from "@afora/core/adapters";
import { providerContract } from "@afora/core/testing";
import { PGlite } from "@electric-sql/pglite";
import {
	boolean,
	getTableConfig,
	integer,
	jsonb,
	pgTable,
	serial,
	text,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { drizzleProvider, drizzleTableOf } from "./index";

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
		schemaVersion: integer("schema_version"),
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
			`CREATE TABLE ${table} (id text PRIMARY KEY, email text UNIQUE, name text, age integer, active boolean, address jsonb, tags jsonb, "group" integer, n integer, visits integer, version integer, "deletedAt" text, "expiresAt" text, schema_version integer)`,
		);
	}
	const serials = `serials_${round}`;
	await client.exec(
		`CREATE TABLE ${serials} (id serial PRIMARY KEY, email text UNIQUE, name text)`,
	);
	return {
		db: drizzle(client),
		tables: {
			Accounts: accountTable(names.Accounts),
			One: accountTable(names.One),
			Two: accountTable(names.Two),
			Serials: pgTable(serials, {
				id: serial("id").primaryKey(),
				email: text("email").unique(),
				name: text("name"),
			}),
		},
	};
}

providerContract(
	{ describe, it, expect },
	async () => drizzleProvider(await freshDatabase()),
	{ indexes: true },
);

describe("repositoryOf on Postgres", () => {
	it("updates, soft deletes, restores and increments over a GENERATED ALWAYS identity", async () => {
		const {
			bigint,
			blueprintOf,
			entityOf,
			repositoryOf,
			Serial,
			UnsupportedIdentity,
		} = {
			...(await import("@afora/core")),
			...(await import("drizzle-orm/pg-core")),
		};
		await client.exec(
			`CREATE TABLE counters (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "createdAt" text NOT NULL, "updatedAt" text, "deletedAt" text, name text NOT NULL, views integer NOT NULL)`,
		);
		const counters = pgTable("counters", {
			id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
			createdAt: text("createdAt").notNull(),
			updatedAt: text("updatedAt"),
			deletedAt: text("deletedAt"),
			name: text("name").notNull(),
			views: integer("views").notNull(),
		});
		class Counter extends entityOf(
			blueprintOf((ctx) => ({ name: ctx.string, views: ctx.integer })),
			{ id: Serial, change: ["name", "views"] },
		) {}
		const Counters = repositoryOf({
			entity: Counter,
			provider: drizzleProvider({
				db: drizzle(client),
				tables: { Counter: counters },
			}),
			actions: [
				"create",
				"findById",
				"update",
				"delete",
				"restore",
				"increment",
			],
			deletion: "soft",
		});
		const counter = await Counters.create({ name: "home", views: 0 });
		expect(counter.id).toBe(1);
		await Counters.update(counter.change.name("start"));
		expect((await Counters.findById(1))?.name).toBe("start");
		expect((await Counters.increment(1, { views: 2 })).views).toBe(2);
		await Counters.delete(1);
		expect(await Counters.findById(1)).toBeUndefined();
		expect((await Counters.restore(1)).name).toBe("start");
		expect((await Counters.findById(1))?.views).toBe(2);
		// An id of its own would leave the identity behind.
		await expect(
			Counters.create(new Counter({ id: 7, name: "x", views: 0 })),
		).rejects.toThrow(UnsupportedIdentity);

		await client.exec(
			`CREATE TABLE huge (id bigint GENERATED ALWAYS AS IDENTITY (START WITH 9007199254740993) PRIMARY KEY, "createdAt" text NOT NULL, "updatedAt" text, "deletedAt" text, name text NOT NULL, views integer NOT NULL)`,
		);
		const huge = pgTable("huge", {
			id: bigint("id", { mode: "bigint" })
				.primaryKey()
				.generatedAlwaysAsIdentity(),
			createdAt: text("createdAt").notNull(),
			updatedAt: text("updatedAt"),
			deletedAt: text("deletedAt"),
			name: text("name").notNull(),
			views: integer("views").notNull(),
		});
		const Huge = repositoryOf({
			entity: Counter,
			provider: drizzleProvider({
				db: drizzle(client),
				tables: { Counter: huge },
			}),
			actions: ["create"],
		});
		// Beyond Number.MAX_SAFE_INTEGER: refused, not rounded to another id.
		await expect(Huge.create({ name: "big", views: 0 })).rejects.toThrow(
			UnsupportedIdentity,
		);
	});

	it("stores Serial entities in an identity column, and pages by cursor", async () => {
		const { blueprintOf, entityOf, repositoryOf, Serial } = await import(
			"@afora/core"
		);
		await client.exec(
			`CREATE TABLE tickets (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "createdAt" text NOT NULL, "updatedAt" text, "deletedAt" text, title text NOT NULL)`,
		);
		const tickets = pgTable("tickets", {
			id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
			createdAt: text("createdAt").notNull(),
			updatedAt: text("updatedAt"),
			deletedAt: text("deletedAt"),
			title: text("title").notNull(),
		});
		class Ticket extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string })),
			{ id: Serial },
		) {}
		const Tickets = repositoryOf({
			entity: Ticket,
			provider: drizzleProvider({
				db: drizzle(client),
				tables: { Ticket: tickets },
			}),
			actions: ["create", "findById", "findCursor"],
		});
		const made: number[] = [];
		for (let index = 1; index <= 10; index++) {
			made.push((await Tickets.create({ title: `T${index}` })).id);
		}
		expect(made).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect((await Tickets.findById(10))?.title).toBe("T10");
		const first = await Tickets.findCursor({ limit: 9 });
		const rest = await Tickets.findCursor({ limit: 9, after: first.next });
		expect(rest.items.map((ticket) => ticket.id)).toEqual([10]);
	});

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

describe("migrate on Postgres", () => {
	it("applies the plan, maps the schema version and runs again as a no-op", async () => {
		const { blueprintOf, entityOf } = await import("@afora/core");
		await client.exec(
			`CREATE TABLE articles (id text PRIMARY KEY, name text, legacy text); INSERT INTO articles VALUES ('a1', 'Old', 'x')`,
		);
		const articles = pgTable("articles", {
			id: text("id").primaryKey(),
			title: text("title"),
			published: boolean("published").notNull().default(false),
			meta: jsonb("meta"),
			version: integer("schema_version"),
		});
		class Article extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string })),
			{ name: "Article" },
		) {}
		const context = {
			entity: Article,
			name: "ArticleRepository",
			unique: ["id"],
			env: {},
			schema: { version: 2, key: "$v", previousNames: [] },
		} as unknown as RepositoryContext;
		const base = {
			entity: "Article",
			class: "automatic",
			satisfied: true,
			destructive: false,
		} as const;
		const plan = (destructive: boolean): SchemaPlan => ({
			entity: "Article",
			destructive,
			changes: [
				{ ...base, key: "title", change: "renamed", from: "name" },
				{ ...base, key: "published", change: "added-required" },
				{ ...base, key: "meta", change: "added-optional" },
				{ ...base, key: "legacy", change: "removed", destructive: true },
			],
		});
		const provider = drizzleProvider({
			db: drizzle(client),
			tables: { Article: articles },
			migrations: "apply",
		});
		const columns = async () =>
			(
				await client.query<{ column_name: string }>(
					`SELECT column_name FROM information_schema.columns WHERE table_name = 'articles' ORDER BY ordinal_position`,
				)
			).rows.map((row) => row.column_name);

		await provider.migrate?.(context, plan(false));
		expect(await columns()).toEqual([
			"id",
			"title",
			"legacy",
			"published",
			"meta",
			"schema_version",
		]);
		await provider.migrate?.(context, plan(false));
		await provider.migrate?.(context, plan(true));
		expect(await columns()).toEqual([
			"id",
			"title",
			"published",
			"meta",
			"schema_version",
		]);

		expect(await provider.findOne(context, { where: { id: "a1" } })).toEqual({
			id: "a1",
			title: "Old",
			published: false,
		});
		const data = { id: "a2", title: "New", published: true, $v: 2 };
		await provider.insert(context, data);
		expect(await provider.findOne(context, { where: { id: "a2" } })).toEqual(
			data,
		);
		expect(
			(
				await client.query<{ schema_version: number }>(
					`SELECT schema_version FROM articles WHERE id = 'a2'`,
				)
			).rows,
		).toEqual([{ schema_version: 2 }]);
	});

	it("drops a unique key made a constraint by drizzle-kit, or an index", async () => {
		const { blueprintOf, entityOf } = await import("@afora/core");
		// drizzle-kit declares `.unique()` as a named UNIQUE constraint.
		await client.exec(
			`CREATE TABLE handles (id text PRIMARY KEY, slug text, CONSTRAINT "handles_slug_unique" UNIQUE("slug")); CREATE TABLE codes (id text PRIMARY KEY, slug text); CREATE UNIQUE INDEX "codes_slug_unique" ON codes (slug)`,
		);
		const tableWithSlug = (name: string) =>
			pgTable(name, { id: text("id").primaryKey(), slug: text("slug") });
		class Handle extends entityOf(
			blueprintOf((ctx) => ({ slug: ctx.string })),
			{ name: "Handle" },
		) {}
		const contextOf = (name: string) =>
			({
				entity: Handle,
				name,
				unique: ["id"],
				env: {},
			}) as unknown as RepositoryContext;
		const plan: SchemaPlan = {
			entity: "Handle",
			destructive: false,
			changes: [
				{
					entity: "Handle",
					class: "automatic",
					satisfied: true,
					destructive: false,
					key: "slug",
					change: "unique-removed",
				},
			],
		};
		const provider = drizzleProvider({
			db: drizzle(client),
			tables: {
				Handles: tableWithSlug("handles"),
				Codes: tableWithSlug("codes"),
			},
			migrations: "apply",
		});
		await provider.migrate?.(contextOf("Handles"), plan);
		await provider.migrate?.(contextOf("Codes"), plan);
		for (const table of ["handles", "codes"]) {
			await client.exec(
				`INSERT INTO ${table} VALUES ('1', 'same'), ('2', 'same')`,
			);
		}
		// And again, with nothing left to drop.
		await provider.migrate?.(contextOf("Handles"), plan);
	});
});

// Tables derived from entities (drizzleTableOf).

/** The CREATE TABLE and CREATE INDEX statements of a derived Postgres table. */
function createStatementsOf(table: unknown): string[] {
	const config = getTableConfig(table as never);
	const columns = config.columns.map((column) => {
		const parts = [`"${column.name}"`, column.getSQLType()];
		const identity = (column as { generatedIdentity?: { type: string } })
			.generatedIdentity;
		if (identity)
			parts.push(`GENERATED ${identity.type.toUpperCase()} AS IDENTITY`);
		if (column.primary) parts.push("PRIMARY KEY");
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

async function derivedDatabase() {
	round += 1;
	// The kit writes rows without createdAt nor version.
	const overrides = () => ({
		createdAt: text("createdAt"),
		version: integer("version"),
	});
	const account = (name: string) =>
		drizzleTableOf(ContractAccount, {
			dialect: "postgres",
			name: `${name}_${round}`,
			overrides: overrides(),
		});
	const tables = {
		Accounts: account("derived_accounts"),
		One: account("derived_one"),
		Two: account("derived_two"),
		Serials: drizzleTableOf(ContractSerial, {
			dialect: "postgres",
			name: `derived_serials_${round}`,
			overrides: { createdAt: text("createdAt") },
		}),
	};
	for (const table of Object.values(tables))
		for (const statement of createStatementsOf(table))
			await client.exec(statement);
	// Every case gets an empty journal, as the database is shared.
	await client.exec("DROP TABLE IF EXISTS afora_migrations");
	return { db: drizzle(client), tables };
}

describe("over tables derived by drizzleTableOf", () => {
	providerContract(
		{ describe, it, expect },
		async () =>
			drizzleProvider({ ...(await derivedDatabase()), migrations: "apply" }),
		{ indexes: true },
	);
});

describe("drizzleTableOf on Postgres", () => {
	it("stores and reads every kind of key, and Serial ids, through repositories", async () => {
		round += 1;
		class Team extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string })),
			{ name: "Team", id: Serial },
		) {}
		class Member extends entityOf(
			blueprintOf((ctx) => ({
				name: ctx.string,
				email: ctx.email,
				age: ctx.optionalOf(ctx.integer),
				score: ctx.number,
				active: ctx.boolean,
				address: ctx.optionalOf(blueprintOf((c) => ({ city: c.string }))),
				tags: ctx.listOf(ctx.string),
				team: Team,
			})),
			{ name: "Member", unique: ["email"] },
		) {}
		const tables = {
			Team: drizzleTableOf(Team, {
				dialect: "postgres",
				name: `team_${round}`,
			}),
			Member: drizzleTableOf(Member, {
				dialect: "postgres",
				name: `member_${round}`,
				indexes: { byAge: { where: ["age"], orderBy: "name" } },
			}),
		};
		for (const table of Object.values(tables))
			for (const statement of createStatementsOf(table))
				await client.exec(statement);
		const provider = drizzleProvider({ db: drizzle(client), tables });
		const Teams = repositoryOf({ entity: Team, provider, actions: ["create"] });
		const Members = repositoryOf({
			entity: Member,
			provider,
			relations: [Teams],
			actions: ["create", "findByEmail"],
		});
		const team = await Teams.create(new Team({ title: "Core" }));
		expect(typeof team.id).toBe("number");
		await Members.create(
			new Member({
				name: "Ana",
				email: "ana@example.com",
				age: 30,
				score: 9.5,
				active: true,
				address: { city: "Rio" },
				tags: ["a", "b"],
				team,
			}),
		);
		expect(
			(await Members.findByEmail("ana@example.com"))?.toJSON(),
		).toMatchObject({
			age: 30,
			score: 9.5,
			active: true,
			address: { city: "Rio" },
			tags: ["a", "b"],
			team: { id: team.id, title: "Core" },
		});
	});
});

describe("the migration journal on Postgres", () => {
	it("records each applied plan and skips it on the next run", async () => {
		round += 1;
		await client.exec("DROP TABLE IF EXISTS afora_migrations");
		const name = `note_${round}`;
		class NoteV1 extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string })),
			{ name: "Note" },
		) {}
		class Note extends entityOf(
			blueprintOf((ctx) => ({
				title: ctx.string,
				tags: ctx.optionalOf(ctx.listOf(ctx.string)),
			})),
			{ name: "Note" },
		) {}
		for (const statement of createStatementsOf(
			drizzleTableOf(NoteV1, { dialect: "postgres", name }),
		))
			await client.exec(statement);
		const appOf = (entity: typeof Note | typeof NoteV1) =>
			applicationOf({
				name: "notes",
				entities: { Note: entity },
				repositories: {
					Notes: repositoryOf({
						entity,
						actions: ["findMany"],
						provider: drizzleProvider({
							db: drizzle(client),
							tables: {
								Note: drizzleTableOf(Note, { dialect: "postgres", name }),
							},
							migrations: "apply",
						}),
					}),
				},
			});
		const lock = schemaLockOf(appOf(NoteV1).describe());
		const first = await appOf(Note).migrate({ mode: "apply", lock });
		expect(first.entities.Note?.alreadyApplied).toBe(false);
		const columns = await client.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns WHERE table_name = '${name}'`,
		);
		expect(columns.rows.map((row) => row.column_name)).toContain("tags");
		// A new provider over the same database: the journal survives.
		const again = await appOf(Note).migrate({ mode: "apply", lock });
		expect(again.entities.Note?.alreadyApplied).toBe(true);
		const journal = await client.query<{ entity: string; n: number }>(
			"SELECT entity, count(*)::int AS n FROM afora_migrations GROUP BY entity",
		);
		expect(journal.rows).toEqual([{ entity: "Note", n: 1 }]);
	});
});
