import { describe, expect, test } from "bun:test";
import {
	blueprintOf,
	environmentOf,
	type StepReferencesOf,
	type StepReferenceType,
	useCaseOf,
} from "../../../index";
import {
	Empty,
	hashPassword,
	InvalidCredentials,
	User,
	UserAlreadyExists,
	usersRepository,
} from "./steps.fixtures";

/** `strictSteps`: the references and values of the steps are checked by TypeScript. */
const Address = blueprintOf((ctx) => ({ zip: ctx.string }));
const SignUp = blueprintOf((ctx) => ({
	name: ctx.string,
	email: ctx.email,
	plainPassword: ctx.string,
	age: ctx.integer,
	address: Address,
	tags: ctx.list.string,
}));
const Tenant = blueprintOf((ctx) => ({ tenant: ctx.string }));
const Mail = environmentOf(
	blueprintOf((ctx) => ({ FROM: ctx.string, RETRIES: ctx.integer })),
	{ source: () => ({ FROM: "no-reply", RETRIES: "3" }) },
);
const Users = usersRepository();
const greet = (name: string, zip: string) => `${name}@${zip}`;

class Greeting extends useCaseOf({
	name: "Greeting",
	blueprint: blueprintOf((ctx) => ({ name: ctx.string })),
	response: blueprintOf((ctx) => ({ text: ctx.string })),
	strictSteps: true,
	steps: [{ return: { text: "$input.name" } }],
}) {}

class Register extends useCaseOf({
	name: "Register",
	blueprint: SignUp,
	response: blueprintOf((ctx) => ({
		user: User,
		greeting: ctx.string,
		hello: ctx.string,
		from: ctx.string,
	})),
	context: Tenant,
	dependencies: { users: Users, mail: Mail, greeting: Greeting },
	errors: [UserAlreadyExists, InvalidCredentials],
	strictSteps: true,
	steps: [
		{ find: "users.findByEmail", args: ["$input.email"], as: "existing" },
		{ ensure: "absent", value: "$existing.email", error: UserAlreadyExists },
		{
			run: "hash",
			fn: hashPassword,
			args: ["$input.plainPassword"],
			as: "hash",
		},
		{
			build: User,
			values: { name: "$input.name", email: "$input.email", password: "$hash" },
			as: "user",
		},
		{ change: "$user", key: "name", value: "$context.tenant", as: "renamed" },
		{ create: "users", value: "$renamed", as: "saved" },
		{ find: "users.findById", args: ["$saved.id"], as: "found" },
		{ ensure: "exists", value: "$found", error: InvalidCredentials },
		{
			invoke: "$found",
			method: "greet",
			args: ["$input.address.zip"],
			as: "hello",
		},
		{
			run: "greet",
			fn: greet,
			args: ["$found.name", "$input.tags.0"],
			as: "greeting",
		},
		{ call: "greeting", input: { name: "$hello" }, as: "called" },
		{
			return: {
				user: "$saved",
				greeting: "$called.text",
				hello: "$hello",
				from: "$env.mail.FROM",
			},
		},
	],
}) {}

describe("strictSteps", () => {
	test("strict steps run as the others", async () => {
		const result = await new Register(
			{
				name: "Ana",
				email: "ana@example.com",
				plainPassword: "p",
				age: 30,
				address: { zip: "01000" },
				tags: ["a"],
			},
			{ context: { tenant: "Acme" } },
		).execute();
		expect(result.user.name).toBe("Acme");
		expect(result.hello).toBe("01000, Acme");
		expect(result.greeting).toBe("01000, Acme");
		expect(result.from).toBe("no-reply");
	});

	test("strictSteps must be a boolean", () => {
		expect(() =>
			useCaseOf({
				name: "Case",
				blueprint: Empty,
				response: Empty,
				strictSteps: "yes" as never,
				steps: [{ return: {} }],
			}),
		).toThrow("Expected strictSteps to be a boolean.");
	});

	test("references are typed from the scope", () => {
		type Scope = {
			readonly input: { readonly name: string; readonly tags: string[] };
			readonly saved: User;
			readonly maybe: User | undefined;
		};
		const name: StepReferenceType<Scope, "$input.name"> = "Ana";
		const tag: StepReferenceType<Scope, "$input.tags.0"> = "a";
		const email: StepReferenceType<Scope, "$maybe.email"> = undefined;
		// @ts-expect-error: "nope" is not a key of the input
		const nope: StepReferenceType<Scope, "$input.nope"> = "x";
		const strings: StepReferencesOf<Scope, string>[] = [
			"$input.name",
			"$saved.email",
			"$saved.id",
		];
		// @ts-expect-error: a method is not a path of a record
		const method: StepReferencesOf<Scope> = "$saved.greet";
		expect([name, tag, email, nope, strings, method]).toHaveLength(6);
	});

	test("TypeScript rejects wrong references, args and values", () => {
		// Declared, not called: the runtime would reject some of them too.
		const declare = () => [
			useCaseOf({
				name: "Paths",
				blueprint: SignUp,
				response: Empty,
				dependencies: { users: Users, mail: Mail },
				strictSteps: true,
				steps: [
					// @ts-expect-error: no such key in the input
					{ find: "users.findByEmail", args: ["$input.emial"], as: "a" },
					// @ts-expect-error: no such key in a nested blueprint
					{ run: "g", fn: greet, args: ["$input.name", "$input.address.zipp"] },
					// @ts-expect-error: bound by a later step
					{ ensure: "exists", value: "$later", error: UserAlreadyExists },
					// @ts-expect-error: no such key in the result of an earlier step
					{ ensure: "exists", value: "$a.nope", error: UserAlreadyExists },
					{
						ensure: "exists",
						// @ts-expect-error: no context declared
						value: "$context.tenant",
						error: UserAlreadyExists,
					},
					{
						ensure: "exists",
						// @ts-expect-error: no such variable
						value: "$env.mail.NOPE",
						error: UserAlreadyExists,
					},
					{
						run: "later",
						fn: greet,
						args: ["$env.mail.FROM", "$input.name"],
						as: "later",
					},
					{ return: {} },
				],
			}),
			useCaseOf({
				name: "Args",
				blueprint: SignUp,
				response: Empty,
				dependencies: { users: Users },
				strictSteps: true,
				steps: [
					// @ts-expect-error: findByEmail takes a string
					{ find: "users.findByEmail", args: ["$input.age"], as: "a" },
					// @ts-expect-error: greet takes strings
					{ run: "g", fn: greet, args: ["$input.name", 1] },
					{
						build: User,
						values: { name: "a", email: "a@b.co", password: "p" },
						as: "u",
					},
					// @ts-expect-error: matches takes a string
					{ invoke: "$u", method: "matches", args: ["$input.age"], as: "ok" },
					// @ts-expect-error: not a method of User
					{ invoke: "$u", method: "nope", as: "x" },
					// @ts-expect-error: email is not a change key of User
					{ change: "$u", key: "email", value: "$input.email" },
					// @ts-expect-error: name takes a string
					{ change: "$u", key: "name", value: "$input.age" },
					{ return: {} },
				],
			}),
			useCaseOf({
				name: "Values",
				blueprint: SignUp,
				response: Empty,
				dependencies: { register: Greeting },
				strictSteps: true,
				steps: [
					{
						build: User,
						// @ts-expect-error: User has no key "nope"
						values: { name: "a", email: "a@b.co", password: "p", nope: 1 },
						as: "a",
					},
					{
						build: User,
						// @ts-expect-error: password is missing
						values: { name: "a", email: "a@b.co" },
						as: "b",
					},
					{
						build: User,
						// @ts-expect-error: name is a string
						values: { name: "$input.age", email: "a@b.co", password: "p" },
						as: "c",
					},
					// @ts-expect-error: the input of Greeting is { name: string }
					{ call: "register", input: { name: 1 } },
					{ return: {} },
				],
			}),
		];
		expect(typeof declare).toBe("function");
	});

	test("without strictSteps, references are checked only at declaration", () => {
		const declare = () =>
			useCaseOf({
				name: "Loose",
				blueprint: SignUp,
				response: Empty,
				steps: [{ return: "$input.address.zipp" }],
			});
		expect(declare).toThrow('names "zipp"');
	});
});
