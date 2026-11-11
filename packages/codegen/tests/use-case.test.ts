import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	applicationOf,
	blueprintOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	inMemoryProvider,
	repositoryOf,
	useCaseOf,
} from "@afora/core";
import { Value } from "typebox/value";
import {
	catalog,
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

const HASH_TS = `export const hashPassword = (plain: unknown) => \`hash:\${String(plain)}\`;

export const verify = (
	user: { hash: string },
	plain: unknown,
	call: { context?: { requestId?: string } },
) => user.hash === \`hash:\${String(plain)}\` && call.context !== undefined;
`;

const GREET_TS = `import { GreetBase } from "../domain/greet.use-case";

export class Greet extends GreetBase {
	override async execute() {
		return { greeting: \`Hello, \${this.input.name}!\` };
	}
}
`;

const EXTRA = { "src/hash.ts": HASH_TS, "src/handlers/greet.ts": GREET_TS };

/** Signs a user up and in; Greet is hand-written. */
const accounts: Spec = {
	version: 1,
	name: "accounts",
	output: { dir: "src/domain" },
	provider: "inMemory",
	entities: {
		User: {
			fields: { name: "text", email: "email", hash: "string" },
			unique: ["email"],
			change: ["name"],
			sensitive: ["hash"],
		},
	},
	repositories: {
		Users: {
			entity: "User",
			actions: ["findById", "findByEmail", "create", "update"],
		},
	},
	exceptions: {
		UserAlreadyExists: {
			layer: "use-case",
			message: "A user with this email already exists.",
		},
		InvalidCredentials: { layer: "use-case" },
	},
	useCases: {
		Register: {
			description: "Signs a user up.",
			tags: ["users"],
			input: {
				fields: { name: "text", email: "email", plainPassword: "string" },
			},
			response: { fields: { user: "User" } },
			dependencies: { users: "Users" },
			errors: ["UserAlreadyExists", "RepositoryUniqueViolation"],
			implementation: {
				steps: [
					{ find: "users.findByEmail", args: ["$input.email"], as: "existing" },
					{
						ensure: "absent",
						value: "$existing",
						error: "UserAlreadyExists",
						details: { email: "$input.email" },
					},
					{
						run: "hashPassword",
						fn: { import: "../hash#hashPassword" },
						args: ["$input.plainPassword"],
						params: { fields: { plain: "string" } },
						as: "hash",
					},
					{
						build: "User",
						values: {
							name: "$input.name",
							email: "$input.email",
							hash: "$hash",
						},
						as: "user",
					},
					{ create: "users", value: "$user", as: "saved" },
					{ return: { user: "$saved" } },
				],
			},
		},
		Login: {
			input: { fields: { email: "email", plainPassword: "string" } },
			response: { fields: { user: "User", requestId: "string" } },
			context: { fields: { requestId: "string" } },
			dependencies: { users: "Users" },
			errors: ["InvalidCredentials"],
			deprecated: true,
			implementation: {
				steps: [
					{ find: "users.findByEmail", args: ["$input.email"], as: "user" },
					{ ensure: "exists", value: "$user", error: "InvalidCredentials" },
					{
						run: "verify",
						fn: { import: "../hash#verify" },
						args: ["$user", "$input.plainPassword"],
						params: { fields: { user: "User", plain: "string" } },
						as: "ok",
					},
					{ ensure: "true", value: "$ok", error: "InvalidCredentials" },
					{
						return: { user: "$user", requestId: "$context.requestId" },
					},
				],
			},
		},
		Greet: {
			input: { fields: { name: "text" } },
			response: { fields: { greeting: "string" } },
			implementation: { import: "../handlers/greet#Greet" },
		},
	},
};

const IMPORTS = {
	"useCases.Register.run.hashPassword": "../hash#hashPassword",
	"useCases.Login.run.verify": "../hash#verify",
	"useCases.Greet": "../handlers/greet#Greet",
};

const canonical = (spec: Spec) => compactSpec(normalizeSpec(spec));

async function build(spec: Spec, extra: Record<string, string> = EXTRA) {
	const files = generate(spec);
	const dir = await makeProject(files, extra);
	projects.push(dir);
	return { dir, files, domain: await import(join(dir, "src/domain/index.ts")) };
}

/** Registers, rejects a duplicate, logs in with context, greets. */
async function exercise(domain: {
	App: {
		useCases: Record<
			"Register" | "Login" | "Greet",
			new (
				input: unknown,
				options?: unknown,
			) => { execute(): Promise<Record<string, unknown>> }
		>;
	};
}) {
	const { Register, Login, Greet } = domain.App.useCases;
	const input = { name: "Ana", email: "ana@example.com", plainPassword: "pw" };
	const registered = await new Register(input).execute();
	let duplicate: unknown;
	try {
		await new Register(input).execute();
	} catch (error) {
		duplicate = (error as { name: string; message: string }).message;
	}
	const login = await new Login(
		{ email: input.email, plainPassword: "pw" },
		{ context: { requestId: "r1" } },
	).execute();
	let wrong: unknown;
	try {
		await new Login(
			{ email: input.email, plainPassword: "nope" },
			{ context: { requestId: "r2" } },
		).execute();
	} catch (error) {
		wrong = (error as { name: string }).name;
	}
	return {
		registered: JSON.parse(JSON.stringify(registered)).user.name,
		masked: JSON.parse(JSON.stringify(registered)).user.hash,
		duplicate,
		login: (login.user as { email: string }).email,
		requestId: login.requestId,
		wrong,
		greeting: (await new Greet({ name: "Bia" }).execute()).greeting,
	};
}

const EXPECTED = {
	registered: "Ana",
	masked: "********",
	duplicate: "A user with this email already exists.",
	login: "ana@example.com",
	requestId: "r1",
	wrong: "InvalidCredentials",
	greeting: "Hello, Bia!",
};

// biome-ignore lint/suspicious/noExplicitAny: a JSON draft the tests mutate freely
type Draft = any;

const codes = (spec: unknown) =>
	validateSpec(spec).map((i) => `${i.code}@${i.path.join(".")}`);

describe("catalog", () => {
	test("lists the layers and the core exceptions", () => {
		const c = catalog();
		expect(c.exceptionLayers).toContain("use-case");
		expect(c.coreExceptions).toContain("RepositoryUniqueViolation");
		expect(c.coreExceptions).not.toContain("Exception");
		expect(c.reservedDeclarationNames).toContain("RepositoryUniqueViolation");
	});
});

describe("validation", () => {
	test("the fixture is valid and fits the schema", () => {
		expect(validateSpec(accounts)).toEqual([]);
		expect(Value.Check(specSchema, accounts)).toBe(true);
	});

	const edit = (change: (copy: Draft) => void, base: Spec = accounts): Spec => {
		const copy = JSON.parse(JSON.stringify(base));
		change(copy);
		return copy;
	};
	const steps = (copy: Draft, name = "Register") =>
		copy.useCases[name].implementation.steps as Draft[];

	const table: [string, (copy: Draft) => void, string][] = [
		[
			"exception layer",
			(c) => (c.exceptions.InvalidCredentials.layer = "x"),
			"invalid_layer@exceptions.InvalidCredentials.layer",
		],
		[
			"exception message",
			(c) => (c.exceptions.InvalidCredentials.message = ""),
			"invalid_message@exceptions.InvalidCredentials.message",
		],
		[
			"exception key",
			(c) => (c.exceptions.InvalidCredentials.x = 1),
			"unknown_key@exceptions.InvalidCredentials.x",
		],
		[
			"use case key",
			(c) => (c.useCases.Greet.x = 1),
			"unknown_key@useCases.Greet.x",
		],
		[
			"input is required",
			(c) => delete c.useCases.Greet.input,
			"invalid_blueprint@useCases.Greet.input",
		],
		[
			"unknown blueprint",
			(c) => (c.useCases.Greet.input = "Nope"),
			"unknown_blueprint@useCases.Greet.input",
		],
		[
			"blueprint of the wrong kind",
			(c) => (c.useCases.Greet.input = "User"),
			"wrong_kind@useCases.Greet.input",
		],
		[
			"inline field type",
			(c) => (c.useCases.Greet.input.fields.name = "Nope"),
			"unknown_type@useCases.Greet.input.fields.name.type",
		],
		[
			"tags",
			(c) => (c.useCases.Greet.tags = ["a", "a"]),
			"invalid_option@useCases.Greet.tags",
		],
		[
			"unknown dependency",
			(c) => (c.useCases.Greet.dependencies = { x: "Nope" }),
			"unknown_dependency@useCases.Greet.dependencies.x",
		],
		[
			"dependency of the wrong kind",
			(c) => (c.useCases.Greet.dependencies = { x: "User" }),
			"wrong_kind@useCases.Greet.dependencies.x",
		],
		[
			"unknown error",
			(c) => (c.useCases.Greet.errors = ["Nope"]),
			"unknown_exception@useCases.Greet.errors.0",
		],
		[
			"duplicate error",
			(c) => c.useCases.Register.errors.push("UserAlreadyExists"),
			"duplicate_error@useCases.Register.errors.2",
		],
		[
			"import reference",
			(c) => (c.useCases.Greet.implementation = { import: "nope" }),
			"invalid_import@useCases.Greet.implementation",
		],
		[
			"implementation",
			(c) => (c.useCases.Greet.implementation = 1),
			"invalid_implementation@useCases.Greet.implementation",
		],
		[
			"Base name taken",
			(c) => (c.blueprints = { GreetBase: { fields: {} } }),
			"name_collision@useCases.Greet.implementation",
		],
		[
			"unknown_step",
			(c) => steps(c).splice(0, 0, { nope: 1 }),
			"unknown_step@useCases.Register.implementation.steps.0",
		],
		[
			"two kinds",
			(c) => (steps(c)[0].create = "users"),
			"unknown_step@useCases.Register.implementation.steps.0",
		],
		[
			"invalid_reference",
			(c) => (steps(c)[0].args = ["$input..email"]),
			"invalid_reference@useCases.Register.implementation.steps.0.args",
		],
		[
			"unbound_reference",
			(c) => (steps(c)[0].args = ["$later"]),
			"unbound_reference@useCases.Register.implementation.steps.0.args",
		],
		[
			"unknown_key",
			(c) => (steps(c)[0].args = ["$input.nope"]),
			"unknown_key@useCases.Register.implementation.steps.0.args",
		],
		[
			"context without declaration",
			(c) => (steps(c)[0].args = ["$context.x"]),
			"invalid_reference@useCases.Register.implementation.steps.0.args",
		],
		[
			"unknown env dependency",
			(c) => (steps(c)[0].args = ["$env.users"]),
			"unknown_dependency@useCases.Register.implementation.steps.0.args",
		],
		[
			"unknown_dependency",
			(c) => (steps(c)[0].find = "nope.findByEmail"),
			"unknown_dependency@useCases.Register.implementation.steps.0.find",
		],
		[
			"unknown_action",
			(c) => (steps(c)[0].find = "users.findByName"),
			"unknown_action@useCases.Register.implementation.steps.0.find",
		],
		[
			"not a read action",
			(c) => (steps(c)[0].find = "users.hello"),
			"unknown_action@useCases.Register.implementation.steps.0.find",
		],
		[
			"write_in_find",
			(c) => (steps(c)[0].find = "users.create"),
			"write_in_find@useCases.Register.implementation.steps.0.find",
		],
		[
			"undeclared_error",
			(c) => (c.useCases.Register.errors = ["RepositoryUniqueViolation"]),
			"undeclared_error@useCases.Register.implementation.steps.1.error",
		],
		[
			"ensure error unknown",
			(c) => (steps(c)[1].error = "Nope"),
			"unknown_exception@useCases.Register.implementation.steps.1.error",
		],
		[
			"ensure other",
			(c) => (steps(c)[1].ensure = "equals"),
			"invalid_step@useCases.Register.implementation.steps.1",
		],
		[
			"ensure kind",
			(c) => (steps(c)[1].ensure = "maybe"),
			"invalid_step@useCases.Register.implementation.steps.1.ensure",
		],
		[
			"invalid_class",
			(c) => (steps(c)[3].build = "Users"),
			"invalid_class@useCases.Register.implementation.steps.3.build",
		],
		[
			"invalid_step_name",
			(c) => (steps(c)[0].as = "input"),
			"invalid_step_name@useCases.Register.implementation.steps.0.as",
		],
		[
			"duplicate name",
			(c) => (steps(c)[2].as = "existing"),
			"invalid_step_name@useCases.Register.implementation.steps.2.as",
		],
		[
			"run name",
			(c) => (steps(c)[2].run = "1x"),
			"invalid_step_name@useCases.Register.implementation.steps.2.run",
		],
		[
			"run.fn must be an import",
			(c) => (steps(c)[2].fn = "hashPassword"),
			"invalid_import@useCases.Register.implementation.steps.2.fn",
		],
		[
			"run.params of another length than args",
			(c) => (steps(c)[2].params = { fields: { a: "string", b: "string" } }),
			"invalid_args@useCases.Register.implementation.steps.2.params",
		],
		[
			"run with args and no params",
			(c) => delete steps(c)[2].params,
			"run_without_params@useCases.Register.implementation.steps.2.args",
		],
		[
			"run with a reference as args and no params",
			(c) => {
				delete steps(c)[2].params;
				steps(c)[2].args = "$input.tags";
			},
			"run_without_params@useCases.Register.implementation.steps.2.args",
		],
		[
			"run.params names no blueprint",
			(c) => (steps(c)[2].params = "Nope"),
			"unknown_blueprint@useCases.Register.implementation.steps.2.params",
		],
		[
			"run.fn import shape",
			(c) => (steps(c)[2].fn = { import: "x" }),
			"invalid_import@useCases.Register.implementation.steps.2.fn",
		],
		[
			"create without action",
			(c) => (c.repositories.Users.actions = ["findById", "findByEmail"]),
			"unknown_action@useCases.Register.implementation.steps.4.create",
		],
		[
			"call target",
			(c) => steps(c).splice(0, 0, { call: "users", input: {}, as: "x" }),
			"unknown_dependency@useCases.Register.implementation.steps.0.call",
		],
		[
			"invalid_value",
			(c) => (steps(c)[4].value = { a: undefined, b: new Date(0) }),
			"invalid_value@useCases.Register.implementation.steps.4.value",
		],
		[
			"invalid_step field",
			(c) => (steps(c)[0].nope = 1),
			"invalid_step@useCases.Register.implementation.steps.0.nope",
		],
		[
			"missing_return",
			(c) => steps(c).pop(),
			"missing_return@useCases.Register.implementation.steps.5",
		],
		[
			"misplaced_return",
			(c) => steps(c).splice(0, 0, { return: {} }),
			"misplaced_return@useCases.Register.implementation.steps.0",
		],
		[
			"steps not empty",
			(c) => (c.useCases.Register.implementation.steps = []),
			"missing_return@useCases.Register.implementation.steps",
		],
		[
			"change target",
			(c) =>
				steps(c).splice(5, 0, { change: "$user", key: "email", value: "x" }),
			"invalid_change_key@useCases.Register.implementation.steps.5.key",
		],
		[
			"change needs a reference",
			(c) =>
				steps(c).splice(5, 0, { change: "saved", key: "name", value: "x" }),
			"invalid_reference@useCases.Register.implementation.steps.5.change",
		],
		[
			"change ifPresent",
			(c) =>
				steps(c).splice(5, 0, {
					change: "$saved",
					key: "name",
					value: "x",
					ifPresent: "yes",
				}),
			"invalid_step@useCases.Register.implementation.steps.5.ifPresent",
		],
		[
			"args reference",
			(c) =>
				steps(c).splice(5, 0, {
					invoke: "$saved",
					method: "tag",
					args: "$nope",
				}),
			"unbound_reference@useCases.Register.implementation.steps.5.args",
		],
		[
			"invoke method",
			(c) => steps(c).splice(5, 0, { invoke: "$saved", method: "" }),
			"invalid_step@useCases.Register.implementation.steps.5.method",
		],
		[
			"use case cycle",
			(c) => {
				c.useCases.Register.dependencies.login = "Login";
				c.useCases.Login.dependencies.register = "Register";
			},
			"cycle@useCases.Login",
		],
		[
			"name taken",
			(c) => (c.exceptions.User = { layer: "use-case" }),
			"name_collision@exceptions.User",
		],
		[
			"core name reserved",
			(c) => (c.exceptions.RepositoryUniqueViolation = { layer: "use-case" }),
			"reserved_name@exceptions.RepositoryUniqueViolation",
		],
	];
	for (const [name, change, expected] of table) {
		test(name, () => {
			expect(codes(edit(change))).toContain(expected);
		});
	}

	test("forEachPage is not a step, with the reason", () => {
		const issues = validateSpec(
			edit((c) => (steps(c)[0].find = "users.forEachPage")),
		);
		const found = issues.find(
			(issue) =>
				issue.path.join(".") ===
				"useCases.Register.implementation.steps.0.find",
		);
		expect(found?.code).toBe("unknown_action");
		expect(found?.message).toContain("cannot be a step");
	});

	test("change key of a record built in an earlier step is checked", () => {
		const ok = edit((c) =>
			steps(c).splice(5, 0, { change: "$user", key: "name", value: "x" }),
		);
		expect(validateSpec(ok)).toEqual([]);
	});

	test("paths of input and context are checked at any depth", () => {
		const reference = (path: string) =>
			codes(
				edit((c) => {
					c.useCases.Register.input.fields.address = {
						fields: { zip: "string" },
					};
					c.useCases.Register.input.fields.tags = {
						type: "string",
						list: true,
					};
					c.useCases.Register.input.fields.owner = "User";
					c.useCases.Register.input.fields.by = {
						variant: {
							key: "type",
							of: { user: "User", note: { fields: { body: "text" } } },
						},
					};
					steps(c)[1].details = { at: path };
				}),
			);
		for (const valid of [
			"$input.address.zip",
			"$input.tags.0",
			"$input.tags.length",
			"$input.owner.name",
			"$input.owner.id",
			"$input.by.type",
			"$input.by.name",
			"$input.by.id",
			"$input.by.body",
		]) {
			expect(reference(valid)).toEqual([]);
		}
		for (const invalid of [
			"$input.email.domain",
			"$input.address.zipp",
			"$input.tags.first",
			"$input.tags.length.x",
			"$input.owner.nope",
			"$input.by.nope",
			"$input.by.body.x",
		]) {
			expect(reference(invalid)).toEqual([
				"unknown_key@useCases.Register.implementation.steps.1.details",
			]);
		}
	});

	test("an environment is a dependency of $env", () => {
		const spec = edit((c) => {
			c.environments = { Mail: { fields: { URL: "url" } } };
			c.useCases.Greet.dependencies = { mail: "Mail" };
			c.useCases.Greet.implementation = {
				steps: [{ return: { greeting: "$env.mail.URL" } }],
			};
		});
		expect(validateSpec(spec)).toEqual([]);
	});

	test("core exceptions are accepted in errors and ensure, as a name or { core }", () => {
		const named = edit((c) => {
			steps(c)[1].error = "RepositoryUniqueViolation";
			c.useCases.Register.errors = ["RepositoryUniqueViolation"];
		});
		expect(validateSpec(named)).toEqual([]);
		const wrapped = edit((c) => {
			steps(c)[1].error = { core: "RepositoryUniqueViolation" };
			c.useCases.Register.errors = ["RepositoryUniqueViolation"];
		});
		expect(validateSpec(wrapped)).toEqual([]);
	});
});

describe("normalization", () => {
	test("defaults are dropped; inline and named blueprints stay as written", () => {
		const spec: Spec = {
			version: 1,
			blueprints: { In: { fields: { a: "string" } } },
			exceptions: { Oops: { layer: "use-case", message: "Oops." } },
			useCases: {
				A: {
					tags: [],
					deprecated: false,
					input: "In",
					response: { fields: { a: "string" } },
					dependencies: {},
					errors: [],
					implementation: { steps: [{ return: { a: "$input.a" } }] },
				},
			},
		};
		const out = normalizeSpec(spec).useCases?.A as unknown as Record<
			string,
			unknown
		>;
		expect(out).toEqual({
			input: "In",
			response: { fields: { a: { type: "string" } } },
			implementation: { steps: [{ return: { a: "$input.a" } }] },
		});
		expect(normalizeSpec(spec).exceptions?.Oops).toEqual({ layer: "use-case" });
	});

	test("a core exception in a step is { core }", () => {
		const copy = JSON.parse(JSON.stringify(accounts));
		copy.useCases.Register.implementation.steps[1].error =
			"RepositoryUniqueViolation";
		const implementation = normalizeSpec(copy).useCases?.Register
			?.implementation as unknown as { steps: { error: unknown }[] };
		expect(implementation.steps[1]?.error).toEqual({
			core: "RepositoryUniqueViolation",
		});
	});
});

describe("generation", () => {
	test("emits exceptions, complete steps classes and abstract bases", () => {
		const files = Object.fromEntries(
			generate(accounts).map((f) => [f.path, f.contents]),
		);
		expect(files).toMatchSnapshot();
		expect(files["src/domain/greet.use-case.ts"]).toContain(
			"export abstract class GreetBase extends useCaseOf(",
		);
		expect(files["src/domain/use-cases.ts"]).toContain(
			'export { GreetBase } from "./greet.use-case";',
		);
		expect(files["src/domain/application.ts"]).toContain(
			'import { Greet } from "../handlers/greet";',
		);
		expect(files["src/domain/index.ts"]).toContain(
			'export { Greet } from "../handlers/greet";',
		);
	});

	test("clean for Biome and type-checks", async () => {
		const { dir } = await build(accounts);
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

	test("an import whose name is taken is aliased", () => {
		const spec = JSON.parse(JSON.stringify(accounts));
		spec.useCases.Greet.implementation = { import: "../handlers/greet#User" };
		const app = generate(spec).find((f) => f.path.endsWith("application.ts"));
		expect(app?.contents).toContain("User as");
	});
});

describe("JSON -> generate -> run -> extract", () => {
	test("registers, rejects, logs in with context and greets", async () => {
		const { domain } = await build(accounts);
		expect(await exercise(domain)).toEqual(EXPECTED);
	});

	test("the application describes it and extraction gives the spec back", async () => {
		const { domain } = await build(accounts);
		const described = domain.App.describe();
		expect(Object.keys(described.useCases).sort()).toEqual([
			"Greet",
			"Login",
			"Register",
		]);
		expect(described.useCases.Greet.implementation).toEqual({ kind: "opaque" });
		expect(described.exceptions.InvalidCredentials.message).toBe(
			"InvalidCredentials.",
		);
		const extracted = extractSpec(domain.App, { imports: IMPORTS });
		expect(extracted).toEqual(canonical(accounts));
	});

	test("extraction names the missing import", async () => {
		const { domain } = await build(accounts);
		expect(() => extractSpec(domain.App)).toThrow(ExtractionError);
		expect(() =>
			extractSpec(domain.App, {
				imports: { "useCases.Greet": "../handlers/greet#Greet" },
			}),
		).toThrow(
			/useCases\.Login\.run\.verify|useCases\.Register\.run\.hashPassword/,
		);
		expect(() =>
			extractSpec(domain.App, {
				imports: {
					"useCases.Register.run.hashPassword": "../hash#hashPassword",
					"useCases.Login.run.verify": "../hash#verify",
				},
			}),
		).toThrow(/useCases\.Greet/);
	});
});

describe("hand-written application -> extract -> generate", () => {
	const hashPassword = (plain: unknown) => `hash:${String(plain)}`;
	const verify = (
		user: { hash: string },
		plain: unknown,
		call: { context?: unknown },
	) => user.hash === `hash:${String(plain)}` && call.context !== undefined;

	const UserAlreadyExists = exceptionOf({
		layer: ExceptionLayers.UseCase,
		name: "UserAlreadyExists",
		message: "A user with this email already exists.",
	});
	const InvalidCredentials = exceptionOf({
		layer: ExceptionLayers.UseCase,
		name: "InvalidCredentials",
		message: () => "computed",
	});
	class User extends entityOf(
		blueprintOf((ctx) => ({
			name: ctx.text,
			email: ctx.email,
			hash: ctx.string,
		})),
		{ unique: ["email"], change: ["name"], sensitive: ["hash"] },
	) {}
	const Users = repositoryOf({
		entity: User,
		actions: ["findById", "findByEmail", "create", "update"],
	});
	class Register extends useCaseOf({
		name: "Register",
		description: "Signs a user up.",
		tags: ["users"],
		blueprint: blueprintOf((ctx) => ({
			name: ctx.text,
			email: ctx.email,
			plainPassword: ctx.string,
		})),
		response: blueprintOf(() => ({ user: User })),
		dependencies: { users: Users },
		errors: [UserAlreadyExists],
		steps: [
			{ find: "users.findByEmail", args: ["$input.email"], as: "existing" },
			{
				ensure: "absent",
				value: "$existing",
				error: UserAlreadyExists,
				details: { email: "$input.email" },
			},
			{
				run: "hashPassword",
				fn: hashPassword,
				args: ["$input.plainPassword"],
				params: blueprintOf((ctx) => ({ plain: ctx.string })),
				as: "hash",
			},
			{
				build: User,
				values: {
					name: "$input.name",
					email: "$input.email",
					hash: "$hash",
				},
				as: "user",
			},
			{ create: "users", value: "$user", as: "saved" },
			{ return: { user: "$saved" } },
		],
	}) {}
	class Login extends useCaseOf({
		name: "Login",
		blueprint: blueprintOf((ctx) => ({
			email: ctx.email,
			plainPassword: ctx.string,
		})),
		response: blueprintOf((ctx) => ({ user: User, requestId: ctx.string })),
		context: blueprintOf((ctx) => ({ requestId: ctx.string })),
		dependencies: { users: Users },
		errors: [InvalidCredentials],
		deprecated: true,
		steps: [
			{ find: "users.findByEmail", args: ["$input.email"], as: "user" },
			{ ensure: "exists", value: "$user", error: InvalidCredentials },
			{
				run: "verify",
				fn: verify,
				args: ["$user", "$input.plainPassword"],
				params: blueprintOf((ctx) => ({ user: User, plain: ctx.string })),
				as: "ok",
			},
			{ ensure: "true", value: "$ok", error: InvalidCredentials },
			{ return: { user: "$user", requestId: "$context.requestId" } },
		],
	}) {}
	class Greet extends useCaseOf({
		name: "Greet",
		blueprint: blueprintOf((ctx) => ({ name: ctx.text })),
		response: blueprintOf((ctx) => ({ greeting: ctx.string })),
	}) {
		async execute() {
			return { greeting: `Hello, ${this.input.name}!` };
		}
	}
	const App = applicationOf({
		name: "accounts",
		provider: inMemoryProvider(),
		entities: { User },
		repositories: { Users },
		exceptions: { UserAlreadyExists, InvalidCredentials },
		useCases: { Register, Login, Greet },
	});

	test("extracts the spec; a function message falls back to the default", () => {
		const spec = extractSpec(App, { imports: IMPORTS });
		expect(spec.exceptions).toEqual({
			UserAlreadyExists: {
				layer: "use-case",
				message: "A user with this email already exists.",
			},
			InvalidCredentials: { layer: "use-case" },
		});
		expect(validateSpec(spec)).toEqual([]);
		expect(spec.useCases?.Register?.input).toEqual({
			fields: {
				name: "text",
				email: "email",
				plainPassword: "string",
			},
		});
		expect(spec.useCases?.Greet?.implementation).toEqual({
			import: "../handlers/greet#Greet",
		});
		expect(spec.useCases?.Login?.deprecated).toBe(true);
	});

	test("the generated application behaves as the hand-written one", async () => {
		const spec = extractSpec(App, { imports: IMPORTS });
		const generated = await build(spec);
		expect(await exercise(generated.domain)).toEqual(EXPECTED);
		expect(await exercise({ App } as never)).toEqual(EXPECTED);
		// and the round trip is stable
		expect(extractSpec(generated.domain.App, { imports: IMPORTS })).toEqual(
			spec,
		);
	});
});

describe("a generated use case that depends on an imported one", () => {
	/** `Welcome` (steps) calls `Greet` (hand-written), and `Shout` (hand-written) depends on `Welcome`. */
	const composed: Spec = JSON.parse(JSON.stringify(accounts));
	(composed.useCases as Draft).Welcome = {
		input: { fields: { name: "text" } },
		response: { fields: { message: "string" } },
		dependencies: { greet: "Greet" },
		implementation: {
			steps: [
				{ call: "greet", input: { name: "$input.name" }, as: "greeted" },
				{ return: { message: "$greeted.greeting" } },
			],
		},
	};
	(composed.useCases as Draft).Shout = {
		input: { fields: { name: "text" } },
		response: { fields: { message: "string" } },
		dependencies: { welcome: "Welcome" },
		implementation: { import: "../handlers/shout#Shout" },
	};
	const SHOUT_TS = `import { ShoutBase } from "../domain/shout.use-case";

export class Shout extends ShoutBase {
	override async execute() {
		const { message } = await this.dependencies.welcome({ name: this.input.name });
		return { message: message.toUpperCase() };
	}
}
`;
	const extra = { ...EXTRA, "src/handlers/shout.ts": SHOUT_TS };

	test("is valid", () => {
		expect(validateSpec(composed)).toEqual([]);
	});

	test("the use cases a hand-written class needs have a file each; use-cases.ts imports the classes", () => {
		const files = Object.fromEntries(
			generate(composed).map((f) => [f.path, f.contents]),
		);
		expect(Object.keys(files).sort()).toContain(
			"src/domain/welcome.use-case.ts",
		);
		expect(files["src/domain/shout.use-case.ts"]).toContain(
			'import { Welcome } from "./welcome.use-case";',
		);
		expect(files["src/domain/welcome.use-case.ts"]).toContain(
			'import { Greet } from "../handlers/greet";',
		);
		expect(files["src/domain/welcome.use-case.ts"]).not.toContain(
			'"./use-cases"',
		);
		expect(files["src/domain/use-cases.ts"]).toContain(
			'export { Welcome } from "./welcome.use-case";',
		);
	});

	test("clean for Biome, type-checks and runs", async () => {
		const { dir, domain } = await build(composed, extra);
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

		const { Welcome, Shout } = domain.App.useCases;
		expect(await new Welcome({ name: "Ana" }).execute()).toEqual({
			message: "Hello, Ana!",
		});
		expect(await new Shout({ name: "Ana" }).execute()).toEqual({
			message: "HELLO, ANA!",
		});
		expect(await exercise(domain)).toEqual(EXPECTED);
		const extracted = extractSpec(domain.App, {
			imports: { ...IMPORTS, "useCases.Shout": "../handlers/shout#Shout" },
		});
		expect(extracted).toEqual(canonical(composed));
	}, 120_000);

	test("a handler importing its base from use-cases.ts still works when nothing depends on it", async () => {
		const legacy = GREET_TS.replace(
			'"../domain/greet.use-case"',
			'"../domain/use-cases"',
		);
		const { domain } = await build(accounts, {
			...EXTRA,
			"src/handlers/greet.ts": legacy,
		});
		expect(await exercise(domain)).toEqual(EXPECTED);
	});

	test("a module of hand-written classes that would import itself back is an import_cycle", () => {
		const copy: Draft = JSON.parse(JSON.stringify(composed));
		copy.useCases.Greet.implementation = { import: "../handlers/all#Greet" };
		copy.useCases.Shout.implementation = { import: "../handlers/all#Shout" };
		expect(codes(copy)).toEqual(["import_cycle@useCases.Shout.implementation"]);
	});

	test("one module written as `all`, `all/index` or `all.js` is one module for import_cycle", () => {
		for (const [greet, shout] of [
			["../handlers/all", "../handlers/all/index"],
			["../handlers/all/index.ts", "../handlers/all"],
			["../handlers/all.js", "../handlers/all.ts"],
			["../handlers/all.mts", "../handlers/./all"],
		]) {
			const copy: Draft = JSON.parse(JSON.stringify(composed));
			copy.useCases.Greet.implementation = { import: `${greet}#Greet` };
			copy.useCases.Shout.implementation = { import: `${shout}#Shout` };
			expect(codes(copy)).toEqual([
				"import_cycle@useCases.Shout.implementation",
			]);
		}
	});

	test("an import of a file the generator writes is a generated_file", () => {
		const greetFile: Draft = JSON.parse(JSON.stringify(accounts));
		greetFile.useCases.Greet.implementation = {
			import: "./greet.use-case#Greet",
		};
		expect(codes(greetFile)).toEqual([
			"generated_file@useCases.Greet.implementation",
		]);
		const fixed: Draft = JSON.parse(JSON.stringify(composed));
		fixed.useCases.Welcome.implementation.steps.unshift({
			run: "helper",
			fn: { import: "../domain/use-cases.js#helper" },
		});
		const issues = validateSpec(fixed).filter(
			(i) => i.code === "generated_file",
		);
		expect(issues.map((i) => i.path.join("."))).toEqual([
			"useCases.Welcome.implementation.steps.0.fn",
		]);
		expect(issues[0]?.message).toContain("use-cases.ts");
		// `./` and `./index` are the generated index.ts
		const index: Draft = JSON.parse(JSON.stringify(accounts));
		index.useCases.Greet.implementation = { import: "./#Greet" };
		expect(codes(index)).toEqual([
			"generated_file@useCases.Greet.implementation",
		]);
		// a file elsewhere with the same name is fine
		const elsewhere: Draft = JSON.parse(JSON.stringify(accounts));
		elsewhere.useCases.Greet.implementation = {
			import: "../handlers/greet.use-case#Greet",
		};
		expect(codes(elsewhere)).toEqual([]);
	});

	test("an imported use case can depend on another; each handler imports its base from its own file", async () => {
		const spec: Draft = JSON.parse(JSON.stringify(accounts));
		spec.useCases.Ahoy = {
			input: { fields: { name: "text" } },
			response: { fields: { message: "string" } },
			dependencies: { greet: "Greet" },
			implementation: { import: "../handlers/ahoy#Ahoy" },
		};
		const AHOY_TS = `import { AhoyBase } from "../domain/ahoy.use-case";

export class Ahoy extends AhoyBase {
	override async execute() {
		const { greeting } = await this.dependencies.greet({ name: this.input.name });
		return { message: \`\${greeting} Ahoy!\` };
	}
}
`;
		expect(validateSpec(spec)).toEqual([]);
		const { dir, domain } = await build(spec, {
			...EXTRA,
			"src/handlers/ahoy.ts": AHOY_TS,
		});
		expect(
			await new domain.App.useCases.Ahoy({ name: "Ana" }).execute(),
		).toEqual({ message: "Hello, Ana! Ahoy!" });
		expect(await exercise(domain)).toEqual(EXPECTED);
		// Loaded from any end: use-cases.ts first is fine too.
		const useCases = await import(join(dir, "src/domain/use-cases.ts"));
		expect(useCases.AhoyBase).toBeDefined();

		// The legacy import of GreetBase from use-cases.ts loops back through
		// ahoy.use-case.ts once another use case depends on Greet: loading
		// use-cases.ts (or the handler) first reaches Greet before it exists.
		const legacy = GREET_TS.replace(
			'"../domain/greet.use-case"',
			'"../domain/use-cases"',
		);
		const broken = await makeProject(generate(spec), {
			...EXTRA,
			"src/handlers/greet.ts": legacy,
			"src/handlers/ahoy.ts": AHOY_TS,
		});
		projects.push(broken);
		await expect(
			import(join(broken, "src/domain/use-cases.ts")),
		).rejects.toThrow();
	}, 120_000);

	test("two use cases with the same file are a file_collision", () => {
		const copy: Draft = JSON.parse(JSON.stringify(accounts));
		copy.useCases.GetURL = {
			input: { fields: {} },
			response: { fields: {} },
			implementation: { import: "../handlers/a#GetURL" },
		};
		copy.useCases.GetUrl = {
			input: { fields: {} },
			response: { fields: {} },
			implementation: { import: "../handlers/b#GetUrl" },
		};
		expect(codes(copy)).toEqual(["file_collision@useCases.GetUrl"]);
	});
});
