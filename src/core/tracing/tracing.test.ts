import { afterEach, describe, expect, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	InvalidTraceDeclaration,
	type ITracer,
	type ITraceSpan,
	inMemoryProvider,
	type MemorySpan,
	memoryTracer,
	repositoryOf,
	resetApplication,
	useCaseOf,
} from "../../index";

afterEach(() => resetApplication());

const Name = blueprintOf((ctx) => ({ name: ctx.string }));
class Note extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string, secret: ctx.string })),
	{ sensitive: ["secret"] },
) {}
const Notes = repositoryOf({ entity: Note, actions: ["create", "count"] });

const NotFound = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "NoteNotFound",
	message: "No such note.",
});

class AddNote extends useCaseOf({
	name: "AddNote",
	blueprint: blueprintOf((ctx) => ({ name: ctx.string, secret: ctx.string })),
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
		throw new Error("disk on fire: hunter2");
	}
}

class AddTwice extends useCaseOf({
	name: "AddTwice",
	blueprint: Name,
	response: blueprintOf(() => ({})),
	dependencies: { add: AddNote, missing: Missing },
}) {
	override async execute({
		add = this.dependencies.add,
		missing = this.dependencies.missing,
	} = {}) {
		await add({ name: this.input.name, secret: "s1" });
		await add({ name: this.input.name, secret: "s2" });
		if (this.input.name === "fail") await missing({});
		return {};
	}
}

const Notebook = commandOf({
	name: "Notebook",
	useCases: { add: AddNote, twice: AddTwice, broken: Broken },
});

function appWith(tracer: ITracer | null) {
	return applicationOf({
		name: "notes",
		entities: { Note },
		repositories: { Notes },
		useCases: { AddNote, Missing, Broken, AddTwice },
		commands: { Notebook },
		provider: inMemoryProvider(),
		...(tracer ? { trace: tracer } : {}),
	});
}

/** Each span as `name < parent name`, in the order they started. */
const tree = (spans: readonly MemorySpan[]) =>
	spans.map((span) =>
		span.parent ? `${span.name} < ${span.parent.name}` : span.name,
	);

describe("the trace of an application", () => {
	test("command, use case and repository spans, nested as the calls are", async () => {
		const tracer = memoryTracer();
		const app = appWith(tracer);
		await app.commands.Notebook.run("add", { name: "a", secret: "hunter2" });
		expect(tree(tracer.spans)).toEqual([
			"command Notebook.add",
			"use-case AddNote < command Notebook.add",
			"repository Note.create < use-case AddNote",
			"repository Note.count < use-case AddNote",
		]);
		expect(tracer.spans.map((span) => span.status)).toEqual([
			"ok",
			"ok",
			"ok",
			"ok",
		]);
		expect(tracer.spans.map((span) => span.attributes)).toEqual([
			{
				"afora.command": "Notebook.add",
				"afora.operation": "add",
				"afora.outcome": "ok",
			},
			{ "afora.use_case": "AddNote", "afora.outcome": "ok" },
			{
				"afora.repository": "Note",
				"afora.method": "create",
				"afora.use_case": "AddNote",
				"afora.outcome": "ok",
			},
			{
				"afora.repository": "Note",
				"afora.method": "count",
				"afora.use_case": "AddNote",
				"afora.outcome": "ok",
			},
		]);
	});

	test("a use case run by another nests in it", async () => {
		const tracer = memoryTracer();
		const app = appWith(tracer);
		await app.commands.Notebook.run("twice", { name: "a" });
		expect(tree(tracer.spans)).toEqual([
			"command Notebook.twice",
			"use-case AddTwice < command Notebook.twice",
			"use-case AddNote < use-case AddTwice",
			"repository Note.create < use-case AddNote",
			"repository Note.count < use-case AddNote",
			"use-case AddNote < use-case AddTwice",
			"repository Note.create < use-case AddNote",
			"repository Note.count < use-case AddNote",
		]);
	});

	test("a use case run outside a command starts its own trace", async () => {
		const tracer = memoryTracer();
		const app = appWith(tracer);
		await app.run(AddNote, { name: "a", secret: "x" });
		expect(tree(tracer.spans)).toEqual([
			"use-case AddNote",
			"repository Note.create < use-case AddNote",
			"repository Note.count < use-case AddNote",
		]);
	});

	test("a failure: status error, with the layer and name of the exception", async () => {
		const tracer = memoryTracer();
		const app = appWith(tracer);
		await expect(
			app.commands.Notebook.run("twice", { name: "fail" }),
		).rejects.toThrow();
		const failed = tracer.spans.filter((span) => span.status === "error");
		expect(tree(failed)).toEqual([
			"command Notebook.twice",
			"use-case AddTwice < command Notebook.twice",
			"use-case Missing < use-case AddTwice",
		]);
		for (const span of failed) {
			expect(span.attributes).toMatchObject({
				"afora.outcome": "error",
				"afora.exception.layer": "use-case",
				"afora.exception.name": "NoteNotFound",
				"afora.exception.unexpected": false,
			});
		}
	});

	test("an unexpected error is an UnexpectedError, without its message", async () => {
		const tracer = memoryTracer();
		const app = appWith(tracer);
		await expect(app.commands.Notebook.run("broken", {})).rejects.toThrow();
		expect(tracer.spans.map((span) => span.attributes)).toEqual([
			{
				"afora.command": "Notebook.broken",
				"afora.operation": "broken",
				"afora.outcome": "error",
				"afora.exception.layer": "use-case",
				"afora.exception.name": "UnexpectedError",
				"afora.exception.unexpected": true,
			},
			{
				"afora.use_case": "Broken",
				"afora.outcome": "error",
				"afora.exception.layer": "use-case",
				"afora.exception.name": "UnexpectedError",
				"afora.exception.unexpected": true,
			},
		]);
	});

	test("no input, argument or sensitive value in any span", async () => {
		const tracer = memoryTracer();
		const app = appWith(tracer);
		await app.commands.Notebook.run("add", {
			name: "visible-name",
			secret: "hunter2",
		});
		await app.commands.Notebook.run("broken", {}).catch(() => {});
		const text = JSON.stringify(
			tracer.spans.map((span) => [span.name, span.attributes]),
		);
		expect(text).not.toContain("hunter2");
		expect(text).not.toContain("visible-name");
	});

	test("a repository called outside a use case is not traced", async () => {
		const tracer = memoryTracer();
		const app = appWith(tracer);
		await app.repositories.Notes.count();
		expect(tracer.spans).toEqual([]);
	});

	test("a tracer that throws breaks nothing", async () => {
		const app = appWith({
			startSpan: () => {
				throw new Error("collector down");
			},
		});
		expect(
			await app.commands.Notebook.run("add", { name: "a", secret: "b" }),
		).toEqual({ count: 1 });
		const ending = appWith({
			startSpan: () => ({
				end: () => {
					throw new Error("collector down");
				},
			}),
		});
		expect(
			await ending.commands.Notebook.run("add", { name: "a", secret: "b" }),
		).toEqual({ count: 1 });
	});

	test("withSpan runs each call inside its span", async () => {
		const current: string[] = [];
		let active: string | undefined;
		const names = new WeakMap<ITraceSpan, string>();
		const tracer: ITracer = {
			startSpan(name) {
				const span: ITraceSpan = { end: () => {} };
				names.set(span, name);
				return span;
			},
			withSpan(span, run) {
				const previous = active;
				active = names.get(span);
				try {
					return run();
				} finally {
					active = previous;
				}
			},
		};
		class Peek extends useCaseOf({
			name: "Peek",
			blueprint: blueprintOf(() => ({})),
			response: blueprintOf(() => ({})),
		}) {
			override async execute() {
				current.push(active ?? "none");
				return {};
			}
		}
		const app = applicationOf({
			name: "peek",
			useCases: { Peek },
			commands: {
				Peeker: commandOf({ name: "Peeker", useCases: { peek: Peek } }),
			},
			trace: tracer,
		});
		await app.commands.Peeker.run("peek", {});
		expect(current).toEqual(["use-case Peek"]);
	});

	test("without a trace nothing is traced, and the started application's is used", async () => {
		const tracer = memoryTracer();
		const untraced = appWith(null);
		await untraced.commands.Notebook.run("add", { name: "a", secret: "b" });
		expect(tracer.spans).toEqual([]);
		// A use case class run outside any application: the started one traces it.
		const app = appWith(tracer);
		await app.start();
		await new AddNote({ name: "a", secret: "b" }).execute().catch(() => {});
		expect(tree(tracer.spans)[0]).toBe("use-case AddNote");
		await app.stop();
	});

	test("extends and extend keep the trace; describe gives it as opaque", () => {
		const tracer = memoryTracer();
		const base = appWith(tracer);
		expect(base.describe().trace).toEqual({ kind: "opaque" });
		expect(appWith(null).describe().trace).toBeUndefined();
		const child = applicationOf({ name: "child", extends: [base] });
		expect(child.describe().trace).toEqual({ kind: "opaque" });
		expect(base.extend().describe().trace).toEqual({ kind: "opaque" });
	});

	test("a trace that is not a tracer is rejected", () => {
		expect(() =>
			applicationOf({ name: "bad", trace: {} as unknown as ITracer }),
		).toThrow(InvalidTraceDeclaration);
		expect(() =>
			applicationOf({
				name: "bad",
				trace: { startSpan: () => ({ end() {} }), withSpan: 1 } as never,
			}),
		).toThrow(InvalidTraceDeclaration);
	});
});
