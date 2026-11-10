import { afterEach, describe, expect, expectTypeOf, test } from "bun:test";
import {
	ApplicationNotStarted,
	applicationOf,
	blueprintOf,
	entityOf,
	environmentOf,
	InvalidApplicationDeclaration,
	inMemoryProvider,
	isLogFactory,
	isProviderFactory,
	type LogLevel,
	logFrom,
	memoryLogProvider,
	providerFrom,
	repositoryOf,
	resetApplication,
	UnregisteredApplicationReference,
	useApplication,
} from "../../index";

afterEach(() => resetApplication());

const Name = blueprintOf((ctx) => ({ name: ctx.string }));
class Note extends entityOf(Name) {}
const Notes = repositoryOf({ entity: Note, actions: ["create", "count"] });

const vars: Record<string, string | undefined> = {};
const Database = environmentOf(
	blueprintOf((ctx) => ({ DATABASE_URL: ctx.string })),
	{ source: () => vars },
);
const Logging = environmentOf(
	blueprintOf((ctx) => ({
		LOG_LEVEL: ctx.enumOf(["debug", "info", "warn", "error"]),
	})),
	{ source: () => vars },
);
const Other = environmentOf(
	blueprintOf((ctx) => ({ OTHER: ctx.string })),
	{
		source: () => vars,
	},
);

const failureOf = async (run: () => unknown) => {
	try {
		await run();
	} catch (error) {
		return error as { name: string; details: unknown };
	}
	throw new Error("did not throw");
};

describe("the context of an application", () => {
	test("gives its name, the typed variables of its environments and its logger", () => {
		vars.DATABASE_URL = "postgres://db";
		const memory = memoryLogProvider();
		const app = applicationOf({
			name: "notes",
			environments: { Database },
			log: { providers: [memory] },
		});
		expect(app.context.name).toBe("notes");
		const env = app.context.env(Database);
		expectTypeOf(env.DATABASE_URL).toEqualTypeOf<string>();
		expect(env.DATABASE_URL).toBe("postgres://db");
		app.context.logger.info("hello");
		expect(memory.entries.map(({ event }) => event)).toEqual(["hello"]);
	});

	test("an environment it does not register is refused", async () => {
		const app = applicationOf({ name: "notes", environments: { Database } });
		const error = await failureOf(() => app.context.env(Other));
		expect(error.name).toBe("UnregisteredApplicationReference");
		expect(() => app.context.env(Other)).toThrow(
			UnregisteredApplicationReference,
		);
	});

	test("the started application gives it to your code", async () => {
		vars.DATABASE_URL = "postgres://db";
		const app = applicationOf({ name: "notes", environments: { Database } });
		await app.start();
		expect(useApplication().context.env(Database).DATABASE_URL).toBe(
			"postgres://db",
		);
	});
});

describe("providerFrom with the context", () => {
	test("makes the provider on start, from the context", async () => {
		vars.DATABASE_URL = "postgres://db";
		const made: string[] = [];
		const factory = providerFrom((ctx) => {
			made.push(ctx.env(Database).DATABASE_URL);
			ctx.logger.info("connecting");
			return inMemoryProvider();
		});
		expect(isProviderFactory(factory)).toBe(true);
		const memory = memoryLogProvider();
		const app = applicationOf({
			name: "notes",
			entities: { Note },
			repositories: { Notes },
			environments: { Database },
			provider: factory,
			log: { providers: [memory] },
		});
		const early = await failureOf(() => app.repositories.Notes.count());
		expect(early.name).toBe(ApplicationNotStarted.name);
		await app.start();
		expect(made).toEqual(["postgres://db"]);
		expect(await app.repositories.Notes.count()).toBe(0);
		expect(memory.entries.map(({ event }) => event)).toEqual(["connecting"]);
	});

	test("an environment it reads that is not registered fails the start", async () => {
		const app = applicationOf({
			name: "notes",
			entities: { Note },
			repositories: { Notes },
			provider: providerFrom((ctx) => {
				ctx.env(Database);
				return inMemoryProvider();
			}),
		});
		const error = await failureOf(() => app.start());
		expect(error.name).toBe("UnregisteredApplicationReference");
		expect(app.started).toBe(false);
	});
});

describe("logFrom", () => {
	const appOf = () => {
		const memory = memoryLogProvider();
		const app = applicationOf({
			name: "notes",
			environments: { Logging },
			log: logFrom((ctx) => ({
				level: ctx.env(Logging).LOG_LEVEL as LogLevel,
				providers: [memory],
			})),
		});
		return { app, memory };
	};

	test("makes the log on start, from the context; nothing is written before", async () => {
		vars.LOG_LEVEL = "warn";
		const { app, memory } = appOf();
		app.logger.error("too early");
		await app.start();
		app.logger.info("below the level");
		app.logger.warn("kept");
		expect(memory.entries.map(({ event }) => event)).toEqual(["kept"]);
	});

	test("stop forgets it; the next start makes it again", async () => {
		const memory = memoryLogProvider();
		let made = 0;
		const app = applicationOf({
			name: "notes",
			log: logFrom(() => {
				made += 1;
				return { providers: [memory] };
			}),
		});
		await app.start();
		await app.stop();
		app.logger.info("stopped");
		await app.start();
		app.logger.info("again");
		expect(made).toBe(2);
		expect(memory.entries.map(({ event }) => event)).toEqual(["again"]);
	});

	test("describe calls it opaque, and it takes only a function", () => {
		const { app } = appOf();
		expect(app.describe().log).toEqual({ kind: "opaque" });
		expect(isLogFactory(logFrom(() => ({ providers: [] })))).toBe(true);
		expect(() => logFrom("json" as never)).toThrow(
			InvalidApplicationDeclaration,
		);
	});
});
