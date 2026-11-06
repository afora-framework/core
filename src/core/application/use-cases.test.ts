import { describe, expect, test } from "bun:test";
import * as Public from "../../index";
import {
	applicationOf,
	blueprintOf,
	ExceptionLayers,
	entityOf,
	environmentOf,
	exceptionOf,
	InvalidApplicationDeclaration,
	inMemoryProvider,
	PasswordHasherRequired,
	RepositoryUniqueViolation,
	repositoryOf,
	UnregisteredApplicationReference,
	UnregisteredUseCaseDependency,
	useCaseOf,
} from "../../index";
import { isDeclaredException } from "../exception/exception";
import { isExportedException } from "../exception/exported";

const Input = blueprintOf((ctx) => ({ name: ctx.string }));
const Empty = blueprintOf(() => ({}));
const Context = blueprintOf((ctx) => ({ userId: ctx.id }));
class User extends entityOf(Input) {}
const Env = environmentOf(
	blueprintOf((ctx) => ({ URL: ctx.string })),
	{
		source: () => ({ URL: "x" }),
	},
);
const Users = repositoryOf({
	entity: User,
	actions: ["findById", "create"],
});
const Taken = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "Taken",
	message: "Taken",
});
const Dynamic = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "Dynamic",
	message: ({ id }: { id: string }) => id,
});

const ChildBase = useCaseOf({
	name: "Child",
	blueprint: Empty,
	response: Empty,
	dependencies: { users: Users },
});
class Child extends ChildBase {
	override async execute() {
		return {};
	}
}
const RegisterBase = useCaseOf({
	name: "Register",
	blueprint: Input,
	response: blueprintOf(() => ({ user: User })),
	context: Context,
	description: "Signs a user up.",
	tags: ["users"],
	dependencies: { users: Users, child: Child, env: Env },
	errors: [Taken, RepositoryUniqueViolation],
});
class Register extends RegisterBase {
	override async execute() {
		return { user: new User(this.input) };
	}
}

/** A concrete class of the abstract declaration `Base`. */
function concrete(Base: abstract new (...args: never[]) => object) {
	abstract class Declared extends Base {}
	const Loose = Declared as unknown as new (...args: never[]) => object;
	class Concrete extends Loose {
		async execute() {
			return {};
		}
	}
	Object.assign(Concrete, { ...Base });
	return Concrete as unknown as Public.AnyUseCaseClass;
}

const parts = {
	entities: { User },
	environments: { Env },
	repositories: { Users },
	exceptions: { Taken },
	useCases: { Child, Register },
};
const make = (extra: object = {}) =>
	applicationOf({
		name: "app",
		...parts,
		...extra,
	} as never) as never as ReturnType<typeof makeTyped>;
const makeTyped = () => applicationOf({ name: "app", ...parts });

describe("applicationOf useCases and exceptions", () => {
	test("registers them by name", () => {
		const app = make();
		expect(Object.keys(app.useCases)).toEqual(["Child", "Register"]);
		expect(app.exceptions.Taken).toBe(Taken);
		expect(app.useCases.Register).toBe(Register);
	});

	test("the key must equal the name", () => {
		expect(() =>
			applicationOf({
				name: "app",
				...parts,
				useCases: { Child, Wrong: Register },
			} as never),
		).toThrow(InvalidApplicationDeclaration);
		expect(() =>
			applicationOf({
				name: "app",
				...parts,
				exceptions: { Wrong: Taken },
			} as never),
		).toThrow(InvalidApplicationDeclaration);
		expect(() =>
			applicationOf({
				name: "app",
				useCases: { Users },
			} as never),
		).toThrow(InvalidApplicationDeclaration);
	});

	test("every dependency must be registered", () => {
		const cases: [Record<string, unknown>, string][] = [
			[{ repositories: {} }, "users"],
			[{ environments: {} }, "env"],
			[{ useCases: { Register } }, "child"],
		];
		for (const [override, dependency] of cases) {
			try {
				applicationOf({ name: "app", ...parts, ...override } as never);
				throw new Error("unreachable");
			} catch (error) {
				expect(error).toBeInstanceOf(UnregisteredUseCaseDependency);
				const e = error as { layer: string; details: Record<string, string> };
				expect(e.layer).toBe(ExceptionLayers.Application);
				expect(e.details.useCase).toMatch(/Child|Register/);
				expect(e.details.dependency).toContain(dependency);
			}
		}
	});

	test("records held by blueprint, response or context must be registered", () => {
		const Held = Public.recordOf(Input);
		const Loose = concrete(
			useCaseOf({
				name: "Loose",
				blueprint: blueprintOf(() => ({ held: Held })),
				response: Empty,
			}),
		);
		expect(() =>
			applicationOf({ name: "x", useCases: { Loose } } as never),
		).toThrow(UnregisteredApplicationReference);
		const InContext = concrete(
			useCaseOf({
				name: "InContext",
				blueprint: Empty,
				response: Empty,
				context: blueprintOf(() => ({ held: Held })),
			}),
		);
		expect(() =>
			applicationOf({ name: "x", useCases: { InContext } } as never),
		).toThrow(UnregisteredApplicationReference);
		expect(
			applicationOf({
				name: "x",
				records: { Held },
				useCases: { Loose, InContext },
			} as never),
		).toBeDefined();
	});

	test("errors must be registered, unless the package exports them", () => {
		const { Taken: _taken, ...none } = { Taken };
		expect(() =>
			applicationOf({ name: "app", ...parts, exceptions: none } as never),
		).toThrow(UnregisteredApplicationReference);
		const Base = concrete(
			useCaseOf({
				name: "Core",
				blueprint: Empty,
				response: Empty,
				errors: [RepositoryUniqueViolation, PasswordHasherRequired],
			}),
		);
		expect(
			applicationOf({ name: "x", useCases: { Core: Base } } as never),
		).toBeDefined();
		expect(isExportedException(RepositoryUniqueViolation)).toBe(true);
		expect(isExportedException(Taken)).toBe(false);
	});

	test("every exception the package exports counts as exported", () => {
		const missing = Object.entries(Public)
			.filter(([, value]) => isDeclaredException(value))
			.filter(([, value]) => !isExportedException(value))
			.map(([name]) => name);
		expect(missing).toEqual([]);
	});

	test("validates the extended applications as a whole", () => {
		const Base = applicationOf({
			name: "base",
			entities: { User },
			repositories: { Users },
			exceptions: { Taken },
			environments: { Env },
			useCases: { Child },
		});
		const App = applicationOf({
			name: "app",
			extends: [Base],
			useCases: { Register },
		});
		expect(Object.keys(App.useCases)).toEqual(["Child", "Register"]);
		expect(App.describe().useCases.Child?.from).toBe("base");
	});

	test("without a provider the declared classes come back", () => {
		const app = make();
		expect(app.useCase(Register)).toBe(Register);
		expect(() => app.useCase(Taken as never)).toThrow(
			InvalidApplicationDeclaration,
		);
	});

	describe("binding", () => {
		test("binds repositories recursively, memoized and without mutating", async () => {
			const provider = inMemoryProvider();
			const app = make({ provider });
			const Bound = app.useCases.Register;
			expect(Bound).not.toBe(Register);
			expect(Bound.prototype).toBeInstanceOf(Register);
			expect(app.useCase(Register)).toBe(Bound);
			expect(app.useCases.Register).toBe(Bound);
			expect(Bound.useCaseName).toBe("Register");
			expect(Bound.name).toBe("Register");
			expect(Bound.dependencies.users).toBe(app.repositories.Users);
			expect(Bound.dependencies.env).toBe(Env);
			const BoundChild = Bound.dependencies.child;
			expect(BoundChild).toBe(app.useCases.Child);
			expect(BoundChild.dependencies.users).toBe(app.repositories.Users);
			// The originals are untouched.
			expect(Register.dependencies.users).toBe(Users);
			expect(Register.dependencies.child).toBe(Child);
		});

		test("a bound use case reads and writes through the application provider", async () => {
			const provider = inMemoryProvider();
			const Handler = useCaseOf({
				name: "Handler",
				blueprint: Input,
				response: Empty,
				dependencies: { users: Users },
			});
			class Impl extends Handler {
				override async execute({ users = this.dependencies.users } = {}) {
					await users.create(new User(this.input));
					return {};
				}
			}
			const app = applicationOf({
				name: "app",
				entities: { User },
				repositories: { Users },
				useCases: { Handler: Impl },
				provider,
			} as never) as never as {
				useCases: { Handler: typeof Impl };
				repositories: { Users: typeof Users };
			};
			// The name must equal the key.
			expect(app.useCases.Handler.useCaseName).toBe("Handler");
			await new app.useCases.Handler({ name: "Ana" }).execute();
			const stored = await provider.findMany(
				{ entity: User, name: "Users", unique: [], env: {} } as never,
				{ where: {}, withDeleted: true } as never,
			);
			expect(stored).toHaveLength(1);
			// The declared repository uses its own default provider.
			expect(
				await Users.findById("00000000-0000-7000-8000-000000000000"),
			).toBeUndefined();
		});
	});

	test("describe gives use cases and exceptions", () => {
		const description = make().describe();
		expect(description.exceptions).toEqual({
			Taken: { from: "app", layer: ExceptionLayers.UseCase, message: "Taken" },
		});
		const { Register: register, Child: child } = description.useCases;
		expect(register).toEqual({
			from: "app",
			name: "Register",
			description: "Signs a user up.",
			tags: ["users"],
			deprecated: false,
			input: {
				name: expect.objectContaining({ kind: "property", name: "string" }),
			},
			response: { user: { kind: "entity", ref: "User", optional: false } },
			context: { userId: expect.objectContaining({ kind: "property" }) },
			errors: [
				{ kind: "exception", ref: "Taken" },
				{ kind: "core", name: "RepositoryUniqueViolation" },
			],
			dependencies: {
				users: { kind: "repository", ref: "Users" },
				child: { kind: "use-case", ref: "Child" },
				env: { kind: "environment", ref: "Env" },
			},
			implementation: { kind: "opaque" },
		});
		expect(child).not.toHaveProperty("description");
		expect(child).not.toHaveProperty("context");
		expect(child?.errors).toEqual([]);
		expect(() => JSON.stringify(description)).not.toThrow();
	});

	test("describe names the registered blueprints used as input, response and context", () => {
		const app = make({ blueprints: { Input, Context } });
		const { Register: register, Child: child } = app.describe().useCases;
		expect(register?.refs).toEqual({ input: "Input", context: "Context" });
		expect(register?.input.name).toBeDefined();
		expect(child).not.toHaveProperty("refs");
	});

	test("an exception declared with a function has no message in describe", () => {
		const app = applicationOf({
			name: "x",
			exceptions: { Dynamic },
		});
		expect(app.describe().exceptions.Dynamic).toEqual({
			from: "x",
			layer: ExceptionLayers.Repository,
		});
	});
});
