import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	entityOf,
	InvalidRepositoryDeclaration,
	InvalidRepositoryQuery,
	type IRepositoryProvider,
	inMemoryProvider,
	memoryLogProvider,
	type ProviderQuery,
	providerOf,
	RepositoryOf,
	type RepositoryPlan,
	RepositoryUsedOutsideApplication,
	repositoryOf,
	useCaseOf,
} from "../../index";
import { planQuery } from "./plan";

class Entry extends entityOf(
	blueprintOf((ctx) => ({
		slug: ctx.slug,
		type: ctx.string,
		status: ctx.enumOf(["draft", "published"]),
		owner: ctx.string,
		publishedAt: ctx.optional.integer,
		secret: ctx.optional.string,
		meta: blueprintOf((ctx) => ({ lang: ctx.string })),
	})),
	{ sensitive: ["secret"] },
) {}

const INDEXES = {
	byTypeStatus: { where: ["type", "status"], orderBy: "publishedAt" },
	byOwner: { where: ["owner"] },
} as const;

const entry = (overrides: Record<string, unknown> = {}) => ({
	slug: `e-${Math.random().toString(36).slice(2, 8)}`,
	type: "post",
	status: "published" as const,
	owner: "ana",
	publishedAt: 1,
	meta: { lang: "en" },
	...overrides,
});

/** A provider recording the queries it gets, over the in-memory one. */
function recording() {
	const memory = inMemoryProvider();
	const queries: { method: string; query: ProviderQuery | undefined }[] = [];
	const contexts: unknown[] = [];
	const provider: IRepositoryProvider = {
		...memory,
		capabilities: memory.capabilities,
		findOne: (context, query) => {
			queries.push({ method: "findOne", query });
			return memory.findOne(context, query);
		},
		findMany: (context, query) => {
			queries.push({ method: "findMany", query });
			contexts.push(context.indexes);
			return memory.findMany(context, query);
		},
		count: (context, query) => {
			queries.push({ method: "count", query });
			return memory.count(context, query);
		},
	};
	return { provider, queries, contexts };
}

describe("planQuery", () => {
	const repository = {
		unique: ["id", "slug"],
		indexes: {
			byType: { where: ["type"] },
			byTypeStatus: { where: ["type", "status"], orderBy: "publishedAt" },
			byStatusDate: { where: ["status"], orderBy: "publishedAt" },
		},
	};
	const plan = (query: Parameters<typeof planQuery>[1]) =>
		planQuery(repository, query);

	test("id and unique keys, by equality or in", () => {
		expect(plan({ where: { id: "1", type: "a" } })).toEqual({ access: "id" });
		expect(plan({ where: { id: { in: ["1", "2"] } } })).toEqual({
			access: "id",
		});
		expect(plan({ where: { slug: "a" } })).toEqual({ access: "unique" });
	});

	test("an index whose keys are all held by equality", () => {
		expect(plan({ where: { type: "a" } })).toEqual({
			access: "index",
			index: "byType",
		});
		// The one with the most keys wins.
		expect(plan({ where: { type: "a", status: "draft" } })).toEqual({
			access: "index",
			index: "byTypeStatus",
		});
		// Extra conditions are filtered after the index.
		expect(plan({ where: { type: "a", owner: "x" } })).toEqual({
			access: "index",
			index: "byType",
		});
	});

	test("the first order must be the order of the index", () => {
		expect(
			plan({
				where: { type: "a", status: "draft" },
				orderBy: [{ key: "publishedAt", direction: "desc" }],
			}),
		).toEqual({ access: "index", index: "byTypeStatus" });
		expect(
			plan({ where: { type: "a" }, orderBy: [{ key: "publishedAt" }] }),
		).toEqual({ access: "scan" });
		expect(
			plan({ where: { status: "draft" }, orderBy: [{ key: "owner" }] }),
		).toEqual({ access: "scan" });
	});

	test("in, missing keys and no where are scans", () => {
		expect(plan({ where: { type: { in: ["a", "b"] } } })).toEqual({
			access: "scan",
		});
		expect(plan({ where: { status: "draft" } })).toEqual({
			access: "index",
			index: "byStatusDate",
		});
		expect(plan({ where: { owner: "x" } })).toEqual({ access: "scan" });
		expect(plan({})).toEqual({ access: "scan" });
		expect(planQuery({ unique: ["id"] }, { where: { a: 1 } })).toEqual({
			access: "scan",
		});
	});
});

describe("declared indexes", () => {
	const declare =
		(indexes: unknown, extra: object = {}) =>
		() =>
			repositoryOf({
				entity: Entry,
				actions: ["findMany"],
				indexes: indexes as never,
				...extra,
			});
	const reason = (run: () => unknown) => {
		try {
			run();
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidRepositoryDeclaration);
			return (error as Error).message;
		}
		throw new Error("expected a throw");
	};

	test("are normalized, frozen and given to the provider", async () => {
		const { provider, contexts, queries } = recording();
		const Entries = repositoryOf({
			entity: Entry,
			actions: ["create", "findMany"],
			provider,
			indexes: INDEXES,
		});
		await Entries.findMany({ where: { owner: "ana" } });
		const [indexes] = contexts as [Record<string, unknown>];
		expect(indexes).toEqual({
			byTypeStatus: { where: ["type", "status"], orderBy: "publishedAt" },
			byOwner: { where: ["owner"] },
		});
		expect(Object.isFrozen(indexes)).toBe(true);
		expect(Object.isFrozen(indexes.byOwner)).toBe(true);
		expect(queries.at(-1)?.query?.index).toBe("byOwner");
	});

	test("are typed by the keys of the entity", () => {
		() => {
			repositoryOf({
				entity: Entry,
				actions: ["findMany"],
				// @ts-expect-error not a key of Entry
				indexes: { bad: { where: ["nope"] } },
			});
			repositoryOf({
				entity: Entry,
				actions: ["findMany"],
				// @ts-expect-error not a key of Entry
				indexes: { bad: { where: ["type"], orderBy: "nope" } },
			});
		};
	});

	test("reject what cannot be an index", () => {
		expect(reason(declare({ a: { where: ["nope"] } }))).toBe(
			'The index "a" names "nope", which is not a key of Entry.',
		);
		expect(reason(declare({ a: { where: ["secret"] } }))).toBe(
			'The index "a" names "secret", which is sensitive and cannot be indexed.',
		);
		expect(reason(declare({ a: { where: ["type"], orderBy: "meta" } }))).toBe(
			'The index "a" orders by "meta", which is not scalar.',
		);
		expect(
			reason(
				declare({
					a: { where: ["type", "status"] },
					b: { where: ["status", "type"] },
				}),
			),
		).toBe('The indexes "a" and "b" are the same.');
		expect(reason(declare({ a: { where: ["type", "type"] } }))).toBe(
			'The index "a" names a key twice in where.',
		);
		for (const value of [
			{ where: [] },
			{ where: "type" },
			{ where: ["type"], extra: 1 },
			null,
		]) {
			expect(reason(declare({ a: value }))).toBe(
				'Expected the index "a" to be { where: [keys], orderBy?: key }.',
			);
		}
		expect(reason(declare([]))).toBe(
			"Expected indexes to be an object of indexes by name.",
		);
		expect(reason(declare({ "a-b": { where: ["type"] } }))).toBe(
			'Expected the index "a-b" to be named by an identifier.',
		);
		expect(reason(declare(undefined, { scans: "never" }))).toBe(
			'Expected scans to be "allow", "warn" or "reject".',
		);
	});
});

describe("query cost", () => {
	test("every read sends the index that serves it", async () => {
		const { provider, queries } = recording();
		const Entries = repositoryOf({
			entity: Entry,
			actions: [
				"create",
				"findMany",
				"findManyByOwner",
				"findPage",
				"findCursor",
				"exists",
				"count",
			],
			provider,
			indexes: INDEXES,
		});
		await Entries.create(entry());
		const where = { type: "post", status: "published" } as const;
		const orderBy = [{ key: "publishedAt", direction: "desc" }] as const;
		queries.length = 0;
		await Entries.findMany({ where, orderBy });
		await Entries.findManyByOwner("ana");
		await Entries.findPage({ where, orderBy });
		await Entries.findCursor({ where, orderBy });
		await Entries.exists({ where: { owner: "ana" } });
		await Entries.count({ where, orderBy });
		await Entries.findMany({ where: { type: "post" } });
		expect(queries.map(({ method, query }) => [method, query?.index])).toEqual([
			["findMany", "byTypeStatus"],
			["findMany", "byOwner"],
			["findMany", "byTypeStatus"],
			["count", "byTypeStatus"],
			["findMany", "byTypeStatus"],
			["findOne", "byOwner"],
			["count", "byTypeStatus"],
			["findMany", undefined],
		]);
		// The id that findCursor adds to break ties does not keep the index out.
		expect(queries[4]?.query?.orderBy?.map(({ key }) => key)).toEqual([
			"publishedAt",
			"id",
		]);
	});

	test("explain gives the plan without reading", async () => {
		const { provider, queries } = recording();
		const Entries = repositoryOf({
			entity: Entry,
			actions: ["explain"],
			provider,
			indexes: INDEXES,
			scans: "reject",
		});
		const plan: RepositoryPlan = await Entries.explain({
			where: { type: "post", status: "draft" },
			orderBy: [{ key: "publishedAt" }],
		});
		expect(plan).toEqual({ access: "index", index: "byTypeStatus" });
		expect(await Entries.explain({ where: { slug: "a" } })).toEqual({
			access: "unique",
		});
		expect(await Entries.explain()).toEqual({ access: "scan" });
		expect(await Entries.explain({ limit: 2, after: "x" })).toEqual({
			access: "scan",
		});
		expect(queries).toEqual([]);
		await expect(
			Entries.explain({ where: { nope: 1 } } as never),
		).rejects.toThrow(InvalidRepositoryQuery);
		expectTypeOf(
			Entries.explain,
		).returns.resolves.toEqualTypeOf<RepositoryPlan>();
	});

	test('scans: "reject" throws before the provider is called', async () => {
		const { provider, queries } = recording();
		const Entries = repositoryOf({
			entity: Entry,
			actions: ["create", "findById", "findMany", "count", "findCursor"],
			provider,
			indexes: INDEXES,
			scans: "reject",
		});
		const created = await Entries.create(entry());
		queries.length = 0;
		expect(await Entries.findById(created.id)).toBeDefined();
		expect(await Entries.findMany({ where: { owner: "ana" } })).toHaveLength(1);
		const error = await Entries.findMany({ where: { type: "post" } }).then(
			() => undefined,
			(error: InstanceType<typeof InvalidRepositoryQuery>) => error,
		);
		expect(error).toBeInstanceOf(InvalidRepositoryQuery);
		expect(error?.message).toBe(
			'"findMany" matches no index of EntryRepository and would read every row (scans: "reject").',
		);
		expect(error?.details).toMatchObject({
			scan: true,
			method: "findMany",
			where: ["type"],
			orderBy: [],
		});
		await expect(Entries.count()).rejects.toThrow(InvalidRepositoryQuery);
		await expect(
			Entries.findCursor({
				where: { owner: "ana" },
				orderBy: [{ key: "type" }],
			}),
		).rejects.toThrow(InvalidRepositoryQuery);
		expect(queries.map(({ method }) => method)).toEqual([
			"findOne",
			"findMany",
		]);
	});

	test('scans: "warn" logs repository-scan on the logger of the application', async () => {
		const memory = memoryLogProvider();
		const Entries = repositoryOf({
			entity: Entry,
			actions: ["create", "findMany"],
			indexes: INDEXES,
			scans: "warn",
		});
		const app = applicationOf({
			name: "cms",
			entities: { Entry },
			repositories: { Entries },
			provider: inMemoryProvider(),
			log: { providers: [memory] },
		});
		await app.repositories.Entries.create(entry());
		expect(
			await app.repositories.Entries.findMany({
				where: { type: "post" },
				orderBy: [{ key: "slug" }],
			}),
		).toHaveLength(1);
		await app.repositories.Entries.findMany({ where: { owner: "ana" } });
		const scans = memory.entries.filter(
			(line) => line.event === "repository-scan",
		);
		expect(scans).toHaveLength(1);
		expect(scans[0]?.level).toBe("warn");
		expect(scans[0]?.fields).toEqual({
			repository: "EntryRepository",
			method: "findMany",
			where: ["type"],
			orderBy: ["slug"],
		});
	});

	test("describe gives the indexes and the scan policy", () => {
		const Entries = repositoryOf({
			entity: Entry,
			actions: ["findMany"],
			indexes: INDEXES,
			scans: "warn",
		});
		const app = applicationOf({
			name: "cms",
			entities: { Entry },
			repositories: { Entries },
		});
		expect(app.describe().repositories.Entries).toMatchObject({
			indexes: {
				byTypeStatus: { where: ["type", "status"], orderBy: "publishedAt" },
				byOwner: { where: ["owner"] },
			},
			scans: "warn",
		});
	});
});

describe("findCursor and the keyset capability", () => {
	const { capabilities: _, ...base } = inMemoryProvider();
	const none = { ...base };
	const off = { ...base, capabilities: { keyset: false as const } };
	const wide: IRepositoryProvider = inMemoryProvider();
	const named = providerOf({
		name: "named",
		create: () => ({ ...inMemoryProvider(), capabilities: { keyset: true } }),
	});

	test("is kept in the type only when the provider can read by cursor", () => {
		expectTypeOf(
			repositoryOf({ entity: Entry, actions: ["findCursor"] }),
		).toHaveProperty("findCursor");
		expectTypeOf(
			repositoryOf({
				entity: Entry,
				actions: ["findCursor"],
				provider: inMemoryProvider(),
			}),
		).toHaveProperty("findCursor");
		expectTypeOf(
			repositoryOf({ entity: Entry, actions: ["findCursor"], provider: wide }),
		).toHaveProperty("findCursor");
		expectTypeOf(
			repositoryOf({ entity: Entry, actions: ["findCursor"], provider: named }),
		).toHaveProperty("findCursor");
		() => {
			const withoutKeyset = repositoryOf({
				entity: Entry,
				actions: ["findCursor", "findMany"],
				provider: none,
			});
			// @ts-expect-error the provider has no capabilities.keyset
			withoutKeyset.findCursor;
			withoutKeyset.findMany;
			const off_ = repositoryOf({
				entity: Entry,
				actions: ["findCursor"],
				provider: off,
			});
			// @ts-expect-error capabilities.keyset is false
			off_.findCursor;
		};
	});

	test("a declared provider without keyset is rejected with findCursor", () => {
		expect(() =>
			repositoryOf({ entity: Entry, actions: ["findCursor"], provider: off }),
		).toThrow(InvalidRepositoryDeclaration);
		expect(() =>
			repositoryOf({ entity: Entry, actions: ["findMany"], provider: none }),
		).not.toThrow();
	});
});

describe("module-level repositories after binding", () => {
	class Note extends entityOf(blueprintOf((ctx) => ({ text: ctx.string }))) {}
	const Input = blueprintOf((ctx) => ({ text: ctx.string }));
	const Empty = blueprintOf(() => ({}));

	test("throw once an application binds them to its provider", async () => {
		const Notes = repositoryOf({ entity: Note, actions: ["create", "count"] });
		class NotesRepository extends RepositoryOf(Notes) {}
		const extended = new NotesRepository();
		class Write extends useCaseOf({
			name: "Write",
			blueprint: Input,
			response: Empty,
			dependencies: { notes: Notes },
		}) {
			override async execute({ notes = this.dependencies.notes } = {}) {
				await notes.create(this.input);
				return {};
			}
		}
		// Before: the declaration works.
		await Notes.create({ text: "before" });
		expect(await extended.count()).toBe(1);

		const app = applicationOf({
			name: "notes",
			entities: { Note },
			repositories: { Notes },
			useCases: { Write },
			provider: inMemoryProvider(),
		});
		const error = await Notes.count().then(
			() => undefined,
			(error: Error) => error,
		);
		expect(error).toBeInstanceOf(RepositoryUsedOutsideApplication);
		expect(error?.message).toBe(
			'"NoteRepository" is bound to the application "notes", and its declaration no longer reads or writes: use app.repositories.Notes, run its use cases with app.run, or give the repository of the application to execute.',
		);
		await expect(extended.count()).rejects.toThrow(
			RepositoryUsedOutsideApplication,
		);
		// The declared use case reaches the declaration; the bound one does not.
		await expect(new Write({ text: "x" }).execute()).rejects.toThrow(
			RepositoryUsedOutsideApplication,
		);
		await app.run(Write, { text: "a" });
		await new Write({ text: "b" }).execute({ notes: app.repositories.Notes });
		expect(await app.repositories.Notes.count()).toBe(2);
		// What it exposes besides its methods still works.
		expect(Notes.actions).toEqual(["create", "count"]);
	});

	test("keep working when never bound", async () => {
		const Notes = repositoryOf({ entity: Note, actions: ["create", "count"] });
		// An application without a provider binds nothing.
		const app = applicationOf({
			name: "plain",
			entities: { Note },
			repositories: { Notes },
		});
		expect(app.repositories.Notes).toBe(Notes);
		await Notes.create({ text: "a" });
		expect(await Notes.count()).toBe(1);
	});
});
