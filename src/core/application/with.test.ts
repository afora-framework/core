import { describe, expect, test } from "bun:test";
import type { IRepositoryProvider, RepositoryContext } from "../../adapters";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	entityOf,
	environmentOf,
	type IEventPublisher,
	InvalidApplicationDeclaration,
	InvalidApplicationEnvironment,
	inMemoryProvider,
	repositoryOf,
	serviceOf,
	UnregisteredApplicationReference,
	useCaseOf,
} from "../../index";

const Mailer = serviceOf<{ send(to: string): string }>("mailer");
const Settings = environmentOf(
	blueprintOf((ctx) => ({ SENDER: ctx.email, LIMIT: ctx.integer })),
	{ source: () => ({}) },
);

class Note extends entityOf(blueprintOf((ctx) => ({ title: ctx.string }))) {}
const Notes = repositoryOf({ entity: Note, actions: ["create", "findMany"] });

const Count = useCaseOf({
	name: "CountNotes",
	blueprint: blueprintOf(() => ({})),
	response: blueprintOf((ctx) => ({ count: ctx.integer })),
	dependencies: { notes: Notes },
});
class CountNotes extends Count {
	override async execute() {
		return { count: (await this.dependencies.notes.findMany()).length };
	}
}

/** Writes a note, mails the sender of `Settings` and counts the notes, through a child. */
class Write extends useCaseOf({
	name: "Write",
	blueprint: blueprintOf((ctx) => ({ title: ctx.string })),
	response: blueprintOf((ctx) => ({
		count: ctx.integer,
		mail: ctx.string,
		limit: ctx.integer,
	})),
	dependencies: {
		notes: Notes,
		settings: Settings,
		mailer: Mailer,
		count: CountNotes,
	},
}) {
	override async execute() {
		const { notes, settings, mailer, count } = this.dependencies;
		await notes.create(new Note({ title: this.input.title }));
		return {
			count: (await count({})).count,
			mail: mailer.send(settings.SENDER),
			limit: settings.LIMIT,
		};
	}
}
/** Runs `Write` as a child: what `Write` reaches, it reaches at depth two. */
class Outer extends useCaseOf({
	name: "Outer",
	blueprint: blueprintOf((ctx) => ({ title: ctx.string })),
	response: blueprintOf((ctx) => ({
		count: ctx.integer,
		mail: ctx.string,
		limit: ctx.integer,
	})),
	dependencies: { write: Write },
}) {
	override async execute() {
		return this.dependencies.write({ title: this.input.title });
	}
}

const Notes$ = commandOf({
	name: "Notes",
	useCases: { write: Outer, count: CountNotes },
	environmentDependencies: Settings,
	events: async (_events, info) => {
		await info.publisher("bus").publish("notes", { name: "written" } as never);
	},
});

const published: string[] = [];
const bus: IEventPublisher = {
	publish: async (topic) => {
		published.push(`real:${topic}`);
	},
};

function blog() {
	return applicationOf({
		name: "blog",
		entities: { Note },
		environments: { Settings },
		repositories: { Notes },
		useCases: { CountNotes, Write, Outer },
		commands: { Notes: Notes$ },
		provider: inMemoryProvider(),
		services: {
			mailer: () => ({ send: (to: string) => `real mail to ${to}` }),
		},
		publishers: { bus },
	});
}

const replacements = {
	environments: { Settings: { SENDER: "test@example.com", LIMIT: 3 } },
	services: {
		mailer: () => ({ send: (to: string) => `fake mail to ${to}` }),
	},
};

describe("app.with", () => {
	test("replaces a service and an environment in every use case of a call, at any depth", async () => {
		const app = blog().with(replacements);
		expect(await app.run(Outer, { title: "a" })).toEqual({
			count: 1,
			mail: "fake mail to test@example.com",
			limit: 3,
		});
		const { value } = await app.command(Notes$).execute("write", {
			title: "b",
		});
		expect(value).toEqual({
			count: 2,
			mail: "fake mail to test@example.com",
			limit: 3,
		});
	});

	test("an environment replaced needs no variables to start, and context.env, get and the command see it", async () => {
		const app = blog().with(replacements);
		await app.start({ register: false });
		expect(app.context.env(Settings)).toEqual({
			SENDER: "test@example.com",
			LIMIT: 3,
		});
		expect(app.get(Settings).LIMIT).toBe(3);
		expect(app.commands.Notes.env).toEqual({
			SENDER: "test@example.com",
			LIMIT: 3,
		});
		await app.stop();
		// The original still reads its source, which has none.
		expect(() => blog().context.env(Settings)).toThrow();
	});

	test("the provider of a repository reads the replaced environment as context.env", async () => {
		const seen: unknown[] = [];
		const memory = inMemoryProvider();
		const provider: IRepositoryProvider<{
			readonly SENDER: string;
			readonly LIMIT: number;
		}> = {
			...memory,
			async count(context) {
				seen.push(context.env);
				return memory.count(context as RepositoryContext);
			},
		};
		const Counted = repositoryOf({
			entity: Note,
			actions: ["count"],
			environmentDependencies: Settings,
		});
		const app = applicationOf({
			name: "counted",
			entities: { Note },
			environments: { Settings },
			repositories: { Counted },
			provider,
		}).with({ environments: replacements.environments });
		await app.repositories.Counted.count();
		expect(seen).toEqual([{ SENDER: "test@example.com", LIMIT: 3 }]);
	});

	test("a partial repository: its methods in place of those of the repository, at any depth, and in app.repositories", async () => {
		const app = blog().with({
			...replacements,
			repositories: { Notes: { findMany: async () => [] } },
		});
		expect(await app.run(Outer, { title: "a" })).toMatchObject({ count: 0 });
		expect(await app.repositories.Notes.findMany()).toEqual([]);
		expect(app.repository(Notes)).toBe(app.repositories.Notes);
		// What it does not replace stays the repository's.
		const created = await app.repositories.Notes.create(
			new Note({ title: "kept" }),
		);
		expect(created.title).toBe("kept");
	});

	test("a use case: the function runs in place of execute, its response checked, wherever it is called", async () => {
		const app = blog().with({
			...replacements,
			useCases: { CountNotes: async () => ({ count: 42 }) },
		});
		expect(await app.run(CountNotes)).toEqual({ count: 42 });
		expect(await app.run(Outer, { title: "a" })).toMatchObject({ count: 42 });
		const { value } = await app.commands.Notes.execute("count", {});
		expect(value).toEqual({ count: 42 });

		const wrong = blog().with({
			useCases: {
				CountNotes: (async () => ({ count: "many" })) as never,
			},
		});
		const error = await wrong.run(CountNotes).catch((cause) => cause);
		expect(error.name).toBe("InvalidUseCaseResponse");
	});

	test("a publisher, in the event policy of a command", async () => {
		published.length = 0;
		const seen: string[] = [];
		const app = blog().with({
			...replacements,
			publishers: {
				bus: {
					publish: async (topic) => {
						seen.push(topic);
					},
				},
			},
		});
		await app.commands.Notes.run("write", { title: "a" });
		expect(seen).toEqual(["notes"]);
		expect(published).toEqual([]);
	});

	test("leaves the application it comes from as it is", async () => {
		const base = blog();
		const derived = base.with({
			...replacements,
			repositories: { Notes: { findMany: async () => [] } },
		});
		expect(derived).not.toBe(base);
		expect(base.repositories.Notes).not.toBe(derived.repositories.Notes);
		await base.repositories.Notes.create(new Note({ title: "x" }));
		expect(await base.repositories.Notes.findMany()).toHaveLength(1);
		expect(base.describe().replacements).toBeUndefined();
	});

	test("a call's own replace wins over the application's", async () => {
		const app = blog().with({
			...replacements,
			repositories: { Notes: { findMany: async () => [] } },
		});
		const result = await app.run(
			Outer,
			{ title: "a" },
			{
				replace: [
					[
						Notes,
						{
							findMany: async () => [
								new Note({ title: "1" }),
								new Note({ title: "2" }),
							],
						},
					],
				],
			},
		);
		expect(result.count).toBe(2);
	});

	test("extend keeps the replacements", async () => {
		class Tag extends entityOf(blueprintOf((ctx) => ({ name: ctx.string }))) {}
		const Other = applicationOf({ name: "other", entities: { Tag } });
		const app = blog().with(replacements).extend(Other);
		expect(app.entities.Tag).toBe(Tag);
		expect(await app.run(Outer, { title: "a" })).toMatchObject({
			mail: "fake mail to test@example.com",
		});
		expect(app.describe().replacements).toEqual({
			environments: { Settings: { kind: "opaque" } },
			services: { mailer: { kind: "opaque" } },
		});
	});

	test("describe marks each replacement opaque", () => {
		const description = blog()
			.with({
				...replacements,
				repositories: { Notes: { findMany: async () => [] } },
				useCases: { CountNotes: async () => ({ count: 0 }) },
				publishers: { bus: { publish: async () => {} } },
			})
			.describe();
		expect(description.replacements).toEqual({
			repositories: { Notes: { kind: "opaque" } },
			useCases: { CountNotes: { kind: "opaque" } },
			environments: { Settings: { kind: "opaque" } },
			services: { mailer: { kind: "opaque" } },
			publishers: { bus: { kind: "opaque" } },
		});
		// The declarations are described as they are.
		expect(description.repositories.Notes?.actions).toEqual([
			"create",
			"findMany",
		]);
	});

	describe("checks at declaration", () => {
		test.each([
			[
				"repositories",
				{ Posts: { findMany: async () => [] } },
				'repository "Posts"',
			],
			["useCases", { Publish: async () => ({}) }, 'use case "Publish"'],
			["environments", { Secrets: {} }, 'environment "Secrets"'],
			["services", { cache: () => ({}) }, 'service "cache"'],
			[
				"publishers",
				{ queue: { publish: async () => {} } },
				'publisher "queue"',
			],
		])(
			"an unregistered key of %s is UnregisteredApplicationReference",
			(collection, value, reference) => {
				let error: unknown;
				try {
					blog().with({ [collection]: value } as never);
				} catch (cause) {
					error = cause;
				}
				expect(error).toBeInstanceOf(UnregisteredApplicationReference);
				expect((error as { details?: unknown }).details).toEqual({
					holder: "app.with",
					reference,
				});
			},
		);

		test.each([
			["a collection app.with does not replace", { entities: {} }],
			["a repository that is not an object", { repositories: { Notes: 1 } }],
			[
				"a repository method it does not have",
				{ repositories: { Notes: { remove: async () => {} } } },
			],
			[
				"a repository method that is not a function",
				{ repositories: { Notes: { findMany: [] } } },
			],
			["a use case that is not a function", { useCases: { CountNotes: {} } }],
			[
				"an environment that is not an object",
				{ environments: { Settings: "x" } },
			],
			["a service that is not a factory", { services: { mailer: {} } }],
			["a publisher without publish", { publishers: { bus: {} } }],
			["a collection that is not an object", { services: [] }],
		])("%s is InvalidApplicationDeclaration", (_, given) => {
			expect(() => blog().with(given as never)).toThrow(
				InvalidApplicationDeclaration,
			);
		});

		test("variables that do not satisfy the blueprint are InvalidApplicationEnvironment", () => {
			let error: unknown;
			try {
				blog().with({
					environments: { Settings: { SENDER: "nope", LIMIT: 3 } },
				});
			} catch (cause) {
				error = cause;
			}
			expect(error).toBeInstanceOf(InvalidApplicationEnvironment);
			expect(
				(error as { details?: { environments?: unknown } }).details
					?.environments,
			).toEqual({ Settings: ["SENDER"] });
		});
	});

	test("is typed by the registrations of the application", () => {
		const app = blog();
		// @ts-expect-error: no repository is registered under Posts.
		expect(() => app.with({ repositories: { Posts: {} } })).toThrow();
		expect(() =>
			// @ts-expect-error: findMany gives a promise of notes.
			app.with({ repositories: { Notes: { findMany: () => 1 } } }),
		).not.toThrow();
		const settings = { SENDER: "a@b.co", LIMIT: "3" };
		expect(() =>
			// @ts-expect-error: LIMIT is a number.
			app.with({ environments: { Settings: settings } }),
		).toThrow(InvalidApplicationEnvironment);
	});
});
