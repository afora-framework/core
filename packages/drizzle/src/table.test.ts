import { describe, expect, it } from "bun:test";
import {
	blueprintOf,
	entityOf,
	InvalidRepositoryDeclaration,
	propertyOf,
	Serial,
} from "@afora/core";
import { getTableName } from "drizzle-orm";
import { getTableConfig as pgConfigOf, timestamp } from "drizzle-orm/pg-core";
import {
	getTableConfig as sqliteConfigOf,
	text,
} from "drizzle-orm/sqlite-core";
import { Type } from "typebox";
import { drizzleTableOf } from "./index";

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
		nickname: ctx.optionalOf(ctx.string),
		age: ctx.optionalOf(ctx.integer),
		score: ctx.number,
		active: ctx.boolean,
		born: ctx.optionalOf(ctx.date),
		role: ctx.enumOf(["admin", "member"]),
		address: ctx.optionalOf(blueprintOf((c) => ({ city: c.string }))),
		tags: ctx.listOf(ctx.string),
		team: Team,
		teams: ctx.listOf(Team),
	})),
	{ name: "TeamMember", unique: ["email"] },
) {}

/** The columns of a table: SQL name, SQL type, NOT NULL, PRIMARY KEY, UNIQUE. */
function columnsOf(table: unknown, dialect: "sqlite" | "postgres") {
	const config =
		dialect === "postgres"
			? pgConfigOf(table as never)
			: sqliteConfigOf(table as never);
	return Object.fromEntries(
		config.columns.map((column) => [
			column.name,
			[
				column.getSQLType(),
				column.notNull ? "not null" : "null",
				...(column.primary ? ["primary"] : []),
				...(column.isUnique ? ["unique"] : []),
			].join(" "),
		]),
	);
}

const configOf = (table: unknown, dialect: "sqlite" | "postgres") =>
	dialect === "postgres"
		? pgConfigOf(table as never)
		: sqliteConfigOf(table as never);

function failure(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("drizzleTableOf", () => {
	it("names the table after the entity, and the columns after its keys", () => {
		const table = drizzleTableOf(Member, { dialect: "sqlite" });
		expect(getTableName(table)).toBe("team_member");
		expect(configOf(table, "sqlite").columns.map((c) => c.name)).toEqual([
			"id",
			"createdAt",
			"updatedAt",
			"deletedAt",
			"name",
			"email",
			"nickname",
			"age",
			"score",
			"active",
			"born",
			"role",
			"address",
			"tags",
			"team",
			"teams",
		]);
		expect(
			getTableName(
				drizzleTableOf(Member, { dialect: "sqlite", name: "members" }),
			),
		).toBe("members");
	});

	it("maps every key on SQLite", () => {
		expect(
			columnsOf(drizzleTableOf(Member, { dialect: "sqlite" }), "sqlite"),
		).toEqual({
			id: "text not null primary",
			createdAt: "text not null",
			updatedAt: "text null",
			deletedAt: "text null",
			name: "text not null",
			email: "text not null unique",
			nickname: "text null",
			age: "integer null",
			score: "real not null",
			active: "integer not null",
			born: "text null",
			role: "text not null",
			address: "text null",
			tags: "text not null",
			team: "text not null",
			teams: "text not null",
		});
	});

	it("maps every key on Postgres", () => {
		expect(
			columnsOf(drizzleTableOf(Member, { dialect: "postgres" }), "postgres"),
		).toEqual({
			id: "text not null primary",
			createdAt: "text not null",
			updatedAt: "text null",
			deletedAt: "text null",
			name: "text not null",
			email: "text not null unique",
			nickname: "text null",
			age: "bigint null",
			score: "double precision not null",
			active: "boolean not null",
			born: "text null",
			role: "text not null",
			address: "jsonb null",
			tags: "jsonb not null",
			team: "text not null",
			teams: "jsonb not null",
		});
	});

	it("stores nested records and lists as JSON, booleans in their mode", () => {
		const sqlite = configOf(
			drizzleTableOf(Member, { dialect: "sqlite" }),
			"sqlite",
		);
		const byName = (name: string) =>
			sqlite.columns.find((column) => column.name === name) as unknown as {
				readonly config: { readonly mode?: string };
				readonly columnType: string;
			};
		expect(byName("address").columnType).toBe("SQLiteTextJson");
		expect(byName("tags").columnType).toBe("SQLiteTextJson");
		expect(byName("active").columnType).toBe("SQLiteBoolean");
	});

	it("gives Serial ids an integer key the database assigns", () => {
		class Ticket extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string })),
			{ name: "Ticket", id: Serial },
		) {}
		const [sqliteId] = configOf(
			drizzleTableOf(Ticket, { dialect: "sqlite" }),
			"sqlite",
		).columns as unknown as {
			name: string;
			primary: boolean;
			autoIncrement: boolean;
			getSQLType(): string;
		}[];
		expect([
			sqliteId?.name,
			sqliteId?.getSQLType(),
			sqliteId?.primary,
			sqliteId?.autoIncrement,
		]).toEqual(["id", "integer", true, true]);
		const [pgId] = configOf(
			drizzleTableOf(Ticket, { dialect: "postgres" }),
			"postgres",
		).columns as unknown as {
			getSQLType(): string;
			primary: boolean;
			generatedIdentity?: { type: string };
		}[];
		expect([
			pgId?.getSQLType(),
			pgId?.primary,
			pgId?.generatedIdentity?.type,
		]).toEqual(["bigint", true, "always"]);
	});

	it("adds version, expiresAt and schema_version as the entity declares them", () => {
		class Page extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string })),
			{
				name: "Page",
				versioned: true,
				expires: { after: { days: 30 } },
				schemaVersion: 2,
			},
		) {}
		const table = drizzleTableOf(Page, { dialect: "sqlite" });
		expect(columnsOf(table, "sqlite")).toMatchObject({
			version: "integer not null",
			expiresAt: "text null",
			schema_version: "integer null",
		});
		// The key of the column is schemaVersion, which the provider maps to $v.
		expect(Object.keys(table)).toContain("schemaVersion");
		expect(
			columnsOf(
				drizzleTableOf(Page, {
					dialect: "postgres",
					schemaVersionColumn: "shape_version",
				}),
				"postgres",
			),
		).toMatchObject({ shape_version: "bigint null" });
	});

	it("turns the indexes of a repository into SQL indexes", () => {
		for (const dialect of ["sqlite", "postgres"] as const) {
			const config = configOf(
				drizzleTableOf(Member, {
					dialect,
					indexes: { byAge: { where: ["age"], orderBy: "name" } },
				}),
				dialect,
			);
			expect(
				config.indexes.map((index) => [
					index.config.name,
					index.config.columns.map(
						(column) => (column as { name: string }).name,
					),
				]),
			).toEqual([["team_member_by_age", ["age", "name"]]]);
		}
	});

	it("takes a SQL name or a column of your own per key", () => {
		const table = drizzleTableOf(Member, {
			dialect: "postgres",
			overrides: {
				email: { name: "email_address" },
				createdAt: timestamp("created_at", {
					mode: "date",
					withTimezone: true,
				}).notNull(),
			},
		});
		const columns = columnsOf(table, "postgres");
		expect(columns.email_address).toBe("text not null unique");
		expect(columns.created_at).toBe("timestamp with time zone not null");
		// The keys stay those of the entity.
		expect(Object.keys(table)).toContain("email");
		expect(Object.keys(table)).toContain("createdAt");
	});

	it("refuses a key whose value is not JSON, unless overridden", () => {
		const Big = propertyOf({ name: "big", schema: Type.BigInt() });
		class Upload extends entityOf(
			blueprintOf(() => ({ file: Big })),
			{ name: "Upload" },
		) {}
		const error = failure(() => drizzleTableOf(Upload, { dialect: "sqlite" }));
		expect(error instanceof InvalidRepositoryDeclaration).toBe(true);
		expect((error as Error).message).toContain('"file"');
		expect(
			columnsOf(
				drizzleTableOf(Upload, {
					dialect: "sqlite",
					overrides: { file: text("file").notNull() },
				}),
				"sqlite",
			).file,
		).toBe("text not null");
	});

	it("refuses what it cannot build", () => {
		const cases: (() => unknown)[] = [
			() => drizzleTableOf(class {} as never, { dialect: "sqlite" }),
			() => drizzleTableOf(Member, { dialect: "mysql" as never }),
			() =>
				drizzleTableOf(Member, {
					dialect: "sqlite",
					overrides: { missing: { name: "x" } },
				}),
			() =>
				drizzleTableOf(Member, {
					dialect: "sqlite",
					overrides: { email: { name: "" } },
				}),
			() =>
				drizzleTableOf(Member, {
					dialect: "sqlite",
					indexes: { byNothing: { where: ["missing"] } },
				}),
			() =>
				drizzleTableOf(Member, {
					dialect: "sqlite",
					indexes: { empty: { where: [] } },
				}),
		];
		for (const run of cases) {
			expect(failure(run) instanceof InvalidRepositoryDeclaration).toBe(true);
		}
	});
});
