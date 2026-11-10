/**
 * Code as users write it, from the README and the docs. `perf` cases are valid code whose
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
		name: "named providers",
		perf: true,
		code: `import { applicationOf, blueprintOf, entityOf, inMemoryProvider, providerFrom, providersOf, repositoryOf } from "@afora/core";

const /*@hover*/Providers = providersOf({
	main: inMemoryProvider(),
	audit: providerFrom(() => inMemoryProvider()),
});

class Entry extends entityOf(blueprintOf((ctx) => ({ event: ctx.string }))) {}

const Entries = repositoryOf({
	entity: Entry,
	actions: ["create", "count"],
	provider: Providers./*@complete*/audit,
});

const App = applicationOf({
	name: "audit",
	entities: { Entry },
	repositories: { Entries },
	providers: Providers,
	provider: Providers./*@hover*/main,
});
const /*@hover*/instance = App.get(Providers.audit);
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
		name: "queries",
		perf: true,
		code: `import { blueprintOf, entityOf, repositoryOf } from "@afora/core";

class User extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string, age: ctx.integer, email: ctx.email })),
	{ unique: ["email"] },
) {}

const Users = repositoryOf({
	entity: User,
	actions: ["findMany", "exists", "findPage", "count", "create"],
	deletion: "soft",
});

const /*@hover*/adults = await Users.findMany({
	where: { age: { in: [18, 21] } },
	orderBy: [{ key: "name" }],
	limit: 20,
});
const /*@hover*/page = await Users.findPage({ where: { name: "Ana" } });
await Users.exists({ where: { email: "ana@example.com" } });
`,
	},
	{
		name: "steps use case",
		perf: true,
		code: `import { blueprintOf, entityOf, ExceptionLayers, exceptionOf, repositoryOf, useCaseOf } from "@afora/core";

class User extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string, email: ctx.email })),
	{ unique: ["email"] },
) {}
const Users = repositoryOf({ entity: User, actions: ["findByEmail", "create"] });
const UserAlreadyExists = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UserAlreadyExists",
	message: "A user with this email already exists.",
});

class Register extends useCaseOf({
	name: "Register",
	blueprint: blueprintOf((ctx) => ({ name: ctx.string, email: ctx.email })),
	response: blueprintOf(() => ({ user: User })),
	dependencies: { users: Users },
	errors: [UserAlreadyExists],
	steps: [
		{ find: "users.findByEmail", args: ["$input.email"], as: "existing" },
		{ ensure: "absent", value: "$existing", error: UserAlreadyExists },
		{ build: User, values: "$input", as: "user" },
		{ create: "users", value: "$user", as: "saved" },
		{ return: { user: "$saved" } },
	],
}) {}

const { /*@hover*/user } = await new Register({ name: "Ana", email: "ana@example.com" }).execute();
`,
	},
	{
		name: "command and output",
		perf: true,
		code: `import { blueprintOf, commandOf, entityOf, openapi, outputOf, repositoryOf, useCaseOf } from "@afora/core";

class User extends entityOf(blueprintOf((ctx) => ({ name: ctx.string }))) {}
const Users = repositoryOf({ entity: User, actions: ["create"] });

class CreateUser extends useCaseOf({
	name: "CreateUser",
	blueprint: blueprintOf((ctx) => ({ name: ctx.string })),
	response: blueprintOf(() => ({ user: User })),
	context: blueprintOf((ctx) => ({ userId: ctx.optional.id })),
	dependencies: { users: Users },
}) {
	override async execute({ users = this.dependencies.users } = {}) {
		return { user: await users.create(this.input) };
	}
}

const Accounts = commandOf({ name: "Accounts", useCases: { create: CreateUser }, transaction: true });
const { /*@hover*/user } = await Accounts.run("create", { name: "Ana" }, { context: {} });

const Api = outputOf({
	name: "Api",
	commands: [Accounts],
	pipe: [openapi({ info: { title: "Accounts", version: "1.0.0" } })],
});
const /*@hover*/document = Api.build();
`,
	},
	{
		name: "standard use cases",
		perf: true,
		// One entity: two with plugins cost 75k before any use case.
		code: `import { blueprintOf, commandOf, entityOf, repositoryOf } from "@afora/core";

class Post extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.string, status: ctx.string })),
	{ change: ["title", "status"], plugins: (ctx) => [ctx.publishable] },
) {}
const Posts = repositoryOf({
	entity: Post,
	actions: ["findById", "findPage", "create", "update", "delete"],
});

const Blog = commandOf({
	name: "Blog",
	useCases: (/*@hover*/ctx) => ({
		create: ctx./*@hover*/create(Posts, {
			as: "post",
			omit: ["publishedAt"],
			values: { status: "draft" },
		}),
		list: ctx.list(Posts),
		update: ctx.update(Posts),
		publish: ctx.publish(Posts, { set: { status: "published" } }),
		remove: ctx.delete(Posts),
	}),
});
const { /*@hover*/post } = await Blog.run("create", /*@signature*/{ title: "Hi" });
const { /*@hover*/items } = await Blog.run("list", {});
await Blog.run("update", { id: post.id, /*@complete*/ });
`,
	},
	{
		name: "errors: standard use cases",
		perf: false,
		code: `import { blueprintOf, commandOf, entityOf, repositoryOf } from "@afora/core";
class Note extends entityOf(blueprintOf((ctx) => ({ text: ctx.string })), { change: ["text"] }) {}
const Notes = repositoryOf({ entity: Note, actions: ["findById", "create"] });
commandOf({
	name: "Notebook",
	useCases: (ctx) => ({
		update: ctx.update(Notes),
		publish: ctx.publish(Notes),
		create: ctx.create(Notes, { omit: ["nope"] }),
		get: ctx.get(Notes, { owner: {} }),
	}),
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
