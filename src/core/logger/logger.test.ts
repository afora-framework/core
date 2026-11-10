import { afterEach, describe, expect, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	type ILogger,
	type ILogProvider,
	InvalidLogDeclaration,
	InvalidUseCaseDependencies,
	inMemoryProvider,
	Logger,
	type LogLevel,
	logProviderOf,
	memoryLogProvider,
	repositoryOf,
	resetApplication,
	useCaseOf,
} from "../../index";

afterEach(() => resetApplication());

const Name = blueprintOf((ctx) => ({ name: ctx.string }));
class Note extends entityOf(Name) {}
const Notes = repositoryOf({ entity: Note, actions: ["create", "count"] });

const NotFound = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "NoteNotFound",
	message: "No such note.",
});

class AddNote extends useCaseOf({
	name: "AddNote",
	blueprint: Name,
	response: blueprintOf((ctx) => ({ count: ctx.integer })),
	dependencies: { notes: Notes },
}) {
	override async execute({ notes = this.dependencies.notes } = {}) {
		await notes.create(this.input);
		return { count: await notes.count() };
	}
}

class Missing extends useCaseOf({
	name: "Missing",
	blueprint: blueprintOf(() => ({})),
	response: blueprintOf(() => ({})),
}) {
	override async execute(): Promise<Record<string, never>> {
		throw new NotFound({ source: "Missing" });
	}
}

class Broken extends useCaseOf({
	name: "Broken",
	blueprint: blueprintOf(() => ({})),
	response: blueprintOf(() => ({})),
}) {
	override async execute(): Promise<Record<string, never>> {
		throw new Error("disk on fire");
	}
}

class CallsMissing extends useCaseOf({
	name: "CallsMissing",
	blueprint: blueprintOf(() => ({})),
	response: blueprintOf(() => ({})),
	dependencies: { missing: Missing },
}) {
	override async execute({ missing = this.dependencies.missing } = {}) {
		return missing({});
	}
}

class Import extends useCaseOf({
	name: "Import",
	blueprint: blueprintOf((ctx) => ({ rows: ctx.integer })),
	response: blueprintOf(() => ({})),
	dependencies: { logger: Logger },
}) {
	override async execute({ logger = this.dependencies.logger } = {}) {
		logger.info("imported", { rows: this.input.rows });
		return {};
	}
}

const Notebook = commandOf({
	name: "Notebook",
	useCases: { add: AddNote, callsMissing: CallsMissing },
});

function appWith(level: LogLevel = "debug", ...extra: ILogProvider[]) {
	const memory = memoryLogProvider();
	const app = applicationOf({
		name: "notes",
		entities: { Note },
		repositories: { Notes },
		useCases: { AddNote, Missing, Broken, CallsMissing, Import },
		commands: { Notebook },
		provider: inMemoryProvider(),
		log: { level, providers: [memory, ...extra] },
	});
	const events = () =>
		memory.entries.map(({ level, event }) => `${level} ${event}`);
	return { app, memory, events };
}

describe("the log of an application", () => {
	test("its use cases and their repository calls, at debug, with their time", async () => {
		const { app, memory, events } = appWith();
		await new app.useCases.AddNote({ name: "a" }).execute();
		expect(events()).toEqual([
			"debug repository",
			"debug repository",
			"debug use-case",
		]);
		expect(memory.entries[0]).toMatchObject({
			application: "notes",
			fields: { repository: "Note", method: "create", useCase: "AddNote" },
		});
		expect(typeof memory.entries[2]?.fields.ms).toBe("number");
		expect(memory.entries[2]?.at).toMatch(/^\d{4}-\d\d-\d\dT/);
	});

	test("a command, and the use cases it runs", async () => {
		const { app, events } = appWith();
		await app.commands.Notebook.run("add", { name: "a" });
		expect(events().at(-1)).toBe("debug command");
	});

	test("the level drops what is below it", async () => {
		const { app, events } = appWith("info");
		await new app.useCases.AddNote({ name: "a" }).execute();
		await new app.useCases.Missing({}).execute().catch(() => {});
		expect(events()).toEqual(["warn use-case-failed"]);
	});

	test("a declared exception is a warning; anything else an error, with its trace", async () => {
		const { app, memory } = appWith("warn");
		await new app.useCases.Missing({}).execute().catch(() => {});
		await new app.useCases.Broken({}).execute().catch(() => {});
		expect(memory.entries.map(({ level }) => level)).toEqual(["warn", "error"]);
		expect(memory.entries[0]?.fields).toMatchObject({
			useCase: "Missing",
			exception: { name: "NoteNotFound" },
		});
		expect(memory.entries[1]?.fields).toMatchObject({
			exception: { name: "UnexpectedError", message: "disk on fire" },
		});
	});

	test("a failure is logged once, where it first surfaced", async () => {
		const { app, memory } = appWith("warn");
		await app.commands.Notebook.run("callsMissing", {}).catch(() => {});
		expect(memory.entries).toHaveLength(1);
		expect(memory.entries[0]?.fields).toMatchObject({ useCase: "Missing" });
	});

	test("every provider gets each line; one that throws breaks nothing", async () => {
		const other = memoryLogProvider();
		const throwing = logProviderOf({
			write: () => {
				throw new Error("log service down");
			},
		});
		const rejecting = logProviderOf({
			write: () => Promise.reject(new Error("timeout")),
		});
		const { app, memory } = appWith("debug", throwing, rejecting, other);
		expect(
			await new app.useCases.AddNote({ name: "a" }).execute(),
		).toMatchObject({ count: 1 });
		expect(other.entries).toEqual(memory.entries);
	});

	test("the logger writes your own lines through the same providers", () => {
		const { app, memory } = appWith("info");
		app.logger.info("imported", { rows: 3 });
		app.logger.debug("ignored");
		expect(memory.entries).toMatchObject([
			{ level: "info", event: "imported", fields: { rows: 3 } },
		]);
	});

	test("stop flushes every provider", async () => {
		let flushed = 0;
		const buffered = logProviderOf({
			write: () => {},
			flush: async () => {
				flushed += 1;
			},
		});
		const { app } = appWith("info", buffered);
		await app.start();
		await app.stop();
		expect(flushed).toBe(1);
	});

	test("an application without log writes nothing, and its use cases stay as declared", async () => {
		const app = applicationOf({
			name: "quiet",
			useCases: { Missing },
		});
		expect(app.useCases.Missing).toBe(Missing);
		app.logger.error("nowhere");
		await new app.useCases.Missing({}).execute().catch(() => {});
	});

	test("an extending application inherits the log, under its own name", async () => {
		const { app: base, memory } = appWith("info");
		const extended = applicationOf({ name: "more", extends: [base] });
		extended.logger.info("hello");
		expect(memory.entries.at(-1)).toMatchObject({
			application: "more",
			event: "hello",
		});
		expect(extended.describe().log).toEqual(base.describe().log);
	});

	test("a use case run directly logs to the started application", async () => {
		const { app, events } = appWith("warn");
		await app.start();
		await new Missing({}).execute().catch(() => {});
		expect(events()).toEqual(["warn use-case-failed"]);
	});

	test("describe gives the level and the named providers", () => {
		const anonymous = logProviderOf({ write: () => {} });
		const { app } = appWith("info", anonymous);
		expect(app.describe().log).toEqual({
			level: "info",
			providers: [{ kind: "log-provider", name: "memory" }, { kind: "opaque" }],
		});
	});

	test("a log or a provider it cannot use throws InvalidLogDeclaration", () => {
		const make = (log: unknown) => () =>
			applicationOf({ name: "bad", log: log as never });
		expect(make({ providers: "console" })).toThrow(InvalidLogDeclaration);
		expect(make({ level: "loud", providers: [] })).toThrow(
			InvalidLogDeclaration,
		);
		expect(() => logProviderOf({} as never)).toThrow(InvalidLogDeclaration);
		expect(() => logProviderOf({ name: " ", write: () => {} })).toThrow(
			InvalidLogDeclaration,
		);
	});
});

describe("the Logger dependency", () => {
	test("is the logger of the application the use case comes from", async () => {
		const { app, memory } = appWith("info");
		await new app.useCases.Import({ rows: 3 }).execute();
		expect(memory.entries).toMatchObject([
			{ application: "notes", event: "imported", fields: { rows: 3 } },
		]);
	});

	test("run directly, it is the started application's", async () => {
		const { app, memory } = appWith("info");
		await app.start();
		await new Import({ rows: 1 }).execute();
		expect(memory.entries.map(({ event }) => event)).toEqual(["imported"]);
	});

	test("without an application, it writes nothing", async () => {
		await new Import({ rows: 1 }).execute();
	});

	test("execute can replace it, e.g. in a test", async () => {
		const lines: string[] = [];
		const fake: ILogger = {
			debug: () => {},
			info: (event) => lines.push(event),
			warn: () => {},
			error: () => {},
		};
		const { app, memory } = appWith("info");
		await new app.useCases.Import({ rows: 1 }).execute({ logger: fake });
		expect(lines).toEqual(["imported"]);
		expect(memory.entries).toEqual([]);
		await expect(
			new Import({ rows: 1 }).execute({ logger: { info: () => {} } as never }),
		).rejects.toThrow(InvalidUseCaseDependencies);
	});

	test("needs no registration, and describe names it", () => {
		const { app } = appWith();
		expect(app.describe().useCases.Import?.dependencies).toEqual({
			logger: { kind: "logger", ref: "Logger" },
		});
	});
});
