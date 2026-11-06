import { describe, expect, test } from "bun:test";
import {
	blueprintOf,
	commandOf,
	DuplicateOperation,
	ExceptionLayers,
	exceptionOf,
	InvalidCommandContext,
	InvalidOutputStage,
	isOutput,
	listOf,
	type OperationDescriptor,
	operationOf,
	outputOf,
	outputValueOf,
	Password,
	PROBLEM_MEDIA_TYPE,
	problemOf,
	recordOf,
	StdStages,
	select,
	sinkOf,
	stageCatalogOf,
	stageDescriptionOf,
	statusOf,
	transformOf,
	UnknownCommandOperation,
	useCaseOf,
} from "../../index";
import { isExportedException } from "../exception/exported";
import { Kind } from "../symbols/kind";

const Empty = blueprintOf(() => ({}));
const Name = blueprintOf((ctx) => ({ name: ctx.string }));
const Ctx = blueprintOf((ctx) => ({ requestId: ctx.string }));
const Taken = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "Taken",
	message: "taken",
});

class Register extends useCaseOf({
	name: "Register",
	blueprint: Name,
	response: Name,
	description: "Registers.",
	tags: ["write", "shared"],
	errors: [Taken],
}) {
	override async execute() {
		if (this.input.name === "taken") throw new Taken({ source: "Register" });
		return { name: this.input.name };
	}
}
class Total extends useCaseOf({
	name: "Total",
	blueprint: Empty,
	response: blueprintOf((ctx) => ({ total: ctx.integer })),
	deprecated: true,
	context: Ctx,
}) {
	override async execute() {
		return { total: 3 };
	}
}
const Secret = recordOf(
	blueprintOf((ctx) => ({ label: ctx.string, password: ctx.password })),
);
const Reveal = useCaseOf({
	name: "Reveal",
	blueprint: Empty,
	response: blueprintOf(() => ({ inner: listOf(Secret) })),
});
class RevealSecret extends Reveal {
	override async execute() {
		return {
			inner: [new Secret({ label: "main", password: Password.demo().value })],
		};
	}
}

const Users = commandOf({
	name: "Users",
	description: "Accounts.",
	tags: ["accounts", "shared"],
	useCases: { register: Register, total: Total },
});
const Posts = commandOf({
	name: "Posts",
	context: Ctx,
	useCases: { reveal: RevealSecret },
});

describe("operations", () => {
	const Api = outputOf({ name: "Api", commands: [Users, Posts] });

	test("describes every operation of the commands, in order", () => {
		expect(isOutput(Api)).toBe(true);
		expect(Api[Kind]).toBe("output");
		expect(Api.outputName).toBe("Api");
		expect(Api.operations.map(({ id }) => id)).toEqual([
			"Users.register",
			"Users.total",
			"Posts.reveal",
		]);
		const [register, total, reveal] = Api.operations as [
			OperationDescriptor,
			OperationDescriptor,
			OperationDescriptor,
		];
		expect(register).toMatchObject({
			kind: "operation",
			version: 1,
			command: "Users",
			name: "register",
			useCase: "Register",
			description: "Registers.",
			tags: ["accounts", "shared", "write"],
			deprecated: false,
			errors: [Taken],
			meta: {},
		});
		expect(register.input).toBe(Name);
		expect(register.response).toBe(Name);
		expect(register.context).toBeUndefined();
		expect(Object.hasOwn(register, "context")).toBe(false);
		// The command description fills in, and the use case context is the fallback.
		expect(total.description).toBe("Accounts.");
		expect(total.deprecated).toBe(true);
		expect(total.context).toBe(Ctx);
		expect(reveal.description).toBeUndefined();
		expect(Object.hasOwn(reveal, "description")).toBe(false);
		// The command context wins.
		expect(reveal.context).toBe(Ctx);
	});

	test("descriptors, operations and the output are frozen", () => {
		expect(Object.isFrozen(Api)).toBe(true);
		expect(Object.isFrozen(Api.operations)).toBe(true);
		for (const operation of Api.operations) {
			expect(Object.isFrozen(operation)).toBe(true);
			expect(Object.isFrozen(operation.tags)).toBe(true);
			expect(Object.isFrozen(operation.meta)).toBe(true);
		}
	});

	test("invoke runs the command", async () => {
		const [register, total, reveal] = Api.operations as [
			OperationDescriptor,
			OperationDescriptor,
			OperationDescriptor,
		];
		expect(await register.invoke({ name: "Ana" })).toEqual({ name: "Ana" });
		expect(await total.invoke({}, { context: { requestId: "r" } })).toEqual({
			total: 3,
		});
		await expect(register.invoke({ name: "taken" })).rejects.toMatchObject({
			name: "Taken",
		});
		await expect(reveal.invoke({})).rejects.toBeInstanceOf(
			InvalidCommandContext,
		);
	});

	test("rejects bad declarations", () => {
		const bad = (settings: object) => () => outputOf(settings as never);
		const cases = [
			{ name: "", commands: [Users] },
			{ name: " ", commands: [Users] },
			{ name: 1, commands: [Users] },
			{ name: "Api", commands: Users },
			{ name: "Api", commands: [Register] },
			{ name: "Api", commands: [{}] },
			{ name: "Api", commands: [Users], statuses: [] },
			{ name: "Api", commands: [Users], statuses: { Taken: 200 } },
			{ name: "Api", commands: [Users], statuses: { Taken: 600 } },
			{ name: "Api", commands: [Users], statuses: { Taken: 409.5 } },
			{ name: "Api", commands: [Users], statuses: { Taken: "409" } },
			{ name: "Api", commands: [Users], pipe: "select" },
			{ name: "Api", commands: [Users], pipe: [{}] },
			{ name: "Api", commands: [Users], pipe: [{ kind: "sink" }] },
		];
		for (const settings of cases) {
			expect(bad(settings)).toThrow(InvalidOutputStage);
		}
		expect(bad(undefined as never)).toThrow(InvalidOutputStage);
	});

	test("two operations with one id are a DuplicateOperation", () => {
		const Same = commandOf({ name: "Users", useCases: { register: Register } });
		const attempt = () => outputOf({ name: "Api", commands: [Users, Same] });
		expect(attempt).toThrow(DuplicateOperation);
		expect(() => outputOf({ name: "Api", commands: [Users, Users] })).toThrow(
			DuplicateOperation,
		);
	});

	test("the exceptions are in the Output layer and exported", () => {
		for (const Declared of [InvalidOutputStage, DuplicateOperation]) {
			expect(Declared.layer).toBe(ExceptionLayers.Output);
			expect(isExportedException(Declared)).toBe(true);
		}
	});

	test("statuses are frozen copies", () => {
		const statuses = { Taken: 409 };
		const Out = outputOf({ name: "Api", commands: [Users], statuses });
		statuses.Taken = 500;
		expect(Out.statuses).toEqual({ Taken: 409 });
		expect(Object.isFrozen(Out.statuses)).toBe(true);
		expect(outputOf({ name: "Api", commands: [Users] }).statuses).toEqual({});
	});
});

describe("operationOf", () => {
	const [register] = outputOf({ name: "Api", commands: [Users] })
		.operations as [OperationDescriptor];

	test("returns a modified frozen copy", async () => {
		const invoke = async () => "patched";
		const patched = operationOf(register, {
			meta: { audited: true },
			tags: ["x"],
			description: "New.",
			deprecated: true,
			invoke,
		});
		expect(patched).not.toBe(register);
		expect(Object.isFrozen(patched)).toBe(true);
		expect(patched.meta).toEqual({ audited: true });
		expect(patched.tags).toEqual(["x"]);
		expect(patched.description).toBe("New.");
		expect(patched.deprecated).toBe(true);
		expect(await patched.invoke({})).toBe("patched");
		expect(patched.id).toBe(register.id);
		expect(patched.input).toBe(register.input);
		// The original is untouched.
		expect(register.meta).toEqual({});
		expect(register.deprecated).toBe(false);
		expect(operationOf(register, { description: undefined }).description).toBe(
			undefined,
		);
		expect(operationOf(register, {})).toEqual(register);
	});

	test("the identity cannot be patched", () => {
		for (const key of [
			"kind",
			"version",
			"id",
			"command",
			"name",
			"useCase",
			"input",
			"response",
			"context",
			"errors",
			"other",
		]) {
			expect(() => operationOf(register, { [key]: "x" } as never)).toThrow(
				InvalidOutputStage,
			);
		}
	});

	test("rejects wrong values", () => {
		const bad = [
			{ meta: null },
			{ meta: [] },
			{ tags: "a" },
			{ tags: [1] },
			{ description: 1 },
			{ deprecated: "yes" },
			{ invoke: 1 },
		];
		for (const patch of bad) {
			expect(() => operationOf(register, patch as never)).toThrow(
				InvalidOutputStage,
			);
		}
		expect(() => operationOf(register, null as never)).toThrow(
			InvalidOutputStage,
		);
		expect(() => operationOf({} as never, {})).toThrow(InvalidOutputStage);
	});
});

describe("stages", () => {
	const mark = transformOf<{ key: string }>({
		name: "mark",
		apply: (operation, { key }) =>
			operationOf(operation, { meta: { ...operation.meta, [key]: true } }),
	});
	const ids = sinkOf<string[], { upper?: boolean }>({
		name: "ids",
		build: (operations, { upper }, { output }) =>
			operations.map(
				({ id }) => `${output.name}:${upper ? id.toUpperCase() : id}`,
			),
	});

	test("select keeps by tags, operation ids and exclusions", () => {
		const run = (options: object) =>
			outputOf({
				name: "Api",
				commands: [Users, Posts],
				pipe: [select(options)],
			}).operations.map(({ id }) => id);
		expect(run({})).toEqual(["Users.register", "Users.total", "Posts.reveal"]);
		expect(run({ tags: ["write"] })).toEqual(["Users.register"]);
		expect(run({ tags: ["write", "accounts"] })).toEqual([
			"Users.register",
			"Users.total",
		]);
		expect(run({ tags: ["none"] })).toEqual([]);
		expect(run({ operations: ["Posts.reveal", "Users.total"] })).toEqual([
			"Users.total",
			"Posts.reveal",
		]);
		expect(run({ exclude: ["Users.total"] })).toEqual([
			"Users.register",
			"Posts.reveal",
		]);
		expect(run({ tags: ["accounts"], exclude: ["Users.total"] })).toEqual([
			"Users.register",
		]);
		for (const options of [
			{ tags: "a" },
			{ operations: [1] },
			{ exclude: {} },
			{ other: [] },
		]) {
			expect(() => select(options as never)).toThrow(InvalidOutputStage);
		}
	});

	test("transforms patch operations in order", () => {
		const Api = outputOf({
			name: "Api",
			commands: [Users],
			pipe: [
				mark({ key: "a" }),
				select({ tags: ["write"] }),
				mark({ key: "b" }),
			],
		});
		expect(Api.operations).toHaveLength(1);
		expect(Api.operations[0]?.meta).toEqual({ a: true, b: true });
		expect(Api.stages).toHaveLength(3);
	});

	test("a transform returns its own operation or null", () => {
		const swap = transformOf({
			name: "swap",
			apply: (operation) => ({ ...operation, id: "Other.id" }),
		});
		const nothing = transformOf({
			name: "nothing",
			apply: () => undefined as never,
		});
		for (const stage of [swap(), nothing()]) {
			expect(() =>
				outputOf({ name: "Api", commands: [Users], pipe: [stage] }),
			).toThrow(InvalidOutputStage);
		}
	});

	test("the sink must be the last stage and runs lazily, once", () => {
		let builds = 0;
		const count = sinkOf({
			name: "count",
			build: (operations) => {
				builds++;
				return operations.length;
			},
		});
		expect(() =>
			outputOf({
				name: "Api",
				commands: [Users],
				pipe: [count(), mark({ key: "a" })],
			}),
		).toThrow(InvalidOutputStage);
		expect(() =>
			outputOf({ name: "Api", commands: [Users], pipe: [count(), count()] }),
		).toThrow(InvalidOutputStage);

		const Api = outputOf({
			name: "Api",
			commands: [Users],
			pipe: [mark({ key: "a" }), count()],
		});
		expect(builds).toBe(0);
		const first: number = Api.build();
		expect(first).toBe(2);
		expect(Api.build()).toBe(2);
		expect(builds).toBe(1);
	});

	test("build without a sink throws, and a failed build is not memoized", () => {
		const Plain = outputOf({ name: "Api", commands: [Users] });
		expect(() => Plain.build()).toThrow(InvalidOutputStage);
		let fail = true;
		const flaky = sinkOf({
			name: "flaky",
			build: () => {
				if (fail) throw new Error("later");
				return "ok";
			},
		});
		const Api = outputOf({ name: "Api", commands: [Users], pipe: [flaky()] });
		expect(() => Api.build()).toThrow("later");
		fail = false;
		expect(Api.build()).toBe("ok");
	});

	test("the sink gets the name and statuses of the output", () => {
		const Api = outputOf({
			name: "Api",
			commands: [Users],
			statuses: { Taken: 409 },
			pipe: [
				sinkOf({
					name: "context",
					build: (_operations, _options, context) => context,
				})(),
			],
		});
		expect(Api.build()).toEqual({
			output: { name: "Api", statuses: { Taken: 409 } },
		});
	});

	test("pipe adds stages ad hoc", () => {
		const Api = outputOf({
			name: "Api",
			commands: [Users, Posts],
			pipe: [mark({ key: "a" })],
		});
		// Transforms only: a new, unnamed output; the original is untouched.
		const Narrow = Api.pipe(select({ tags: ["write"] }));
		expect(isOutput(Narrow)).toBe(true);
		expect(Narrow).not.toBe(Api);
		expect(Narrow.outputName).toBe("");
		expect(Narrow.operations.map(({ id }) => id)).toEqual(["Users.register"]);
		expect(Narrow.operations[0]?.meta).toEqual({ a: true });
		expect(Narrow.stages).toHaveLength(2);
		expect(Api.operations).toHaveLength(3);
		// A sink builds right away.
		const built: string[] = Api.pipe(select({ tags: ["write"] }), ids());
		expect(built).toEqual(["Api:Users.register"]);
		const upper = Api.pipe(ids({ upper: true }));
		expect(upper[0]).toBe("Api:USERS.REGISTER");
		// And is not memoized in the output.
		expect(() => Api.build()).toThrow(InvalidOutputStage);
		// Nothing can follow a sink.
		const WithSink = outputOf({
			name: "Api",
			commands: [Users],
			pipe: [ids()],
		});
		expect(() => WithSink.pipe(mark({ key: "a" }))).toThrow(InvalidOutputStage);
		expect(() => Api.pipe(ids(), mark({ key: "a" }) as never)).toThrow(
			InvalidOutputStage,
		);
	});

	test("hand-written stages are accepted and opaque", () => {
		const handmade = {
			kind: "transform",
			apply: (operation: unknown) => operation,
		};
		const Api = outputOf({
			name: "Api",
			commands: [Users],
			pipe: [handmade as never],
		});
		expect(Api.operations).toHaveLength(2);
		expect(stageDescriptionOf(handmade as never)).toEqual({ kind: "opaque" });
	});
});

describe("stage descriptions and catalogs", () => {
	test("a stage carries its name and frozen JSON options", () => {
		const stage = select({ tags: ["public"] });
		expect(stage).toMatchObject({
			kind: "transform",
			name: "select",
			options: { tags: ["public"] },
		});
		expect(stageDescriptionOf(stage)).toEqual({
			kind: "transform",
			name: "select",
			options: { tags: ["public"] },
		});
		expect(Object.isFrozen(stage)).toBe(true);
		expect(Object.isFrozen(stage.options)).toBe(true);
		expect(Object.isFrozen(stage.options?.tags)).toBe(true);
		expect(select().options).toEqual({});
		const sink = sinkOf({ name: "x", build: () => 1 })({});
		expect(stageDescriptionOf(sink)).toEqual({
			kind: "sink",
			name: "x",
			options: {},
		});
	});

	test("options are copied", () => {
		const tags = ["a"];
		const stage = select({ tags });
		tags.push("b");
		expect(stage.options?.tags).toEqual(["a"]);
	});

	test("options must be JSON", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const make = sinkOf<number, Record<string, unknown>>({
			name: "x",
			build: () => 1,
		});
		const bad: unknown[] = [
			{ f: () => 1 },
			{ n: Number.NaN },
			{ n: Number.POSITIVE_INFINITY },
			{ u: undefined },
			{ d: new Date() },
			{ s: Symbol("x") },
			cyclic,
			[1],
			"text",
		];
		for (const options of bad) {
			expect(() => make(options as never)).toThrow(InvalidOutputStage);
		}
		expect(make({ nested: { list: [1, "a", null, true] } }).options).toEqual({
			nested: { list: [1, "a", null, true] },
		});
	});

	test("factories need a name and a function", () => {
		for (const make of [
			() => transformOf({ name: "", apply: () => null }),
			() => transformOf({ name: "x" } as never),
			() => sinkOf({ name: " ", build: () => 1 }),
			() => sinkOf({ name: "x" } as never),
			() => transformOf(undefined as never),
		]) {
			expect(make).toThrow(InvalidOutputStage);
		}
	});

	test("a catalog resolves names to stages", () => {
		const one = sinkOf({ name: "one", build: () => 1 });
		const catalog = stageCatalogOf(select, one);
		expect(catalog[Kind]).toBe("stage-catalog");
		expect(Object.keys(catalog.stages)).toEqual(["select", "one"]);
		expect(catalog.list).toEqual([select, one]);
		const stage = catalog.resolve("select", { tags: ["a"] });
		expect(stageDescriptionOf(stage)).toEqual({
			kind: "transform",
			name: "select",
			options: { tags: ["a"] },
		});
		expect(stageDescriptionOf(catalog.resolve("one")).kind).toBe("sink");
		expect(() => catalog.resolve("missing")).toThrow(InvalidOutputStage);
		expect(() => catalog.resolve("toString")).toThrow(InvalidOutputStage);
		expect(() => stageCatalogOf((() => 1) as never)).toThrow(
			InvalidOutputStage,
		);
		expect(() => stageCatalogOf(select, select)).toThrow(InvalidOutputStage);
	});

	test("StdStages holds the built-in stages", () => {
		expect(Object.keys(StdStages.stages)).toContain("select");
		expect(StdStages.stages.select).toBe(select);
		expect(StdStages.resolve("select", { tags: ["a"] }).kind).toBe("transform");
	});
});

describe("statusOf", () => {
	const Declared = exceptionOf({
		layer: ExceptionLayers.UseCase,
		name: "Declared",
		message: "declared",
	});
	const named = (name: string, details?: unknown) =>
		new (exceptionOf({
			layer: ExceptionLayers.UseCase,
			name,
			message: name,
		}))({ source: "t", details } as never);
	const operation = { errors: [Declared] };

	test("follows the table", () => {
		expect(statusOf(named("InvalidUseCaseInput"))).toBe(400);
		expect(statusOf(named("InvalidUseCaseContext"))).toBe(400);
		expect(statusOf(named("InvalidCommandContext"))).toBe(400);
		expect(statusOf(named("Anything", { issues: [] }))).toBe(400);
		expect(statusOf(named("Anything", { issues: "no" }))).toBe(500);
		expect(statusOf(named("RepositoryEntityNotFound"))).toBe(404);
		expect(
			statusOf(
				new UnknownCommandOperation({
					source: "t",
					details: { operation: "x" },
				}),
			),
		).toBe(404);
		expect(statusOf(named("RepositoryUniqueViolation"))).toBe(409);
		expect(statusOf(new Declared({ source: "t" }), operation)).toBe(422);
		expect(statusOf(named("Declared"), operation)).toBe(422);
		expect(statusOf(new Declared({ source: "t" }))).toBe(500);
		expect(statusOf(named("Other"), operation)).toBe(500);
		expect(statusOf(named("CommandEventFailed"))).toBe(500);
		expect(statusOf(new Error("boom"))).toBe(500);
		expect(statusOf("text")).toBe(500);
		expect(statusOf(undefined)).toBe(500);
	});

	test("a real call fails with the mapped status", async () => {
		const Api = outputOf({ name: "Api", commands: [Users, Posts] });
		const [register, , reveal] = Api.operations as [
			OperationDescriptor,
			OperationDescriptor,
			OperationDescriptor,
		];
		const input = await register.invoke({ name: 1 }).catch((e: unknown) => e);
		expect(statusOf(input, register)).toBe(400);
		const context = await reveal.invoke({}).catch((e: unknown) => e);
		expect(statusOf(context, reveal)).toBe(400);
		const taken = await register.invoke({ name: "taken" }).catch((e) => e);
		expect(statusOf(taken, register)).toBe(422);
	});

	test("statuses override everything, by exception name", () => {
		const statuses = { Declared: 409, InvalidUseCaseInput: 422, Other: 503 };
		expect(statusOf(new Declared({ source: "t" }), operation, statuses)).toBe(
			409,
		);
		expect(statusOf(named("InvalidUseCaseInput"), undefined, statuses)).toBe(
			422,
		);
		expect(statusOf(named("Other"), operation, statuses)).toBe(503);
		expect(
			statusOf(named("RepositoryEntityNotFound"), operation, statuses),
		).toBe(404);
		expect(statusOf(new Error("x"), operation, { Error: 400 })).toBe(500);
		expect(statusOf(named("toString"), operation, {})).toBe(500);
	});
});

describe("problemOf", () => {
	const issue = {
		path: ["email"],
		code: "invalid_value",
		message: "Invalid email.",
		source: "email",
		cause: new Error("secret cause"),
		value: "leaky@example.com",
	};
	const invalid = new (exceptionOf({
		layer: ExceptionLayers.UseCase,
		name: "InvalidUseCaseInput",
		message: "Invalid input.",
	}))({ source: "Register", details: { issues: [issue] } } as never);

	test("is an RFC 9457 object", () => {
		const taken = new Taken({ source: "Register" });
		expect(problemOf(taken, { status: 409 })).toEqual({
			type: "urn:afora:exception:Taken",
			title: "Taken",
			status: 409,
			detail: "taken",
			layer: "use-case",
		});
		expect(PROBLEM_MEDIA_TYPE).toBe("application/problem+json");
	});

	test("issues only for a 400, without causes or values", () => {
		const problem = problemOf(invalid, { status: 400 });
		expect(problem.issues).toEqual([
			{ path: ["email"], code: "invalid_value", message: "Invalid email." },
		]);
		expect(JSON.stringify(problem)).not.toContain("leaky");
		expect(JSON.stringify(problem)).not.toContain("secret cause");
		expect(problemOf(invalid, { status: 422 }).issues).toBeUndefined();
		expect(
			problemOf(new Taken({ source: "x" }), { status: 400 }).issues,
		).toBeUndefined();
		expect(problem.trace).toBeUndefined();
	});

	test("trace only with debug", () => {
		const taken = new Taken({ source: "Register" });
		expect(problemOf(taken, { status: 409 }).trace).toBeUndefined();
		expect(
			problemOf(taken, { status: 409, debug: false }).trace,
		).toBeUndefined();
		expect(problemOf(taken, { status: 409, debug: true }).trace).toBe(
			taken.toString(),
		);
	});

	test("a 500 hides its message unless debug is set", () => {
		const secret = new Error("db password is hunter2");
		const hidden = problemOf(secret, { status: 500 });
		expect(hidden).toEqual({
			type: "urn:afora:exception:UnexpectedError",
			title: "UnexpectedError",
			status: 500,
			detail: "Internal error.",
		});
		expect(JSON.stringify(hidden)).not.toContain("hunter2");
		const shown = problemOf(secret, { status: 500, debug: true });
		expect(shown.detail).toBe("db password is hunter2");
		expect(shown.trace).toContain("hunter2");
		const exception = new Taken({ source: "x" });
		expect(problemOf(exception, { status: 500 }).detail).toBe(
			"Internal error.",
		);
		expect(problemOf(exception, { status: 503 }).detail).toBe(
			"Internal error.",
		);
		expect(problemOf(exception, { status: 500, debug: true }).detail).toBe(
			"taken",
		);
		expect(problemOf("text", { status: 500, debug: true }).detail).toBe("text");
	});

	test("goes with statusOf", () => {
		const status = statusOf(invalid);
		expect(problemOf(invalid, { status }).status).toBe(400);
	});
});

describe("outputValueOf", () => {
	test("masks a Password at depth and is plain JSON", async () => {
		const [reveal] = outputOf({ name: "Api", commands: [Posts] })
			.operations as [OperationDescriptor];
		const value = await reveal.invoke({}, { context: { requestId: "r" } });
		const json = outputValueOf(value) as {
			inner: { label: string; password: string }[];
		};
		expect(json.inner[0]?.label).toBe("main");
		expect(json.inner[0]?.password).not.toContain("argon2");
		expect(JSON.stringify(json)).not.toContain("Correct-horse");
		expect(JSON.stringify(json)).not.toContain("argon2");
		expect(Object.getPrototypeOf(json)).toBe(Object.prototype);
	});

	test("handles values without JSON", () => {
		expect(outputValueOf(undefined)).toBeUndefined();
		expect(outputValueOf({ a: 1, b: [null, "x"], c: undefined })).toEqual({
			a: 1,
			b: [null, "x"],
		});
	});
});
