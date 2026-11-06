import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
	compactSpec,
	ExtractionError,
	extractSpec,
	generate,
	normalizeSpec,
	type Spec,
	specSchema,
	validateSpec,
} from "../src";
import { BIOME, makeProject, removeProject, run } from "./project";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

const EVENTS_TS = `export const log: unknown[] = [];

export const dispatch = (events: readonly unknown[]) => {
	log.push(events.length);
};

export const onError = () => {};
`;

/** Accounts: a transactional command with a named context, plus the other event policies. */
const shop: Spec = {
	version: 1,
	name: "shop",
	output: { dir: "src/domain" },
	provider: "inMemory",
	blueprints: {
		RegisterInput: { fields: { name: "text", email: "email" } },
		Session: { fields: { requestId: "string" } },
	},
	entities: {
		User: { fields: { name: "text", email: "email" }, unique: ["email"] },
	},
	repositories: {
		Users: { entity: "User", actions: ["findById", "findByEmail", "create"] },
	},
	exceptions: { Boom: { layer: "use-case", message: "Boom!" } },
	useCases: {
		Register: {
			input: "RegisterInput",
			response: { fields: { user: "User" } },
			dependencies: { users: "Users" },
			implementation: {
				steps: [
					{
						build: "User",
						values: { name: "$input.name", email: "$input.email" },
						as: "user",
					},
					{ create: "users", value: "$user", as: "saved" },
					{ return: { user: "$saved" } },
				],
			},
		},
		RegisterAndFail: {
			input: "RegisterInput",
			response: { fields: { user: "User" } },
			dependencies: { users: "Users" },
			errors: ["Boom"],
			implementation: {
				steps: [
					{
						build: "User",
						values: { name: "$input.name", email: "$input.email" },
						as: "user",
					},
					{ create: "users", value: "$user", as: "saved" },
					{ ensure: "false", value: true, error: "Boom" },
					{ return: { user: "$saved" } },
				],
			},
		},
	},
	commands: {
		Accounts: {
			description: "Accounts.",
			tags: ["accounts"],
			context: "Session",
			useCases: { register: "Register", registerAndFail: "RegisterAndFail" },
			transaction: true,
		},
		Audit: {
			context: { fields: { actor: "text?" } },
			useCases: { register: "Register" },
			events: "manual",
		},
		Notifier: {
			useCases: { register: "Register" },
			events: { import: "../events#dispatch" },
		},
		Alerts: {
			useCases: { signUp: "Register" },
			onEventError: { import: "../events#onError" },
		},
	},
};

const IMPORTS = {
	"commands.Notifier.events": "../events#dispatch",
	"commands.Alerts.onEventError": "../events#onError",
};

const canonical = (spec: Spec) => compactSpec(normalizeSpec(spec));

async function build(
	spec: Spec,
	extra: Record<string, string> = { "src/events.ts": EVENTS_TS },
) {
	const files = generate(spec);
	const dir = await makeProject(files, extra);
	projects.push(dir);
	return { dir, files, domain: await import(join(dir, "src/domain/index.ts")) };
}

// biome-ignore lint/suspicious/noExplicitAny: the generated application is loaded dynamically
type Any = any;

/** Registers through the transactional command, rolls back a failing call, and reads the other commands. */
async function exercise(App: Any) {
	const accounts = App.commands.Accounts;
	const registered = await accounts.run(
		"register",
		{ name: "Ana", email: "ana@example.com" },
		{ context: { requestId: "r1" } },
	);
	let failure: unknown;
	try {
		await accounts.run(
			"registerAndFail",
			{ name: "Bia", email: "bia@example.com" },
			{ context: { requestId: "r2" } },
		);
	} catch (error) {
		failure = (error as { name: string }).name;
	}
	const users = App.repositories.Users;
	const audit = await App.commands.Audit.execute(
		"register",
		{ name: "Caio", email: "caio@example.com" },
		{ context: {} },
	);
	return {
		registered: JSON.parse(JSON.stringify(registered)).user.name,
		failure,
		rolledBack: !(await users.findByEmail("bia@example.com")),
		kept: (await users.findByEmail("ana@example.com")) !== null,
		auditValue: JSON.parse(JSON.stringify(audit.value)).user.email,
		operations: [...App.commands.Alerts.operations],
	};
}

const EXPECTED = {
	registered: "Ana",
	failure: "Boom",
	rolledBack: true,
	kept: true,
	auditValue: "caio@example.com",
	operations: ["signUp"],
};

// biome-ignore lint/suspicious/noExplicitAny: a JSON draft the tests mutate freely
type Draft = any;
const codes = (spec: unknown) =>
	validateSpec(spec).map((i) => `${i.code}@${i.path.join(".")}`);
const edit = (change: (copy: Draft) => void): Spec => {
	const copy = JSON.parse(JSON.stringify(shop));
	change(copy);
	return copy;
};

describe("commands: validation", () => {
	test("the fixture is valid and fits the schema", () => {
		expect(validateSpec(shop)).toEqual([]);
		expect(Value.Check(specSchema, shop)).toBe(true);
	});

	const table: [string, (copy: Draft) => void, string][] = [
		[
			"unknown key",
			(c) => (c.commands.Audit.x = 1),
			"unknown_key@commands.Audit.x",
		],
		[
			"use cases are required",
			(c) => delete c.commands.Audit.useCases,
			"invalid_use_cases@commands.Audit.useCases",
		],
		[
			"use cases cannot be empty",
			(c) => (c.commands.Audit.useCases = {}),
			"invalid_use_cases@commands.Audit.useCases",
		],
		[
			"unknown use case",
			(c) => (c.commands.Audit.useCases.register = "Nope"),
			"unknown_use_case@commands.Audit.useCases.register",
		],
		[
			"a use case of the wrong kind",
			(c) => (c.commands.Audit.useCases.register = "User"),
			"wrong_kind@commands.Audit.useCases.register",
		],
		[
			"operation name",
			(c) => (c.commands.Audit.useCases["not valid"] = "Register"),
			"invalid_operation@commands.Audit.useCases.not valid",
		],
		[
			"events",
			(c) => (c.commands.Audit.events = "sometimes"),
			"invalid_events@commands.Audit.events",
		],
		[
			"events import",
			(c) => (c.commands.Notifier.events = { import: "nope" }),
			"invalid_import@commands.Notifier.events",
		],
		[
			"onEventError with manual events",
			(c) => (c.commands.Audit.onEventError = { import: "../events#onError" }),
			"event_error_requires_after_commit@commands.Audit.onEventError",
		],
		[
			"onEventError with a handler",
			(c) =>
				(c.commands.Notifier.onEventError = { import: "../events#onError" }),
			"event_error_requires_after_commit@commands.Notifier.onEventError",
		],
		[
			"onEventError must be an import",
			(c) => (c.commands.Alerts.onEventError = "log"),
			"invalid_import@commands.Alerts.onEventError",
		],
		[
			"transaction",
			(c) => (c.commands.Accounts.transaction = "yes"),
			"invalid_option@commands.Accounts.transaction",
		],
		[
			"tags",
			(c) => (c.commands.Accounts.tags = ["a", "a"]),
			"invalid_option@commands.Accounts.tags",
		],
		[
			"context of an unknown blueprint",
			(c) => (c.commands.Accounts.context = "Nope"),
			"unknown_blueprint@commands.Accounts.context",
		],
		[
			"a name used by another declaration",
			(c) => (c.commands.Users = c.commands.Audit),
			"name_collision@commands.Users",
		],
	];
	test.each(table)("%s", (_name, change, expected) => {
		expect(codes(edit(change))).toContain(expected);
	});

	test("every use case an application would need is checked, never the provider", () => {
		// transaction: true cannot be checked without the provider; it is left to commandOf.
		expect(codes(edit((c) => delete c.provider))).toEqual([]);
	});
});

describe("commands: normalization", () => {
	test("drops the defaults", () => {
		const spec = edit((c) => {
			c.commands.Accounts.events = "after-commit";
			c.commands.Audit.transaction = false;
			c.commands.Audit.tags = [];
		});
		const out = canonical(spec) as Draft;
		expect(out.commands.Accounts.events).toBeUndefined();
		expect(out.commands.Audit.transaction).toBeUndefined();
		expect(out.commands.Audit.tags).toBeUndefined();
		expect(canonical(spec)).toEqual(canonical(shop));
	});
});

describe("commands: generate", () => {
	test("writes commands.ts and registers them in the application", () => {
		const files = generate(shop);
		const commands = files.find((f) => f.path.endsWith("commands.ts"));
		expect(commands?.contents).toMatchSnapshot();
		const app = files.find((f) => f.path.endsWith("application.ts"));
		expect(app?.contents).toContain("commands: {");
		expect(files.find((f) => f.path.endsWith("index.ts"))?.contents).toContain(
			'"./commands"',
		);
	});

	test("clean for Biome and type-checks", async () => {
		const { dir } = await build(shop);
		await Bun.write(
			join(dir, "biome.json"),
			JSON.stringify({
				formatter: { indentStyle: "tab" },
				javascript: { formatter: { quoteStyle: "double" } },
				linter: { rules: { preset: "recommended" } },
				assist: { actions: { source: { organizeImports: "on" } } },
			}),
		);
		const biome = await run(
			dir,
			BIOME,
			"check",
			`--config-path=${dir}`,
			join(dir, "src/domain"),
		);
		expect(biome.output).not.toContain("error");
		expect(biome.code).toBe(0);
		const tsc = await run(dir, "bunx", "tsc", "--noEmit", "-p", dir);
		expect(tsc.output).toBe("");
		expect(tsc.code).toBe(0);
	}, 120_000);
});

describe("commands: round trip", () => {
	test("JSON -> generate -> run -> extract is equal", async () => {
		const { domain } = await build(shop);
		expect(await exercise(domain.App)).toEqual(EXPECTED);
		expect(domain.Accounts.transaction).toBe(true);
		const extracted = extractSpec(domain.App, { imports: IMPORTS });
		expect(canonical(extracted)).toEqual(canonical(shop));
	});

	test("a handler needs an import mapping", async () => {
		const { domain } = await build(shop);
		expect(() => extractSpec(domain.App)).toThrow(ExtractionError);
		expect(() => extractSpec(domain.App)).toThrow("cannot be described");
	});

	test("a hand-written application extracts to the same behavior", async () => {
		const { dir } = await build(shop);
		const handWritten = `import {
	applicationOf, blueprintOf, commandOf, entityOf, repositoryOf, useCaseOf, inMemoryProvider,
} from "@afora/core";

const RegisterInput = blueprintOf((ctx) => ({ name: ctx.text, email: ctx.email }));
const Session = blueprintOf((ctx) => ({ requestId: ctx.string }));
class User extends entityOf(blueprintOf((ctx) => ({ name: ctx.text, email: ctx.email })), {
	unique: ["email"],
}) {}
const Users = repositoryOf({ entity: User, actions: ["findById", "findByEmail", "create"] });
const Register = useCaseOf({
	name: "Register",
	blueprint: RegisterInput,
	response: blueprintOf(() => ({ user: User })),
	dependencies: { users: Users },
	steps: [
		{ build: User, values: { name: "$input.name", email: "$input.email" }, as: "user" },
		{ create: "users", value: "$user", as: "saved" },
		{ return: { user: "$saved" } },
	],
});
const Accounts = commandOf({
	name: "Accounts",
	context: Session,
	useCases: { register: Register },
	transaction: true,
});
export const Hand = applicationOf({
	name: "hand",
	provider: inMemoryProvider(),
	blueprints: { RegisterInput, Session },
	entities: { User },
	repositories: { Users },
	useCases: { Register },
	commands: { Accounts },
});
`;
		await Bun.write(join(dir, "src/hand.ts"), handWritten);
		const { Hand } = (await import(join(dir, "src/hand.ts"))) as Any;
		const spec = extractSpec(Hand);
		expect(spec.commands?.Accounts).toEqual({
			context: "Session",
			useCases: { register: "Register" },
			transaction: true,
		});
		expect(spec.useCases?.Register?.input).toBe("RegisterInput");
		const { domain } = await build(spec, {});
		const run = async (App: Any) => {
			const out = await App.commands.Accounts.run(
				"register",
				{ name: "Ana", email: "ana@example.com" },
				{ context: { requestId: "r1" } },
			);
			return JSON.parse(JSON.stringify(out)).user.email;
		};
		expect(await run(Hand)).toBe("ana@example.com");
		expect(await run(domain.App)).toBe("ana@example.com");
	});
});
