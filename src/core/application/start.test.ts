import { describe, expect, test } from "bun:test";
import {
	ApplicationNotStarted,
	applicationOf,
	blueprintOf,
	commandOf,
	ExceptionLayers,
	entityOf,
	environmentOf,
	exceptionOf,
	InvalidApplicationDeclaration,
	InvalidApplicationEnvironment,
	InvalidCommandDeclaration,
	type IRepositoryProvider,
	inMemoryProvider,
	isProviderFactory,
	providerFrom,
	repositoryOf,
	UnregisteredApplicationReference,
	useCaseOf,
} from "../../index";

const Name = blueprintOf((ctx) => ({ name: ctx.string }));
const Empty = blueprintOf(() => ({}));
class Note extends entityOf(Name) {}
const Notes = repositoryOf({ entity: Note, actions: ["create", "count"] });

const Boom = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "Boom",
	message: "boom",
});
class Write extends useCaseOf({
	name: "Write",
	blueprint: Name,
	response: Empty,
	errors: [Boom],
	dependencies: { notes: Notes },
}) {
	override async execute({ notes = this.dependencies.notes } = {}) {
		await notes.create(new Note(this.input));
		if (this.input.name === "boom") throw new Boom({ source: "Write" });
		return {};
	}
}

/** An environment reading from `variables`, which a test can change. */
const variablesOf = (variables: Record<string, string | undefined>) => ({
	variables,
	source: () => variables,
});

const failureOf = async (run: () => Promise<unknown>) => {
	try {
		await run();
	} catch (error) {
		return error as { name: string; details: unknown; layer: string };
	}
	throw new Error("did not throw");
};

describe("start", () => {
	test("validates every environment at once", async () => {
		const database = variablesOf({});
		const Database = environmentOf(
			blueprintOf((ctx) => ({ DATABASE_URL: ctx.url })),
			{ source: database.source },
		);
		const Mail = environmentOf(
			blueprintOf((ctx) => ({ FROM: ctx.email, PORT: ctx.integer })),
			{ source: () => ({ FROM: "nope" }) },
		);
		const Fine = environmentOf(
			blueprintOf((ctx) => ({ A: ctx.string })),
			{
				source: () => ({ A: "a" }),
			},
		);
		const app = applicationOf({
			name: "a",
			environments: { Database, Mail, Fine },
		});
		expect(app.started).toBe(false);
		const error = await failureOf(() => app.start());
		expect(error).toBeInstanceOf(InvalidApplicationEnvironment);
		expect(error.layer).toBe(ExceptionLayers.Environment);
		expect(error.details).toEqual({
			environments: { Database: ["DATABASE_URL"], Mail: ["FROM", "PORT"] },
		});
		expect(app.started).toBe(false);
	});

	test("is idempotent, and gives the application", async () => {
		const app = applicationOf({ name: "a" });
		const first = app.start();
		expect(app.start()).toBe(first);
		expect(await first).toBe(app);
		expect(app.started).toBe(true);
	});

	test("an application with a provider object needs no start", async () => {
		const app = applicationOf({
			name: "a",
			entities: { Note },
			repositories: { Notes },
			provider: inMemoryProvider(),
		});
		await app.repositories.Notes.create({ name: "n" });
		expect(await app.repositories.Notes.count()).toBe(1);
	});
});

describe("providerFrom", () => {
	const Database = environmentOf(
		blueprintOf((ctx) => ({ DATABASE_URL: ctx.url })),
		{ source: () => ({ DATABASE_URL: "memory://notes" }) },
	);
	const made: { url: string; provider: IRepositoryProvider; closed: number }[] =
		[];
	const factory = providerFrom(Database, async (env) => {
		const provider: IRepositoryProvider = {
			...inMemoryProvider(),
			close: () => {
				entry.closed++;
			},
		};
		const entry = { url: env.DATABASE_URL, provider, closed: 0 };
		made.push(entry);
		return provider;
	});
	const appOf = () =>
		applicationOf({
			name: "notes",
			entities: { Note },
			environments: { Database },
			repositories: { Notes },
			useCases: { Write },
			exceptions: { Boom },
			provider: factory,
		});

	test("is a frozen factory of the environments", () => {
		expect(isProviderFactory(factory)).toBe(true);
		expect(isProviderFactory(inMemoryProvider())).toBe(false);
		expect(factory.environments).toEqual([Database]);
		expect(Object.isFrozen(factory)).toBe(true);
		for (const make of [
			() => providerFrom({} as never, () => inMemoryProvider()),
			() => providerFrom([Database, Database], () => inMemoryProvider()),
			() => providerFrom(Database, "x" as never),
		]) {
			expect(make).toThrow(InvalidApplicationDeclaration);
		}
	});

	test("calls before start throw ApplicationNotStarted", async () => {
		made.length = 0;
		const app = appOf();
		const error = await failureOf(() => app.repositories.Notes.count());
		expect(error.name).toBe(ApplicationNotStarted.name);
		expect(made).toHaveLength(0);
	});

	test("start makes the provider once, from the variables", async () => {
		made.length = 0;
		const app = appOf();
		await Promise.all([app.start(), app.start()]);
		expect(made.map(({ url }) => url)).toEqual(["memory://notes"]);
		await app.repositories.Notes.create({ name: "a" });
		expect(await app.repositories.Notes.count()).toBe(1);
		// the writes went to the provider made on start
		const provider = made[0]?.provider as IRepositoryProvider;
		expect(
			await provider.count({ entity: Note, name: "NoteRepository" } as never),
		).toBe(1);
		await new (app.useCases.Write as typeof Write)({ name: "b" }).execute();
		expect(await app.repositories.Notes.count()).toBe(2);
	});

	test("stop closes it; the next start makes another", async () => {
		made.length = 0;
		const app = appOf();
		await app.start();
		await app.repositories.Notes.create({ name: "a" });
		await app.stop();
		expect(app.started).toBe(false);
		expect(made[0]?.closed).toBe(1);
		const error = await failureOf(() => app.repositories.Notes.count());
		expect(error.name).toBe(ApplicationNotStarted.name);
		await app.start();
		expect(made).toHaveLength(2);
		expect(await app.repositories.Notes.count()).toBe(0);
	});

	test("its environments must be registered", () => {
		expect(() =>
			applicationOf({
				name: "a",
				entities: { Note },
				repositories: { Notes },
				provider: factory,
			}),
		).toThrow(UnregisteredApplicationReference);
	});

	test("a failed start can be tried again", async () => {
		const database = variablesOf({});
		const Late = environmentOf(
			blueprintOf((ctx) => ({ URL: ctx.url })),
			{
				source: database.source,
			},
		);
		let creates = 0;
		const app = applicationOf({
			name: "a",
			environments: { Late },
			provider: providerFrom(Late, () => {
				creates++;
				return inMemoryProvider();
			}),
		});
		await expect(app.start()).rejects.toThrow(InvalidApplicationEnvironment);
		expect(creates).toBe(0);
		database.variables.URL = "https://example.com";
		// the environment keeps no failed read
		await app.start();
		expect(creates).toBe(1);
		expect(app.started).toBe(true);
	});

	test("create must give a provider", async () => {
		const app = applicationOf({
			name: "a",
			environments: { Database },
			provider: providerFrom(Database, () => undefined as never),
		});
		await expect(app.start()).rejects.toThrow(InvalidApplicationDeclaration);
	});

	test("transactions run on the provider made on start", async () => {
		made.length = 0;
		const Writes = commandOf({
			name: "Writes",
			useCases: { write: Write },
			transaction: true,
		});
		const app = applicationOf({
			name: "notes",
			entities: { Note },
			environments: { Database },
			repositories: { Notes },
			useCases: { Write },
			commands: { Writes },
			exceptions: { Boom },
			provider: factory,
		});
		await app.start();
		await app.commands.Writes.run("write", { name: "kept" });
		await expect(
			app.commands.Writes.run("write", { name: "boom" }),
		).rejects.toThrow();
		expect(await app.repositories.Notes.count()).toBe(1);
	});

	test("start fails when the provider has no transactions a command needs", async () => {
		const Writes = commandOf({
			name: "Writes",
			useCases: { write: Write },
			transaction: true,
		});
		const { transaction: _, ...plain } = inMemoryProvider();
		const app = applicationOf({
			name: "notes",
			entities: { Note },
			environments: { Database },
			repositories: { Notes },
			useCases: { Write },
			commands: { Writes },
			exceptions: { Boom },
			provider: providerFrom(Database, () => plain as IRepositoryProvider),
		});
		await expect(app.start()).rejects.toThrow(InvalidCommandDeclaration);
		expect(app.started).toBe(false);
	});

	test("an extending application shares the provider", async () => {
		made.length = 0;
		const base = appOf();
		const extended = applicationOf({ name: "more", extends: [base] });
		await extended.start();
		expect(made).toHaveLength(1);
		await base.start();
		expect(made).toHaveLength(1);
		await extended.repositories.Notes.create({ name: "a" });
		expect(await base.repositories.Notes.count()).toBe(1);
	});

	test("stop closes a provider object that has close", async () => {
		let closed = 0;
		const app = applicationOf({
			name: "a",
			provider: { ...inMemoryProvider(), close: () => void closed++ },
		});
		await app.start();
		await app.stop();
		expect(closed).toBe(1);
	});
});
