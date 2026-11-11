import { describe, expect, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	diffSchemas,
	entityOf,
	InvalidEntitySchemaVersion,
	InvalidRepositoryData,
	InvalidStoredSchemaVersion,
	inMemoryProvider,
	listOf,
	type RepositoryContext,
	type RepositoryData,
	ReservedEntityKey,
	repositoryOf,
	SCHEMA_VERSION_KEY,
	SchemaLockMismatch,
	schemaLockOf,
} from "../../index";
import type { Exception } from "../exception/exception";

/** The rows of `name` in `provider`, as stored. */
function contextOf(entity: object, name: string): RepositoryContext {
	return {
		entity,
		name: `${name}Repository`,
		unique: ["id"],
		indexes: {},
		env: {},
	} as unknown as RepositoryContext;
}

const createdAt = "2026-01-01T00:00:00.000Z";
let sequence = 0;
const idOf = () => {
	sequence += 1;
	return `0190a1b2-c3d4-7e5f-8a9b-${String(sequence).padStart(12, "0")}`;
};

// v1 of the issue, with rows already stored.
class EntryV1 extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text })),
	{ name: "Entry" },
) {}

describe("upcast on read", () => {
	test("a required key with fill is filled on read; the other rows are read as they are", async () => {
		const provider = inMemoryProvider();
		class Entry extends entityOf(
			blueprintOf((ctx) => ({
				title: ctx.text,
				locale: ctx.enumOf(["pt", "en"]).with({ fill: "pt" }),
			})),
			{ name: "Entry" },
		) {}
		const Entries = repositoryOf({
			entity: Entry,
			actions: ["findMany", "findById", "create"],
			provider,
		});
		const id = idOf();
		await provider.insert(contextOf(EntryV1, "Entry"), {
			id,
			createdAt,
			title: "Olá",
		});
		const [entry] = await Entries.findMany();
		expect(entry?.toJSON()).toMatchObject({ id, title: "Olá", locale: "pt" });
		// Without schemaVersion, writes store no version key.
		const created = await Entries.create({ title: "Hi", locale: "en" });
		const [stored] = await provider.findMany(contextOf(Entry, "Entry"), {
			where: { id: created.id },
		});
		expect(stored).not.toHaveProperty(SCHEMA_VERSION_KEY);
	});

	test("without fill, a new required key still fails as before", async () => {
		const provider = inMemoryProvider();
		class Entry extends entityOf(
			blueprintOf((ctx) => ({
				title: ctx.text,
				locale: ctx.enumOf(["pt", "en"]),
			})),
			{ name: "Entry" },
		) {}
		const Entries = repositoryOf({
			entity: Entry,
			actions: ["findMany"],
			provider,
		});
		await provider.insert(contextOf(EntryV1, "Entry"), {
			id: idOf(),
			createdAt,
			title: "Olá",
		});
		expect(Entries.findMany()).rejects.toBeInstanceOf(InvalidRepositoryData);
	});

	test("upgrade steps run from the stored version, then the automatic steps; writes store the version", async () => {
		const provider = inMemoryProvider();
		const calls: string[] = [];
		class Entry extends entityOf(
			blueprintOf((ctx) => ({
				title: ctx.text.with({ renamedFrom: "name" }),
				slug: ctx.text,
				tags: listOf(ctx.text),
				locale: ctx.enumOf(["pt", "en"]).with({ fill: "pt" }),
			})),
			{
				name: "Entry",
				schemaVersion: 3,
				upgrade: {
					2: (data) => {
						calls.push(`2:${Object.keys(data).sort().join(",")}`);
						return { ...data, slug: data.path };
					},
					3: (data) => {
						calls.push("3");
						return {
							...data,
							tags: String(data.tags ?? "")
								.split(",")
								.filter(Boolean),
						};
					},
				},
			},
		) {}
		const Entries = repositoryOf({
			entity: Entry,
			actions: ["findMany", "update", "create"],
			provider,
		});
		const raw = contextOf(Entry, "Entry");
		const v1 = idOf();
		const v2 = idOf();
		await provider.insert(raw, {
			id: v1,
			createdAt,
			name: "One",
			path: "one",
			tags: "a,b",
		});
		await provider.insert(raw, {
			id: v2,
			createdAt,
			[SCHEMA_VERSION_KEY]: 2,
			title: "Two",
			slug: "two",
			path: "old",
			tags: "c",
		});
		const entries = await Entries.findMany({
			orderBy: [{ key: "id", direction: "asc" }],
		});
		expect(entries.map((entry) => entry.toJSON())).toEqual([
			expect.objectContaining({
				id: v1,
				title: "One",
				slug: "one",
				tags: ["a", "b"],
				locale: "pt",
			}),
			expect.objectContaining({
				id: v2,
				title: "Two",
				slug: "two",
				tags: ["c"],
				locale: "pt",
			}),
		]);
		// The step of 2 got the stored data of v1, the version key left out.
		expect(calls).toEqual(["2:createdAt,id,name,path,tags", "3", "3"]);
		await Entries.update(entries[0] as Entry);
		const [stored] = await provider.findMany(raw, { where: { id: v1 } });
		expect(stored?.[SCHEMA_VERSION_KEY]).toBe(3);
		expect(stored).not.toHaveProperty("name");
		expect(stored).not.toHaveProperty("path");
		const created = await Entries.create({
			title: "New",
			slug: "new",
			tags: [],
			locale: "en",
		});
		const [fresh] = await provider.findMany(raw, {
			where: { id: created.id },
		});
		expect(fresh?.[SCHEMA_VERSION_KEY]).toBe(3);
	});

	test("nested blueprints, records and lists are brought up too", async () => {
		const provider = inMemoryProvider();
		class Entry extends entityOf(
			blueprintOf((ctx) => ({
				title: ctx.text,
				meta: blueprintOf((ctx) => ({
					lang: ctx.text.with({ fill: "pt" }),
					label: ctx.text.with({ renamedFrom: "caption" }),
				})),
				blocks: listOf(
					blueprintOf((ctx) => ({ kind: ctx.text.with({ fill: "p" }) })),
				),
			})),
			{ name: "Entry" },
		) {}
		const Entries = repositoryOf({
			entity: Entry,
			actions: ["findMany"],
			provider,
		});
		await provider.insert(contextOf(Entry, "Entry"), {
			id: idOf(),
			createdAt,
			title: "x",
			gone: true,
			meta: { caption: "c", old: 1 },
			blocks: [{}, { kind: "h1", stale: 2 }],
		});
		const [entry] = await Entries.findMany();
		expect(entry?.toJSON()).toMatchObject({
			title: "x",
			meta: { lang: "pt", label: "c" },
			blocks: [{ kind: "p" }, { kind: "h1" }],
		});
		expect(entry?.toJSON()).not.toHaveProperty("gone");
	});

	test("related entities are brought up when loaded", async () => {
		const provider = inMemoryProvider();
		class Author extends entityOf(
			blueprintOf((ctx) => ({
				name: ctx.text,
				bio: ctx.text.with({ fill: "none" }),
			})),
			{ name: "Author" },
		) {}
		class Post extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.text, author: Author })),
			{ name: "Post" },
		) {}
		const Authors = repositoryOf({
			entity: Author,
			actions: ["findById"],
			provider,
		});
		const Posts = repositoryOf({
			entity: Post,
			actions: ["findMany"],
			provider,
			relations: [Authors],
		});
		const author = idOf();
		await provider.insert(contextOf(Author, "Author"), {
			id: author,
			createdAt,
			name: "Ana",
		});
		await provider.insert(contextOf(Post, "Post"), {
			id: idOf(),
			createdAt,
			title: "x",
			author,
		});
		const [post] = await Posts.findMany();
		expect(post?.author.bio).toBe("none");
	});

	test("a row stored by a newer version is rejected", async () => {
		const provider = inMemoryProvider();
		class Entry extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.text })),
			{ name: "Entry", schemaVersion: 2 },
		) {}
		const Entries = repositoryOf({
			entity: Entry,
			actions: ["findMany"],
			provider,
		});
		await provider.insert(contextOf(Entry, "Entry"), {
			id: idOf(),
			createdAt,
			title: "x",
			[SCHEMA_VERSION_KEY]: 3,
		});
		const error = await Entries.findMany().catch((error: unknown) => error);
		expect(error).toBeInstanceOf(InvalidRepositoryData);
		expect((error as Exception).is(InvalidStoredSchemaVersion)).toBe(true);
	});
});

describe("entityOf schema options", () => {
	const blueprint = blueprintOf((ctx) => ({ title: ctx.text }));

	test("rejects an invalid schemaVersion, upgrade or previousNames", () => {
		expect(() => entityOf(blueprint, { schemaVersion: 0 })).toThrow(
			InvalidEntitySchemaVersion,
		);
		expect(() => entityOf(blueprint, { schemaVersion: 1.5 })).toThrow(
			InvalidEntitySchemaVersion,
		);
		expect(() =>
			entityOf(blueprint, { schemaVersion: 2, upgrade: { 3: (d) => d } }),
		).toThrow(InvalidEntitySchemaVersion);
		expect(() =>
			entityOf(blueprint, { schemaVersion: 2, upgrade: { 1: (d) => d } }),
		).toThrow(InvalidEntitySchemaVersion);
		expect(() =>
			entityOf(blueprint, {
				schemaVersion: 2,
				upgrade: { 2: "x" as never },
			}),
		).toThrow(InvalidEntitySchemaVersion);
		expect(() =>
			entityOf(blueprint, { name: "Entry", previousNames: ["Entry"] }),
		).toThrow(InvalidEntitySchemaVersion);
		expect(() =>
			entityOf(blueprint, { name: "Entry", previousNames: ["not a name"] }),
		).toThrow(InvalidEntitySchemaVersion);
	});

	test("$v is a reserved key only for an entity with a schemaVersion", () => {
		const withKey = blueprintOf((ctx) => ({ $v: ctx.text }));
		expect(() => entityOf(withKey, { schemaVersion: 1 })).toThrow(
			ReservedEntityKey,
		);
		expect(() => entityOf(withKey)).not.toThrow();
	});
});

/** The issue scenario, end to end: v1 rows, v2 with fill and a step, a rename. */
describe("app.migrate", () => {
	async function seeded() {
		const provider = inMemoryProvider();
		const raw = contextOf(EntryV1, "Entry");
		const ids = [idOf(), idOf(), idOf()];
		for (const [index, id] of ids.entries()) {
			await provider.insert(raw, {
				id,
				createdAt,
				title: `Entry ${index}`,
				...(index === 2 ? { draft: true } : {}),
			});
		}
		return { provider, raw, ids };
	}

	class Entry extends entityOf(
		blueprintOf((ctx) => ({
			title: ctx.text,
			slug: ctx.slug,
			locale: ctx.enumOf(["pt", "en"]).with({ fill: "pt" }),
		})),
		{
			name: "Entry",
			schemaVersion: 2,
			upgrade: {
				2: (data) => ({
					...data,
					slug: String(data.title).toLowerCase().replaceAll(" ", "-"),
				}),
			},
		},
	) {}
	const Entries = repositoryOf({
		entity: Entry,
		actions: ["findMany", "create"],
	});

	test("check reports, apply rewrites, a second apply finds everything up to date", async () => {
		const { provider, raw, ids } = await seeded();
		const app = applicationOf({
			name: "cms",
			entities: { Entry },
			repositories: { Entries },
			provider,
		});
		// Reads work before any backfill.
		expect(
			(await app.repositories.Entries.findMany()).map((e) => e.slug),
		).toEqual(["entry-0", "entry-1", "entry-2"]);

		const check = await app.migrate({ mode: "check", pageSize: 2 });
		expect(check).toEqual({
			mode: "check",
			destructive: false,
			entities: {
				Entry: {
					scanned: 3,
					upToDate: 0,
					upgraded: 3,
					removalPending: 0,
					invalid: [],
					movedFromPreviousNames: 0,
					removedKeys: ["draft"],
				},
			},
		});
		// check writes nothing.
		const [first] = await provider.findMany(raw, { where: { id: ids[0] } });
		expect(first).not.toHaveProperty(SCHEMA_VERSION_KEY);

		const applied = await app.migrate({ mode: "apply", pageSize: 2 });
		expect(applied.entities.Entry?.upgraded).toBe(3);
		const rows = await provider.findMany(raw, {
			orderBy: [{ key: "id", direction: "asc" }],
		});
		expect(rows.map((row) => row[SCHEMA_VERSION_KEY])).toEqual([2, 2, 2]);
		expect(rows[0]).toMatchObject({ slug: "entry-0", locale: "pt" });
		// Not destructive: the undeclared key stays stored.
		expect(rows[2]).toHaveProperty("draft", true);

		const again = await app.migrate({ mode: "apply" });
		expect(again.entities.Entry).toMatchObject({
			scanned: 3,
			upToDate: 2,
			upgraded: 0,
			removalPending: 1,
		});

		const destructive = await app.migrate({
			mode: "apply",
			destructive: true,
		});
		expect(destructive.entities.Entry?.upgraded).toBe(1);
		const [last] = await provider.findMany(raw, { where: { id: ids[2] } });
		expect(last).not.toHaveProperty("draft");
		const done = await app.migrate({ mode: "check" });
		expect(done.entities.Entry?.upToDate).toBe(3);
	});

	test("lists invalid rows and leaves them as they are", async () => {
		const { provider, raw, ids } = await seeded();
		await provider.update(raw, {
			id: ids[1] as string,
			createdAt,
			title: "",
		});
		class Strict extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.text.with({ min: 1 }) })),
			{ name: "Entry", schemaVersion: 2 },
		) {}
		const app = applicationOf({
			name: "cms",
			entities: { Entry: Strict },
			repositories: {
				Entries: repositoryOf({ entity: Strict, actions: ["findMany"] }),
			},
			provider,
		});
		const report = await app.migrate({ mode: "apply" });
		expect(report.entities.Entry?.invalid.map((row) => row.id)).toEqual([
			ids[1] as string,
		]);
		expect(report.entities.Entry?.invalid[0]?.issues[0]?.path).toEqual([
			"title",
		]);
		const [kept] = await provider.findMany(raw, { where: { id: ids[1] } });
		expect(kept).not.toHaveProperty(SCHEMA_VERSION_KEY);
	});

	test("moves the rows of a previous name, and removes them only when destructive", async () => {
		const { provider, ids } = await seeded();
		class Article extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.text })),
			{ name: "Article", previousNames: ["Entry"] },
		) {}
		const app = applicationOf({
			name: "cms",
			entities: { Article },
			repositories: {
				Articles: repositoryOf({ entity: Article, actions: ["findMany"] }),
			},
			provider,
		});
		const old = contextOf(Article, "Entry");
		const current = contextOf(Article, "Article");
		const check = await app.migrate({ mode: "check" });
		expect(check.entities.Article?.movedFromPreviousNames).toBe(3);
		expect(await provider.count(current)).toBe(0);

		const applied = await app.migrate({ mode: "apply" });
		expect(applied.entities.Article?.movedFromPreviousNames).toBe(3);
		expect(await provider.count(current)).toBe(3);
		expect(await provider.count(old)).toBe(3);
		expect(
			(await app.repositories.Articles.findMany()).map((a) => a.id).sort(),
		).toEqual([...ids].sort());

		// Resumed: nothing moves twice.
		const again = await app.migrate({ mode: "apply" });
		expect(again.entities.Article?.movedFromPreviousNames).toBe(0);

		await app.migrate({ mode: "apply", destructive: true, pageSize: 1 });
		expect(await provider.count(old)).toBe(0);
		expect(await provider.count(current)).toBe(3);
	});

	test("a previous name equal to the record name of the class is rejected, and its rows survive", async () => {
		const provider = inMemoryProvider();
		// No `name`: the record name is the name of the class, "Post".
		class Post extends entityOf(blueprintOf((ctx) => ({ title: ctx.text })), {
			previousNames: ["Post"],
		}) {}
		const raw = contextOf(Post, "Post");
		for (const title of ["a", "b"]) {
			await provider.insert(raw, { id: idOf(), createdAt, title });
		}
		let error: unknown;
		try {
			const app = applicationOf({
				name: "cms",
				entities: { Post },
				repositories: {
					Posts: repositoryOf({ entity: Post, actions: ["findMany"], provider }),
				},
			});
			await app.migrate({ mode: "apply", destructive: true });
		} catch (caught) {
			error = caught;
		}
		expect(error instanceof InvalidEntitySchemaVersion).toBe(true);
		expect(await provider.count(raw)).toBe(2);
	});

	test("in apply, gives each provider the plan of its entity", async () => {
		const plans: unknown[] = [];
		const { provider } = await seeded();
		const recording = {
			...provider,
			capabilities: provider.capabilities,
			async migrate(context: RepositoryContext, plan: unknown) {
				plans.push([context.name, context.schema, plan]);
			},
		};
		const v1 = applicationOf({
			name: "cms",
			entities: { Entry: EntryV1 },
			repositories: {
				Entries: repositoryOf({ entity: EntryV1, actions: ["findMany"] }),
			},
		});
		const lock = schemaLockOf(v1.describe());
		const app = applicationOf({
			name: "cms",
			entities: { Entry },
			repositories: { Entries },
			provider: recording,
		});
		await app.migrate({ mode: "check", lock });
		expect(plans).toEqual([]);
		await app.migrate({ mode: "apply", lock });
		expect(plans).toEqual([
			[
				"EntryRepository",
				{ version: 2, key: "$v", previousNames: [] },
				{
					entity: "Entry",
					destructive: false,
					changes: diffSchemas(lock, schemaLockOf(app.describe())),
				},
			],
		]);
		await app.migrate({ mode: "apply" });
		expect((plans[1] as unknown[])[2]).toEqual({
			entity: "Entry",
			destructive: false,
			changes: [],
		});
	});

	test("rewrites a versioned entity at the version it read, which it keeps", async () => {
		const provider = inMemoryProvider();
		class Doc extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.text.with({ fill: "untitled" }) })),
			{ name: "Doc", versioned: true, schemaVersion: 2 },
		) {}
		const raw = contextOf(Doc, "Doc");
		const id = idOf();
		await provider.insert(raw, { id, createdAt, version: 4 });
		const app = applicationOf({
			name: "docs",
			entities: { Doc },
			repositories: {
				Docs: repositoryOf({ entity: Doc, actions: ["findMany"] }),
			},
			provider,
		});
		const report = await app.migrate({ mode: "apply" });
		expect(report.entities.Doc?.upgraded).toBe(1);
		const [stored] = await provider.findMany(raw, { where: { id } });
		expect(stored).toMatchObject({
			title: "untitled",
			version: 4,
			[SCHEMA_VERSION_KEY]: 2,
		});
	});

	test("rejects invalid options", async () => {
		const app = applicationOf({
			name: "cms",
			entities: { Entry },
			repositories: { Entries },
		});
		for (const options of [
			{ mode: "run" },
			{ mode: "check", pageSize: 0 },
			{ mode: "check", entities: ["Missing"] },
			{ mode: "check", lock: {} },
		]) {
			expect(app.migrate(options as never)).rejects.toThrow();
		}
	});
});

test("the scenario of #28, end to end", async () => {
	const provider = inMemoryProvider();
	const appOf = (entity: object, previous?: boolean) =>
		applicationOf({
			name: "cms",
			entities: { [previous ? "Article" : "Entry"]: entity },
			repositories: {
				Entries: repositoryOf({
					entity: entity as typeof EntryV1,
					actions: ["findMany", "create"],
				}),
			},
			provider,
		} as never) as unknown as {
			describe(): never;
			start(options: object): Promise<unknown>;
			stop(): Promise<void>;
			migrate(options: object): Promise<{
				entities: Record<string, Record<string, unknown>>;
			}>;
			repositories: {
				Entries: {
					findMany(): Promise<{ toJSON(): Record<string, unknown> }[]>;
					create(input: object): Promise<unknown>;
				};
			};
		};

	// v1, with rows written by its repository, and its lock committed.
	const v1 = appOf(EntryV1);
	await v1.repositories.Entries.create({ title: "Olá" });
	await v1.repositories.Entries.create({ title: "Hello" });
	const lock = schemaLockOf(v1.describe());

	// v2: a required locale with a fill, and a slug from an upgrade step.
	class EntryV2 extends entityOf(
		blueprintOf((ctx) => ({
			title: ctx.text,
			slug: ctx.slug,
			locale: ctx.enumOf(["pt", "en"]).with({ fill: "pt" }),
		})),
		{
			name: "Entry",
			schemaVersion: 2,
			upgrade: {
				2: (data) => ({
					...data,
					slug: String(data.title)
						.toLowerCase()
						.replace(/[^a-z]/g, "x"),
				}),
			},
		},
	) {}
	const v2 = appOf(EntryV2);
	await v2.start({ register: false, lock });
	const read = await v2.repositories.Entries.findMany();
	expect(read.map((entry) => entry.toJSON().locale)).toEqual(["pt", "pt"]);
	expect(read.map((entry) => entry.toJSON().slug)).toEqual(["olx", "hello"]);
	const changes = diffSchemas(lock, schemaLockOf(v2.describe()));
	expect(changes.every((change) => change.satisfied)).toBe(true);
	expect((await v2.migrate({ mode: "check" })).entities.Entry?.upgraded).toBe(
		2,
	);
	await v2.migrate({ mode: "apply", lock });
	expect((await v2.migrate({ mode: "check" })).entities.Entry?.upToDate).toBe(
		2,
	);
	await v2.stop();
	const lock2 = schemaLockOf(v2.describe());

	// v3: renamed to Article; without previousNames start fails.
	class Lost extends entityOf(
		blueprintOf((ctx) => ({
			title: ctx.text,
			slug: ctx.slug,
			locale: ctx.enumOf(["pt", "en"]),
		})),
		{ name: "Article", schemaVersion: 2 },
	) {}
	expect(
		appOf(Lost, true).start({ register: false, lock: lock2 }),
	).rejects.toBeInstanceOf(SchemaLockMismatch);
	class Article extends entityOf(
		blueprintOf((ctx) => ({
			title: ctx.text,
			slug: ctx.slug,
			locale: ctx.enumOf(["pt", "en"]),
		})),
		{ name: "Article", schemaVersion: 2, previousNames: ["Entry"] },
	) {}
	const v3 = appOf(Article, true);
	await v3.start({ register: false, lock: lock2 });
	const moved = await v3.migrate({ mode: "apply", destructive: true });
	expect(moved.entities.Article?.movedFromPreviousNames).toBe(2);
	expect(
		(await v3.repositories.Entries.findMany()).map((a) => a.toJSON().title),
	).toEqual(["Olá", "Hello"]);
	await v3.stop();
});

describe("app.start({ lock })", () => {
	const v1 = applicationOf({
		name: "cms",
		entities: { Entry: EntryV1 },
		repositories: {
			Entries: repositoryOf({ entity: EntryV1, actions: ["findMany"] }),
		},
	});
	const lock = schemaLockOf(v1.describe());

	test("fails when an entity of the lock is renamed without previousNames", async () => {
		class Article extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.text })),
			{ name: "Article" },
		) {}
		const app = applicationOf({ name: "cms", entities: { Article } });
		expect(app.start({ register: false, lock })).rejects.toBeInstanceOf(
			SchemaLockMismatch,
		);
		class Renamed extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.text })),
			{ name: "Article", previousNames: ["Entry"] },
		) {}
		const renamed = applicationOf({
			name: "cms",
			entities: { Article: Renamed },
		});
		await renamed.start({ register: false, lock });
		await renamed.stop();
	});

	test("fails when the code's schemaVersion is lower than the lock's", async () => {
		class V3 extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.text })),
			{
				name: "Entry",
				schemaVersion: 3,
			},
		) {}
		const locked = schemaLockOf(
			applicationOf({ name: "cms", entities: { Entry: V3 } }).describe(),
		);
		class V2 extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.text })),
			{
				name: "Entry",
				schemaVersion: 2,
			},
		) {}
		const app = applicationOf({ name: "cms", entities: { Entry: V2 } });
		const error = await app
			.start({ register: false, lock: locked })
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(SchemaLockMismatch);
		expect(
			(error as { details: { problems: string[] } }).details.problems,
		).toEqual([
			'The schemaVersion of "Entry" (2) is lower than the lock\'s (3).',
		]);
	});
});

// Keeps the helper types honest.
export type { RepositoryData };
