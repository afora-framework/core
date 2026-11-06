/**
 * Code as users write it, from the README. `perf` cases are valid code whose
 * edit cost is budgeted; every case records what the editor shows at its
 * probes (`/*@hover*\/`, `/*@complete*\/`, `/*@signature*\/`) and its
 * diagnostics, so that type changes keep the writing experience.
 */
export interface Case {
	readonly name: string;
	readonly perf: boolean;
	readonly code: string;
}

export const cases: readonly Case[] = [
	{
		name: "bare blueprint",
		perf: true,
		code: `import { blueprintOf } from "@afora/core";
blueprintOf((ctx) => ({}));
`,
	},
	{
		name: "quick start",
		perf: true,
		code: `import {
	blueprintOf,
	ExceptionLayers,
	exceptionOf,
	guard,
	listOf,
	Password,
	recordOf,
	type StandardSchemaV1,
} from "@afora/core";

const Address = blueprintOf((ctx) => ({ street: ctx.string, zip: ctx.string }));

const UserBlueprint = blueprintOf((ctx) => ({
	email: ctx.email,
	slug: ctx.slug,
	password: ctx.password,
	address: Address,
	tags: listOf(ctx.string, { maxItems: 5 }),
}));

export class User extends recordOf(UserBlueprint, {
	unique: ["email"],
	change: ["password"],
}) {}

const SignUpBody = blueprintOf((ctx) => ({
	email: ctx.email,
	slug: ctx.slug,
	plainPassword: ctx.string,
	address: Address,
	tags: listOf(ctx.string, { maxItems: 5 }),
}));

const UserAlreadyExists = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "UserAlreadyExists",
	message: "A user with this email or slug already exists.",
});

class UserRepository {
	readonly #users: User[] = [];

	save(user: User): User {
		for (const key of User.options./*@hover*/unique) {
			if (this.#users.some((saved) => saved[key] === user[key])) {
				throw new UserAlreadyExists({ source: "UserRepository" });
			}
		}
		this.#users.push(user);
		return user;
	}
}

const users = new UserRepository();

async function signUp({ plainPassword, ...data }: /*@hover*/SignUpData) {
	const password = await Password.hash(plainPassword);
	return users.save(new /*@hover*/User({ ...data, password: password.value }));
}

export function changePassword(user: User, value: string) {
	return guard(
		{ layer: ExceptionLayers.Output, source: "PATCH /password" },
		() =>
			guard({ layer: ExceptionLayers.UseCase, source: "ChangePassword" }, () =>
				user.change./*@hover*/password(value),
			),
	);
}

const /*@hover*/json = new User({
	email: "a@b.co",
	slug: "a",
	password: "x",
	address: { street: "s", zip: "z" },
	tags: [],
}).toJSON();

type SignUpData = StandardSchemaV1.InferOutput<typeof SignUpBody>;
`,
	},
	{
		name: "entity",
		perf: true,
		code: `import { blueprintOf, entityOf, listOf, optionalOf } from "@afora/core";

class User extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string, nickname: ctx.optional.string })),
	{ change: ["name"] },
) {}

const /*@hover*/user = new User({ name: "Jane" });
user./*@hover*/id;
user.change.name("Ann")./*@hover*/updatedAt;

class Post extends entityOf(
	blueprintOf((ctx) => ({
		title: ctx.string,
		author: User,
		reviewer: optionalOf(User),
		coauthors: listOf(User),
	})),
) {}
const /*@hover*/post = new Post({ title: "Hi", author: { name: "Jane" }, coauthors: [user] });
post./*@hover*/reviewer;
`,
	},
	{
		name: "repository",
		perf: true,
		code: `import { blueprintOf, entityOf, repositoryOf } from "@afora/core";

class User extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string, email: ctx.email, slug: ctx.slug })),
	{ unique: ["email"] },
) {}

const /*@hover*/Users = repositoryOf({
	entity: User,
	actions: ["findById", "findByEmail", "findBySlug", "findManyByName", "create", "update", "delete", "count"],
});

const user = await Users.create({ name: "Ana", email: "ana@example.com", slug: "ana" });
const /*@hover*/found = await Users.findByEmail("ana@example.com");
const /*@hover*/many = await Users.findManyByName("Ana");
`,
	},
	{
		name: "use case",
		perf: true,
		code: `import { blueprintOf, entityOf, useCaseOf } from "@afora/core";

const UserInput = blueprintOf((ctx) => ({ name: ctx.string }));
class User extends entityOf(UserInput) {}
const UserResponse = blueprintOf(() => ({ user: User }));

class CreateUser extends useCaseOf({
	name: "CreateUser",
	blueprint: UserInput,
	response: UserResponse,
}) {
	override async execute() {
		return { user: new User(this./*@hover*/input) };
	}
}

class RegisterUser extends useCaseOf({
	name: "RegisterUser",
	blueprint: UserInput,
	dependencies: { createUser: CreateUser },
	response: UserResponse,
}) {
	override async execute({ createUser = this.dependencies./*@hover*/createUser } = {}) {
		return await createUser(this.input);
	}
}

const operation = new RegisterUser({ name: "Ana" });
const { /*@hover*/user } = await operation.execute();
await new RegisterUser({ name: "Ana" }).execute({
	createUser: async (/*@hover*/input) => ({ user: new User(input) }),
});
`,
	},
	{
		name: "completions: blueprint context",
		perf: false,
		code: `import { blueprintOf } from "@afora/core";
blueprintOf((ctx) => ({ a: ctx./*@complete*/ }));
blueprintOf((ctx) => ({ a: ctx.optional./*@complete*/ }));
blueprintOf((ctx) => ({ a: ctx.list./*@complete*/ }));
blueprintOf((ctx) => ({ a: ctx.string(/*@signature*/) }));
blueprintOf((/*@hover*/ctx) => ({ a: ctx./*@hover*/email }));
`,
	},
	{
		name: "completions: records and repositories",
		perf: false,
		code: `import { blueprintOf, entityOf, repositoryOf } from "@afora/core";
class User extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string, email: ctx.email, slug: ctx.slug })),
	{ unique: ["email"], change: ["name"] },
) {}
const user = new User(/*@signature*/{ name: "a", email: "a@b.co", slug: "a" });
user./*@complete*/;
user.change./*@complete*/;
User./*@complete*/;
const Users = repositoryOf({ entity: User, actions: ["/*@complete*/"] });
`,
	},
	{
		name: "errors",
		perf: false,
		code: `import { blueprintOf, entityOf, recordOf, repositoryOf } from "@afora/core";
class User extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string, email: ctx.email })),
	{ unique: ["email"], change: ["name"] },
) {}
new User({ name: 1, email: "a@b.co" });
new User({ email: "a@b.co" });
new User({ name: "a", email: "a@b.co", extra: true });
const user = new User({ name: "a", email: "a@b.co" });
user.change.email("b@b.co");
user.change.id("x");
repositoryOf({ entity: User, actions: ["findByName"] });
repositoryOf({ entity: User, actions: ["findManyByEmail"] });
blueprintOf((ctx) => ({ a: ctx.nope }));
recordOf(blueprintOf((ctx) => ({ n: ctx.number })), { unique: ["missing"] });
`,
	},
];
