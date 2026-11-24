import { afterEach, describe, expect, test } from "bun:test";
import type { IRepositoryProvider } from "../adapters";
import {
	ApplicationNotStarted,
	applicationOf,
	blueprintOf,
	entityOf,
	environmentOf,
	InvalidApplicationDeclaration,
	inMemoryProvider,
	providerFrom,
	providersOf,
	RepositoryWrittenOutsideApplication,
	repositoryOf,
	resetApplication,
	Serial,
	serviceOf,
	useApplication,
	useCaseOf,
} from "../index";
import { testApplicationOf } from "./application";
import { manualClock } from "./clock";
import { spyProvider } from "./spy";

const Name = blueprintOf((ctx) => ({ name: ctx.string }));
class Post extends entityOf(Name) {}
class Audit extends entityOf(Name) {}
class Draft extends entityOf(Name) {}
class Ticket extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.string })),
	{
		id: Serial,
	},
) {}

const Database = environmentOf(
	blueprintOf((ctx) => ({ DATABASE_URL: ctx.url })),
	{ source: () => ({ DATABASE_URL: "memory://main" }) },
);

/** A provider that must never be made in a test: the real database. */
const made: string[] = [];
const real = (key: string) =>
	providerFrom(() => {
		made.push(key);
		return inMemoryProvider();
	});

const Storage = providersOf({ main: real("main"), audit: real("audit") });

const Posts = repositoryOf({
	entity: Post,
	actions: ["create", "count", "findMany"],
	provider: Storage.main,
});
const Audits = repositoryOf({
	entity: Audit,
	actions: ["create", "count"],
	provider: Storage.audit,
});
/** A repository that declares a provider of its own. */
const ownProvider = inMemoryProvider();
const Drafts = repositoryOf({
	entity: Draft,
	actions: ["create", "count"],
	provider: ownProvider,
});
const Tickets = repositoryOf({ entity: Ticket, actions: ["create", "count"] });

const Mailer = serviceOf<{ send(to: string): string }>("mailer");
class Publish extends useCaseOf({
	name: "Publish",
	blueprint: Name,
	response: blueprintOf((ctx) => ({ mail: ctx.string, posts: ctx.integer })),
	dependencies: { posts: Posts, audits: Audits, mailer: Mailer },
}) {
	override async execute() {
		const { posts, audits, mailer } = this.dependencies;
		await posts.create(new Post({ name: this.input.name }));
		await audits.create(new Audit({ name: `published ${this.input.name}` }));
		return { mail: mailer.send(this.input.name), posts: await posts.count() };
	}
}

const Blog = applicationOf({
	name: "blog",
	entities: { Post, Audit, Draft, Ticket },
	environments: { Database },
	repositories: { Posts, Audits, Drafts, Tickets },
	useCases: { Publish },
	providers: Storage,
	provider: providerFrom(() => {
		made.push("default");
		return inMemoryProvider();
	}),
	services: { mailer: () => ({ send: (to: string) => `real mail to ${to}` }) },
});

afterEach(() => {
	resetApplication();
	made.length = 0;
});

describe("testApplicationOf", () => {
	test("gives each call its own data, started, through every provider", async () => {
		await using first = await testApplicationOf(Blog);
		await using second = await testApplicationOf(Blog);
		expect(first.started).toBe(true);
		expect(await first.run(Publish, { name: "a" })).toEqual({
			mail: "real mail to a",
			posts: 1,
		});
		await first.repositories.Drafts.create(new Draft({ name: "d" }));
		await first.repositories.Tickets.create(new Ticket({ title: "t" }));

		expect(await second.repositories.Posts.count()).toBe(0);
		expect(await second.repositories.Audits.count()).toBe(0);
		expect(await second.repositories.Drafts.count()).toBe(0);
		expect(await second.repositories.Tickets.count()).toBe(0);
		// The providers the application declares are never made, and the one
		// a repository declares is left alone.
		expect(made).toEqual([]);
		const countOf = (provider: IRepositoryProvider, entity: typeof Draft) =>
			repositoryOf({ entity, actions: ["count"], provider }).count();
		expect(await countOf(ownProvider, Draft)).toBe(0);
		expect(await countOf(first.provider, Draft)).toBe(1);
	});

	test("stops with await using, also when the test throws", async () => {
		let held: Awaited<ReturnType<typeof testApplicationOf<typeof Blog>>>;
		const run = async () => {
			await using app = await testApplicationOf(Blog);
			held = app;
			throw new Error("an assertion failed");
		};
		await expect(run()).rejects.toThrow("an assertion failed");
		// biome-ignore lint/style/noNonNullAssertion: set by run
		expect(held!.started).toBe(false);
	});

	test("does not become the application of the process", async () => {
		await using app = await testApplicationOf(Blog);
		expect(app.started).toBe(true);
		expect(() => useApplication()).toThrow(ApplicationNotStarted);
	});

	test("inserts the fixtures of seed, and stops when seed throws", async () => {
		await using app = await testApplicationOf(Blog, {
			seed: async (app) => {
				await app.repositories.Posts.create(new Post({ name: "seeded" }));
			},
		});
		expect(await app.repositories.Posts.count()).toBe(1);

		let seeded: { readonly started: boolean } | undefined;
		await expect(
			testApplicationOf(Blog, {
				seed: (app) => {
					seeded = app;
					throw new Error("bad fixture");
				},
			}),
		).rejects.toThrow("bad fixture");
		expect(seeded?.started).toBe(false);
	});

	test("takes a provider and a runtime", async () => {
		const spy = spyProvider(inMemoryProvider());
		const clock = manualClock("2026-01-02T03:04:05.000Z");
		await using app = await testApplicationOf(Blog, {
			provider: spy,
			runtime: { clock },
		});
		expect(app.provider).toBe(spy);
		await app.run(Publish, { name: "a" });
		const [post] = await app.repositories.Posts.findMany();
		expect(post?.createdAt).toBe("2026-01-02T03:04:05.000Z");
		expect(spy.calls("Post", "insert")).toHaveLength(1);
	});

	test("composes with app.with", async () => {
		const sent: string[] = [];
		await using app = await testApplicationOf(
			Blog.with({
				services: {
					mailer: () => ({
						send: (to: string) => {
							sent.push(to);
							return `fake mail to ${to}`;
						},
					}),
				},
			}),
		);
		expect(await app.run(Publish, { name: "ana" })).toEqual({
			mail: "fake mail to ana",
			posts: 1,
		});
		expect(sent).toEqual(["ana"]);
		expect(made).toEqual([]);
	});

	test("an application extending it keeps its provider", async () => {
		await using app = await testApplicationOf(Blog);
		await app.repositories.Posts.create(new Post({ name: "a" }));
		const extended = app.extend();
		expect(extended.provider).toBe(app.provider);
		expect(await extended.repositories.Posts.count()).toBe(1);
		expect(await extended.repositories.Audits.count()).toBe(0);
	});

	test("app.provider.clear() empties it between the steps of a test", async () => {
		await using app = await testApplicationOf(Blog);
		await app.repositories.Posts.create(new Post({ name: "a" }));
		await app.provider.clear();
		expect(await app.repositories.Posts.count()).toBe(0);
	});

	test("rejects what is not an application, and options of the wrong kind", async () => {
		await expect(testApplicationOf({} as never)).rejects.toThrow(
			InvalidApplicationDeclaration,
		);
		await expect(
			testApplicationOf(Blog, { provider: 1 as never }),
		).rejects.toThrow(InvalidApplicationDeclaration);
		await expect(
			testApplicationOf(Blog, { seed: "fixtures" as never }),
		).rejects.toThrow(InvalidApplicationDeclaration);
		await expect(
			testApplicationOf(Blog, { strict: "yes" as never }),
		).rejects.toThrow(InvalidApplicationDeclaration);
	});
});

describe("strict mode", () => {
	class Note extends entityOf(Name) {}
	/** Not registered in the application: it writes to a store of the process. */
	const Notes = repositoryOf({ entity: Note, actions: ["create", "count"] });

	test("rejects a write through a repository no application bound, while it runs", async () => {
		{
			await using app = await testApplicationOf(Blog, { strict: true });
			const error = await Notes.create(new Note({ name: "leak" })).catch(
				(caught) => caught,
			);
			expect(error).toBeInstanceOf(RepositoryWrittenOutsideApplication);
			expect(error.message).toContain('"blog"');
			// Reads are left alone, and the repositories of the application work.
			expect(await Notes.count()).toBe(0);
			await app.repositories.Posts.create(new Post({ name: "a" }));
		}
		// Once it stopped, the module-level repository writes again.
		await Notes.create(new Note({ name: "after" }));
		expect(await Notes.count()).toBe(1);
	});

	test("is off by default", async () => {
		class Memo extends entityOf(Name) {}
		const Memos = repositoryOf({ entity: Memo, actions: ["create"] });
		await using _app = await testApplicationOf(Blog);
		await Memos.create(new Memo({ name: "kept" }));
	});
});
