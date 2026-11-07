import { afterEach, describe, expect, expectTypeOf, test } from "bun:test";
import {
	type AnyApplication,
	ApplicationAlreadyStarted,
	ApplicationNotStarted,
	applicationOf,
	blueprintOf,
	commandOf,
	entityOf,
	environmentOf,
	type EnvironmentValue,
	InvalidApplicationDeclaration,
	inMemoryProvider,
	openapi,
	outputOf,
	type RegisteredApplication,
	repositoryOf,
	resetApplication,
	useApplication,
	useCaseOf,
} from "../../index";

const Name = blueprintOf((ctx) => ({ name: ctx.string }));
const Empty = blueprintOf(() => ({}));
class Note extends entityOf(Name) {}
const Notes = repositoryOf({ entity: Note, actions: ["create", "count"] });
class Write extends useCaseOf({
	name: "Write",
	blueprint: Name,
	response: Empty,
	dependencies: { notes: Notes },
}) {
	override async execute({ notes = this.dependencies.notes } = {}) {
		await notes.create(new Note(this.input));
		return {};
	}
}
const Writes = commandOf({ name: "Writes", useCases: { write: Write } });
const Api = outputOf({
	name: "Api",
	commands: [Writes],
	pipe: [openapi({ info: { title: "Notes", version: "0.0.1" } })],
});
const Mail = environmentOf(blueprintOf((ctx) => ({ FROM: ctx.email })), {
	source: () => ({ FROM: "app@example.com" }),
});
const Other = environmentOf(blueprintOf((ctx) => ({ X: ctx.string })), {
	source: () => ({ X: "x" }),
});

const appOf = (name = "notes") =>
	applicationOf({
		name,
		entities: { Note },
		environments: { Mail },
		repositories: { Notes },
		useCases: { Write },
		commands: { Writes },
		outputs: { Api },
		provider: inMemoryProvider(),
	});

afterEach(() => resetApplication());

const failureOf = async (run: () => unknown) => {
	try {
		await run();
	} catch (error) {
		return error as { name: string; details: unknown };
	}
	throw new Error("did not throw");
};

describe("useApplication", () => {
	test("throws ApplicationNotStarted when none is started", async () => {
		const error = await failureOf(() => useApplication());
		expect(error).toBeInstanceOf(ApplicationNotStarted);
		expect((error as unknown as Error).message).toContain(
			"No application is started",
		);
	});

	test("gives the started application, until it stops", async () => {
		const app = appOf();
		await app.start();
		expect(useApplication()).toBe(app);
		await app.stop();
		expect(() => useApplication()).toThrow(ApplicationNotStarted);
	});

	test("without Register it is any application", () => {
		expectTypeOf<RegisteredApplication>().toEqualTypeOf<AnyApplication>();
	});

	test("start({ register: false }) does not register", async () => {
		const app = appOf();
		await app.start({ register: false });
		expect(app.started).toBe(true);
		expect(() => useApplication()).toThrow(ApplicationNotStarted);
	});

	test("the started application lives on globalThis, shared by copies of the package", async () => {
		const app = appOf();
		await app.start();
		const slot = (globalThis as Record<symbol, unknown>)[
			Symbol.for("afora.application")
		] as { current: unknown };
		expect(slot.current).toBe(app);
		resetApplication();
		expect(slot.current).toBeUndefined();
		// another copy of the package writes the same slot
		slot.current = app;
		expect(useApplication()).toBe(app);
	});
});

describe("one started application", () => {
	test("another one cannot start", async () => {
		const first = appOf("first");
		const second = appOf("second");
		await first.start();
		const error = await failureOf(() => second.start());
		expect(error).toBeInstanceOf(ApplicationAlreadyStarted);
		expect(error.details).toEqual({ current: "first", attempted: "second" });
		expect(second.started).toBe(false);
		expect(useApplication()).toBe(first);
	});

	test("starting the same one again is a no-op", async () => {
		const app = appOf();
		await app.start();
		expect(await app.start()).toBe(app);
		expect(useApplication()).toBe(app);
	});

	test("replace stops the started one and takes its place", async () => {
		let closed = 0;
		const first = applicationOf({
			name: "first",
			provider: { ...inMemoryProvider(), close: () => void closed++ },
		});
		const second = appOf("second");
		await first.start();
		await second.start({ replace: true });
		expect(useApplication()).toBe(second);
		expect(first.started).toBe(false);
		expect(closed).toBe(1);
	});

	test("resetApplication lets another one start, without stopping the first", async () => {
		const first = appOf("first");
		await first.start();
		resetApplication();
		await appOf("second").start();
		expect(first.started).toBe(true);
	});
});

describe("app.get", () => {
	test("gives the bound declaration of each kind, and environment variables", async () => {
		const app = appOf();
		expect(app.get(Notes)).toBe(app.repository(Notes));
		expect(app.get(Write)).toBe(app.useCase(Write));
		expect(app.get(Writes)).toBe(app.command(Writes));
		expect(app.get(Api)).toBe(app.output(Api));
		expect(app.get(Mail)).toEqual({ FROM: "app@example.com" });

		await app.get(Writes).run("write", { name: "a" });
		expect(await app.get(Notes).count()).toBe(1);

		expectTypeOf(app.get(Mail)).toEqualTypeOf<EnvironmentValue<typeof Mail>>();
		expectTypeOf(app.get(Notes)).toEqualTypeOf<typeof Notes>();
		expectTypeOf(app.get(Writes)).toEqualTypeOf<typeof Writes>();
		expectTypeOf(app.get(Write)).toEqualTypeOf<typeof Write>();
		expectTypeOf(app.get(Api)).toEqualTypeOf<typeof Api>();
	});

	test("rejects what is not registered", () => {
		const app = appOf();
		for (const value of [Other, {}, 1, Note]) {
			expect(() => app.get(value as never)).toThrow(
				InvalidApplicationDeclaration,
			);
		}
		const Unregistered = repositoryOf({ entity: Note, actions: ["count"] });
		expect(() => app.get(Unregistered)).toThrow(InvalidApplicationDeclaration);
	});

	test("through useApplication, anywhere", async () => {
		await appOf().start();
		await useApplication().get(Writes).run("write", { name: "b" });
		expect(await useApplication().get(Notes).count()).toBe(1);
	});
});
