import {
	applicationOf,
	blueprintOf,
	commandOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	inMemoryProvider,
	optionalOf,
	repositoryOf,
	useCaseOf,
} from "@afora/core";
import { anonymous } from "../support/anonymous-provider";
import { dispatch, onError } from "../support/events";
import { hashPassword, verify } from "../support/hash";
import { Rating } from "../support/rating";

/**
 * A hand-written application (no codegen) that uses what JSON cannot recreate:
 * a property with custom handlers, a provider created without `providerOf`, a
 * `run` function, a hand-written `execute`, an exception with a function
 * message and hand-written event handlers.
 */
const UserAlreadyExists = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UserAlreadyExists",
	message: "A user with this email already exists.",
});
const InvalidCredentials = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "InvalidCredentials",
	message: () => "computed at runtime",
});

const RegisterInput = blueprintOf((ctx) => ({
	name: ctx.text,
	email: ctx.email,
	plainPassword: ctx.string,
}));
const Session = blueprintOf((ctx) => ({ requestId: ctx.string }));

class User extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.text,
		email: ctx.email,
		hash: ctx.string,
		rating: optionalOf(Rating),
	})),
	{ unique: ["email"], change: ["name"], sensitive: ["hash"] },
) {}

const Users = repositoryOf({
	entity: User,
	provider: anonymous,
	actions: ["findById", "findByEmail", "count", "create", "update"],
});

class Register extends useCaseOf({
	name: "Register",
	description: "Signs a user up.",
	tags: ["users"],
	blueprint: RegisterInput,
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
			values: { name: "$input.name", email: "$input.email", hash: "$hash" },
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
	context: Session,
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

class Rate extends useCaseOf({
	name: "Rate",
	blueprint: blueprintOf((ctx) => ({ email: ctx.email, stars: ctx.integer })),
	response: blueprintOf(() => ({ user: User })),
	dependencies: { users: Users },
	errors: [InvalidCredentials],
}) {
	/** Hand-written: it reads, changes and stores the user by itself. */
	async execute() {
		const user = await this.dependencies.users.findByEmail(this.input.email);
		if (!user) throw new InvalidCredentials({ source: "Rate" });
		user.change.name(`${user.name} (${this.input.stars} stars)`);
		return { user: await this.dependencies.users.update(user) };
	}
}

class Greet extends useCaseOf({
	name: "Greet",
	blueprint: blueprintOf((ctx) => ({ name: ctx.text })),
	response: blueprintOf((ctx) => ({ greeting: ctx.string })),
}) {
	async execute() {
		return { greeting: `Hello, ${this.input.name}!` };
	}
}

const Accounts = commandOf({
	name: "Accounts",
	tags: ["accounts"],
	context: Session,
	useCases: { register: Register, login: Login, rate: Rate, greet: Greet },
});
const Notifier = commandOf({
	name: "Notifier",
	useCases: { register: Register },
	events: dispatch,
});
const Alerts = commandOf({
	name: "Alerts",
	useCases: { signUp: Register },
	onEventError: onError,
});

export const AccountsApp = applicationOf({
	name: "accounts",
	provider: inMemoryProvider(),
	properties: { Rating },
	blueprints: { RegisterInput, Session },
	entities: { User },
	repositories: { Users },
	exceptions: { UserAlreadyExists, InvalidCredentials },
	useCases: { Register, Login, Rate, Greet },
	commands: { Accounts, Notifier, Alerts },
});
