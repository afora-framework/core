import { afterEach, describe, expect, test } from "bun:test";
import {
	ApplicationConflict,
	applicationOf,
	blueprintOf,
	commandOf,
	entityOf,
	environmentOf,
	InvalidApplicationDeclaration,
	InvalidCommandDeclaration,
	type IRepositoryProvider,
	inMemoryProvider,
	isProviderSlot,
	isProviderStorage,
	ProviderNotBound,
	providerFrom,
	providersOf,
	repositoryOf,
	resetApplication,
	UnregisteredApplicationReference,
	useCaseOf,
} from "../../index";

const Name = blueprintOf((ctx) => ({ name: ctx.string }));
const Empty = blueprintOf(() => ({}));
class Note extends entityOf(Name) {}
class Log extends entityOf(Name) {}

const Database = environmentOf(
	blueprintOf((ctx) => ({ DATABASE_URL: ctx.url })),
	{ source: () => ({ DATABASE_URL: "memory://main" }) },
);

const made: { closed: number }[] = [];
const tracked = () => {
	const record = { closed: 0 };
	made.push(record);
	return { ...inMemoryProvider(), close: () => void record.closed++ };
};

const Providers = providersOf({
	main: providerFrom(Database, () => tracked()),
	audit: providerFrom(() => tracked()),
});

const Notes = repositoryOf({
	entity: Note,
	actions: ["create", "count"],
	provider: Providers.main,
});
const Logs = repositoryOf({
	entity: Log,
	actions: ["create", "count"],
	provider: Providers.audit,
});

const appOf = (name = "a") =>
	applicationOf({
		name,
		entities: { Note, Log },
		environments: { Database },
		repositories: { Notes, Logs },
		providers: Providers,
	});

const failureOf = async (run: () => unknown) => {
	try {
		await run();
	} catch (error) {
		return error as { name: string; details: unknown };
	}
	throw new Error("did not throw");
};

afterEach(() => {
	resetApplication();
	made.length = 0;
});

describe("providersOf", () => {
	test("is a frozen storage of slots, by key", () => {
		expect(isProviderStorage(Providers)).toBe(true);
		expect(Object.isFrozen(Providers)).toBe(true);
		expect(Object.keys(Providers)).toEqual(["main", "audit"]);
		expect(isProviderSlot(Providers.main)).toBe(true);
		expect(Providers.audit.key).toBe("audit");
		expect(isProviderSlot(inMemoryProvider())).toBe(false);
	});

	test("rejects what is not a storage of providers", () => {
		const memory = inMemoryProvider();
		for (const make of [
			() => providersOf({}),
			() => providersOf([] as never),
			() => providersOf({ inMemory: inMemoryProvider() }),
			() => providersOf({ "a-b": inMemoryProvider() }),
			() => providersOf({ a: {} as never }),
			() => providersOf({ a: Providers.main }),
			() => providersOf({ a: memory, b: memory }),
		]) {
			expect(make).toThrow(InvalidApplicationDeclaration);
		}
	});

	test("a provider object works outside any application", async () => {
		const Local = providersOf({ local: inMemoryProvider() });
		const Plain = repositoryOf({
			entity: Note,
			actions: ["create", "count"],
			provider: Local.local,
		});
		await Plain.create({ name: "a" });
		expect(await Plain.count()).toBe(1);
	});

	test("a factory throws ProviderNotBound outside an application", async () => {
		const error = await failureOf(() => Notes.count());
		expect(error.name).toBe(ProviderNotBound.name);
		// it crossed the repository layer: the first step keeps the details
		expect(
			(error as unknown as { trace: { details: unknown }[] }).trace[0]?.details,
		).toEqual({ provider: "main" });
	});
});

describe("applicationOf({ providers })", () => {
	test("start makes each provider; repositories use their own", async () => {
		const app = appOf();
		await app.start();
		expect(made).toHaveLength(2);
		await app.repositories.Notes.create({ name: "a" });
		expect(await app.repositories.Notes.count()).toBe(1);
		expect(await app.repositories.Logs.count()).toBe(0);
		const main = app.get(Providers.main);
		const audit = app.get(Providers.audit);
		expect(main).not.toBe(audit);
		expect(
			await main.count({ entity: Note, name: "NoteRepository" } as never, {}),
		).toBe(1);
	});

	test("two applications do not share; an extending one does", async () => {
		const one = appOf("one");
		const two = appOf("two");
		await one.start();
		await two.start({ register: false });
		await one.repositories.Notes.create({ name: "a" });
		expect(await two.repositories.Notes.count()).toBe(0);
		const more = applicationOf({ name: "more", extends: [one] });
		expect(await more.repositories.Notes.count()).toBe(1);
		expect(more.get(Providers.main)).toBe(one.get(Providers.main));
		const extended = one.extend();
		expect(extended.get(Providers.audit)).toBe(one.get(Providers.audit));
		// registering the same storage again shares too
		const again = applicationOf({
			name: "again",
			extends: [one],
			providers: Providers,
		});
		expect(again.get(Providers.main)).toBe(one.get(Providers.main));
	});

	test("the default provider can be one of the storage", async () => {
		class Other extends entityOf(Name) {}
		const Others = repositoryOf({
			entity: Other,
			actions: ["create", "count"],
		});
		const app = applicationOf({
			name: "a",
			entities: { Note, Log, Other },
			environments: { Database },
			repositories: { Notes, Logs, Others },
			providers: Providers,
			provider: Providers.main,
		});
		expect(app.provider).toBe(app.get(Providers.main));
		await app.start();
		expect(made).toHaveLength(2);
		await app.repositories.Others.create({ name: "x" });
		expect(await app.repositories.Others.count()).toBe(1);
		expect(app.describe().provider).toEqual({ kind: "ref", key: "main" });
		expect(app.extend().describe().provider).toEqual({
			kind: "ref",
			key: "main",
		});
	});

	test("a provider of a storage it does not register is rejected", () => {
		const error = () =>
			applicationOf({
				name: "a",
				entities: { Note },
				repositories: { Notes },
			});
		expect(error).toThrow(UnregisteredApplicationReference);
		expect(() =>
			applicationOf({ name: "a", provider: Providers.main }),
		).toThrow(UnregisteredApplicationReference);
		expect(() =>
			appOf().get(providersOf({ main: inMemoryProvider() }).main),
		).toThrow(InvalidApplicationDeclaration);
	});

	test("the environments of its factories must be registered", () => {
		expect(() =>
			applicationOf({
				name: "a",
				entities: { Note, Log },
				repositories: { Notes, Logs },
				providers: Providers,
			}),
		).toThrow(UnregisteredApplicationReference);
	});

	test("one key from two storages conflicts", () => {
		const Other = providersOf({ main: inMemoryProvider() });
		const base = appOf("base");
		expect(() =>
			applicationOf({ name: "b", extends: [base], providers: Other }),
		).toThrow(ApplicationConflict);
	});

	test("a failed start closes what it made; stop closes every provider", async () => {
		let fail = true;
		const Failing = providersOf({
			ok: providerFrom(() => tracked()),
			bad: providerFrom(() => {
				if (fail) throw new Error("no");
				return tracked();
			}),
		});
		const app = applicationOf({ name: "a", providers: Failing });
		await expect(app.start()).rejects.toThrow("no");
		expect(made.map((record) => record.closed)).toEqual([1]);
		fail = false;
		await app.start();
		await app.stop();
		expect(made.map((record) => record.closed)).toEqual([1, 1, 1]);
	});

	test("a transaction cannot span two providers", () => {
		class Write extends useCaseOf({
			name: "Write",
			blueprint: Name,
			response: Empty,
			dependencies: { notes: Notes, logs: Logs },
		}) {
			override async execute() {
				return {};
			}
		}
		expect(() =>
			commandOf({
				name: "Both",
				useCases: { write: Write },
				transaction: true,
			}),
		).toThrow(InvalidCommandDeclaration);
	});

	test("a transaction runs on the instance made on start", async () => {
		class Write extends useCaseOf({
			name: "Write",
			blueprint: Name,
			response: Empty,
			dependencies: { notes: Notes },
		}) {
			override async execute({ notes = this.dependencies.notes } = {}) {
				await notes.create(new Note(this.input));
				if (this.input.name === "boom") throw new Error("boom");
				return {};
			}
		}
		const Writes = commandOf({
			name: "Writes",
			useCases: { write: Write },
			transaction: true,
		});
		const app = applicationOf({
			name: "a",
			entities: { Note, Log },
			environments: { Database },
			repositories: { Notes, Logs },
			useCases: { Write },
			commands: { Writes },
			providers: Providers,
		});
		await app.start();
		await app.commands.Writes.run("write", { name: "kept" });
		await expect(
			app.commands.Writes.run("write", { name: "boom" }),
		).rejects.toThrow();
		expect(await app.repositories.Notes.count()).toBe(1);
	});

	test("describe gives the providers and the references", () => {
		const Named = providersOf({
			memory: inMemoryProvider(),
			made: providerFrom(() => inMemoryProvider()),
		});
		const Kept = repositoryOf({
			entity: Note,
			actions: ["count"],
			provider: Named.memory,
		});
		const description = applicationOf({
			name: "a",
			entities: { Note },
			repositories: { Kept },
			providers: Named,
		}).describe();
		expect(description.providers).toEqual({
			memory: { from: "a", kind: "provider", name: "inMemory", options: {} },
			made: { from: "a", kind: "opaque" },
		});
		expect(description.repositories.Kept?.provider).toEqual({
			kind: "ref",
			key: "memory",
		});
		expect(description.provider).toBeUndefined();
	});

	test("an object provider is shared and used as is", async () => {
		const memory = inMemoryProvider() as IRepositoryProvider;
		const Shared = providersOf({ memory });
		const app = applicationOf({ name: "a", providers: Shared });
		expect(app.get(Shared.memory)).toBe(memory);
	});
});
