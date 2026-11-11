import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	inMemoryProvider,
	outputOf,
	Password,
	repositoryOf,
	resetApplication,
	useCaseOf,
} from "@afora/core";
import { hono } from "@afora/hono";
import { context, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Hono } from "hono";
import { otelTracer } from "../src/index";

afterEach(() => resetApplication());

class User extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.text,
		email: ctx.email,
		password: ctx.password,
	})),
	{ unique: ["email"] },
) {}

const Users = repositoryOf({
	entity: User,
	actions: ["findByEmail", "create"],
});

const EmailTaken = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "EmailTaken",
	message: "This email is taken.",
});

class HashPassword extends useCaseOf({
	name: "HashPassword",
	blueprint: blueprintOf((ctx) => ({ plain: ctx.string })),
	response: blueprintOf((ctx) => ({ hash: ctx.string })),
}) {
	override async execute() {
		return { hash: (await Password.hash(this.input.plain)).value };
	}
}

class Register extends useCaseOf({
	name: "Register",
	blueprint: blueprintOf((ctx) => ({
		name: ctx.text,
		email: ctx.email,
		plainPassword: ctx.string,
	})),
	response: blueprintOf(() => ({ user: User })),
	dependencies: { users: Users, hashPassword: HashPassword },
	errors: [EmailTaken],
}) {
	override async execute({
		users = this.dependencies.users,
		hashPassword = this.dependencies.hashPassword,
	} = {}) {
		const { plainPassword, ...data } = this.input;
		if (await users.findByEmail(data.email)) {
			throw new EmailTaken({ source: "Register" });
		}
		const { hash } = await hashPassword({ plain: plainPassword });
		return { user: await users.create({ ...data, password: hash }) };
	}
}

const Accounts = commandOf({
	name: "Accounts",
	useCases: { register: Register },
});
const Api = outputOf({
	name: "Api",
	commands: [Accounts],
	statuses: { EmailTaken: 409 },
	pipe: [hono()],
});

function traced() {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	const app = applicationOf({
		name: "accounts",
		entities: { User },
		exceptions: { EmailTaken },
		repositories: { Users },
		useCases: { Register, HashPassword },
		commands: { Accounts },
		outputs: { Api },
		provider: inMemoryProvider(),
		trace: otelTracer(provider.getTracer("test")),
	});
	const http = app.outputs.Api.build() as Hono;
	const register = (body: unknown) =>
		http.request("/accounts/register", {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
		});
	return { exporter, register };
}

const ana = {
	name: "Ana Example",
	email: "ana@example.com",
	plainPassword: "S3cret-pass!",
};

/** Each span as `name < parent name`, in the order they ended. */
function tree(spans: readonly ReadableSpan[]): string[] {
	const byId = new Map(spans.map((span) => [span.spanContext().spanId, span]));
	return spans.map((span) => {
		const parent = byId.get(span.parentSpanContext?.spanId ?? "");
		return parent ? `${span.name} < ${parent.name}` : span.name;
	});
}

describe("otelTracer", () => {
	test("one request to a Hono output is one trace: command, use cases, repository calls", async () => {
		const { exporter, register } = traced();
		const response = await register(ana);
		expect(response.status).toBe(200);
		const spans = exporter.getFinishedSpans();
		expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(
			1,
		);
		expect(tree(spans).sort()).toEqual(
			[
				"command Accounts.register",
				"use-case Register < command Accounts.register",
				"repository User.findByEmail < use-case Register",
				"use-case HashPassword < use-case Register",
				"repository User.create < use-case Register",
			].sort(),
		);
		const command = spans.find((span) => span.name.startsWith("command"));
		expect(command?.attributes).toEqual({
			"afora.command": "Accounts.register",
			"afora.operation": "register",
			"afora.outcome": "ok",
		});
		expect(command?.status.code).toBe(SpanStatusCode.UNSET);
		const repository = spans.find((span) => span.name.endsWith("User.create"));
		expect(repository?.attributes).toEqual({
			"afora.repository": "User",
			"afora.method": "create",
			"afora.use_case": "Register",
			"afora.outcome": "ok",
		});
	});

	test("a failure sets the status to error, with the layer and name of the exception", async () => {
		const { exporter, register } = traced();
		await register(ana);
		exporter.reset();
		const response = await register(ana);
		expect(response.status).toBe(409);
		const failed = exporter
			.getFinishedSpans()
			.filter((span) => span.status.code === SpanStatusCode.ERROR);
		expect(tree(failed).sort()).toEqual(
			[
				"command Accounts.register",
				"use-case Register < command Accounts.register",
			].sort(),
		);
		for (const span of failed) {
			expect(span.status.message).toBe("EmailTaken");
			expect(span.attributes).toMatchObject({
				"afora.outcome": "error",
				"afora.exception.layer": "use-case",
				"afora.exception.name": "EmailTaken",
				"afora.exception.unexpected": false,
			});
		}
	});

	test("no sensitive value, input or response appears in any span", async () => {
		const { exporter, register } = traced();
		const created = (await (await register(ana)).json()) as {
			user: { id: string };
		};
		await register(ana);
		const spans = exporter.getFinishedSpans();
		expect(spans.length).toBeGreaterThan(0);
		const text = JSON.stringify(
			spans.map((span) => ({
				name: span.name,
				attributes: span.attributes,
				status: span.status,
				events: span.events,
				links: span.links,
			})),
		);
		for (const value of [
			ana.plainPassword,
			"argon2",
			ana.email,
			ana.name,
			created.user.id,
		]) {
			expect(text).not.toContain(value);
		}
	});
});

describe("otelTracer with a context manager", () => {
	const manager = new AsyncLocalStorageContextManager();
	beforeAll(() => {
		context.setGlobalContextManager(manager.enable());
	});
	afterAll(() => {
		manager.disable();
		context.disable();
	});

	test("a command span is a child of the active span", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		const tracer = provider.getTracer("test");
		const app = applicationOf({
			name: "accounts",
			entities: { User },
			exceptions: { EmailTaken },
			repositories: { Users },
			useCases: { Register, HashPassword },
			commands: { Accounts },
			provider: inMemoryProvider(),
			trace: otelTracer(tracer),
		});
		await tracer.startActiveSpan("POST /accounts/register", async (outer) => {
			await app.commands.Accounts.run("register", ana);
			outer.end();
		});
		const spans = exporter.getFinishedSpans();
		expect(tree(spans)).toContain(
			"command Accounts.register < POST /accounts/register",
		);
	});

	test("your spans inside a use case nest in its span", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		const tracer = provider.getTracer("test");
		class Work extends useCaseOf({
			name: "Work",
			blueprint: blueprintOf(() => ({})),
			response: blueprintOf(() => ({})),
		}) {
			override async execute() {
				await Promise.resolve();
				tracer.startSpan("my work").end();
				return {};
			}
		}
		const app = applicationOf({
			name: "work",
			useCases: { Work },
			trace: otelTracer(tracer),
		});
		await app.run(Work, {});
		expect(tree(exporter.getFinishedSpans())).toEqual([
			"my work < use-case Work",
			"use-case Work",
		]);
	});
});
