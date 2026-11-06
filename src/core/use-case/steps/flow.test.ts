import { describe, expect, test } from "bun:test";
import {
	blueprintOf,
	ExceptionLayers,
	inMemoryProvider,
	repositoryOf,
	UseCaseAlreadyExecuted,
	useCaseOf,
} from "../../../index";
import { ScopeKey } from "../scope";
import {
	Empty,
	hashPassword,
	loginOf,
	registerOf,
	User,
	UserAlreadyExists,
	UserResponse,
	usersRepository,
} from "./steps.fixtures";

const input = {
	name: "Ana",
	email: "ana@example.com",
	plainPassword: "s3cret",
};

describe("Register and Login as steps", () => {
	test("registers, stores, collects events and validates the response", async () => {
		const Users = usersRepository();
		const Register = registerOf(Users);
		const register = new Register(input);
		const { user } = await register.execute();
		expect(user).toBeInstanceOf(User);
		expect(user.toJSON()).toMatchObject({
			name: "Ana",
			email: "ana@example.com",
			password: expect.not.stringContaining("s3cret"),
		});
		expect(user.password).toBe(hashPassword("s3cret"));
		expect((await Users.findByEmail("ana@example.com"))?.id).toBe(user.id);
		expect(register.pullEvents().map((event) => event.name)).toEqual([
			"user.created",
		]);
	});

	test("an existing email fails with the declared error, in the use case frame", async () => {
		const Users = usersRepository();
		const Register = registerOf(Users);
		await new Register(input).execute();
		const error = await new Register(input).execute().catch((e) => e);
		expect(error.is(UserAlreadyExists)).toBe(true);
		expect(error.source).toBe("Register");
		expect(error.find(UserAlreadyExists).details).toEqual({
			email: "ana@example.com",
		});
		expect(
			error.trace.some(
				(frame: { layer: string }) => frame.layer === ExceptionLayers.UseCase,
			),
		).toBe(true);
	});

	test("an instance executes only once", async () => {
		const Register = registerOf(usersRepository());
		const register = new Register(input);
		await register.execute();
		expect(register.execute()).rejects.toBeInstanceOf(UseCaseAlreadyExecuted);
	});

	test("invalid input never reaches the steps", () => {
		const Register = registerOf(usersRepository());
		expect(() => new Register({ ...input, email: "no" })).toThrow();
	});

	test("repository methods can be overridden in execute", async () => {
		const Users = usersRepository();
		const Register = registerOf(Users);
		const found = await new Register(input).execute();
		const other = new Register({ ...input, email: "b@example.com" });
		let looked = 0;
		const { user } = await other.execute({
			users: {
				findByEmail: async () => {
					looked++;
					return undefined;
				},
			},
		});
		expect(looked).toBe(1);
		expect(user.id).not.toBe(found.user.id);
	});

	test("Login finds, invokes a method and returns", async () => {
		const Users = usersRepository();
		const Register = registerOf(Users);
		const Login = loginOf(Users);
		await new Register(input).execute();
		const { user } = await new Login({
			email: input.email,
			plainPassword: "s3cret",
		}).execute();
		expect(user.email).toBe(input.email);
		const wrong = await new Login({ email: input.email, plainPassword: "x" })
			.execute()
			.catch((e) => e);
		expect(wrong.name).toBe("InvalidCredentials");
		const missing = await new Login({
			email: "none@example.com",
			plainPassword: "x",
		})
			.execute()
			.catch((e) => e);
		expect(missing.name).toBe("InvalidCredentials");
	});

	test("a hand-written subclass can override the interpreter", async () => {
		const Register = registerOf(usersRepository());
		class Custom extends Register {
			override async execute() {
				return {
					user: new User({
						name: this.input.name,
						email: this.input.email,
						password: "x",
					}),
				};
			}
		}
		expect((await new Custom(input).execute()).user.password).toBe("x");
	});
});

describe("steps with context, child calls and scope", () => {
	const Context = blueprintOf((ctx) => ({ tenant: ctx.string }));

	test("a child call inherits the context and moves its events up", async () => {
		const Users = usersRepository();
		const Register = registerOf(Users);
		class Child extends useCaseOf({
			name: "Child",
			blueprint: Empty,
			response: blueprintOf((ctx) => ({ tenant: ctx.string })),
			context: Context,
			steps: [{ return: { tenant: "$context.tenant" } }],
		}) {}
		class Parent extends useCaseOf({
			name: "Parent",
			blueprint: Empty,
			response: blueprintOf((ctx) => ({
				tenant: ctx.string,
				user: User,
			})),
			context: Context,
			dependencies: { child: Child, register: Register },
			steps: [
				{ call: "child", input: {}, as: "inner" },
				{ call: "register", input, as: "registered" },
				{
					return: {
						tenant: "$inner.tenant",
						user: "$registered.user",
					},
				},
			],
		}) {}
		const parent = new Parent({}, { context: { tenant: "acme" } });
		const result = await parent.execute();
		expect(result.tenant).toBe("acme");
		expect(parent.pullEvents().map((event) => event.name)).toEqual([
			"user.created",
		]);
	});

	test("a scope applies to the repositories used by the steps", async () => {
		const declared = inMemoryProvider();
		const scoped = inMemoryProvider();
		const Users = repositoryOf({
			entity: User,
			provider: declared,
			actions: ["findByEmail", "create"],
		});
		const Register = class extends useCaseOf({
			name: "Register",
			blueprint: blueprintOf((ctx) => ({
				name: ctx.string,
				email: ctx.email,
			})),
			response: UserResponse,
			dependencies: { users: Users },
			steps: [
				{
					build: User,
					values: {
						name: "$input.name",
						email: "$input.email",
						password: { literal: "x" },
					},
					as: "user",
				},
				{ create: "users", value: "$user", as: "saved" },
				{ return: { user: "$saved" } },
			],
		}) {};
		const Scoped = Register as unknown as new (
			input: unknown,
			options: unknown,
		) => { execute(): Promise<{ user: User }> };
		const { user } = await new Scoped(
			{ name: "Ana", email: "a@example.com" },
			{ [ScopeKey]: { providers: new Map([[declared, scoped]]) } },
		).execute();
		expect(await Users.findByEmail("a@example.com")).toBeUndefined();
		const Reader = repositoryOf({
			entity: User,
			provider: scoped,
			actions: ["findByEmail"],
		});
		expect((await Reader.findByEmail("a@example.com"))?.id).toBe(user.id);
	});
});
