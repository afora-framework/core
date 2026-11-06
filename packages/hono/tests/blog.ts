import {
	blueprintOf,
	commandOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	listOf,
	operationOf,
	Password,
	repositoryOf,
	transformOf,
	useCaseOf,
} from "@afora/core";

class User extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.text,
		email: ctx.email,
		password: ctx.password,
	})),
	{ unique: ["email"] },
) {}
class Post extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text, authorEmail: ctx.email })),
) {}

const InvalidCredentials = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "InvalidCredentials",
	message: "Wrong email or password.",
});
export const Unauthorized = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "Unauthorized",
	message: "Sign in first.",
});

export function blog() {
	const Users = repositoryOf({
		entity: User,
		actions: ["findByEmail", "create"],
	});
	const Posts = repositoryOf({
		entity: Post,
		actions: ["create", "findMany"],
	});

	class Register extends useCaseOf({
		name: "Register",
		description: "Creates an account.",
		tags: ["public"],
		blueprint: blueprintOf((ctx) => ({
			name: ctx.text,
			email: ctx.email,
			plainPassword: ctx.string,
		})),
		response: blueprintOf(() => ({ user: User })),
		dependencies: { users: Users },
	}) {
		override async execute({ users = this.dependencies.users } = {}) {
			const { plainPassword, ...data } = this.input;
			const password = await Password.hash(plainPassword);
			return {
				user: await users.create({ ...data, password: password.value }),
			};
		}
	}
	class Login extends useCaseOf({
		name: "Login",
		tags: ["public"],
		blueprint: blueprintOf((ctx) => ({
			email: ctx.email,
			plainPassword: ctx.string,
		})),
		response: blueprintOf(() => ({ user: User })),
		dependencies: { users: Users },
		errors: [InvalidCredentials],
	}) {
		override async execute({ users = this.dependencies.users } = {}) {
			const user = await users.findByEmail(this.input.email);
			if (
				!user ||
				!(await new Password(user.password).verify(this.input.plainPassword))
			) {
				throw new InvalidCredentials({ source: "Login" });
			}
			return { user };
		}
	}
	class Publish extends useCaseOf({
		name: "Publish",
		blueprint: blueprintOf((ctx) => ({ title: ctx.text })),
		context: blueprintOf((ctx) => ({
			authorization: ctx.optional.string,
			limit: ctx.optional.integer,
		})),
		response: blueprintOf(() => ({ post: Post })),
		dependencies: { posts: Posts },
	}) {
		override async execute({ posts = this.dependencies.posts } = {}) {
			const authorEmail = (
				this.context?.authorization ?? "Bearer anonymous@example.com"
			).replace(/^Bearer /, "");
			return {
				post: await posts.create({ title: this.input.title, authorEmail }),
			};
		}
	}
	class List extends useCaseOf({
		name: "List",
		blueprint: blueprintOf((ctx) => ({
			onlyBy: ctx.optional.email,
			max: ctx.optional.integer,
		})),
		response: blueprintOf(() => ({ items: listOf(Post) })),
		dependencies: { posts: Posts },
	}) {
		override async execute({ posts = this.dependencies.posts } = {}) {
			const { onlyBy, max } = this.input;
			const items = (await posts.findMany()).filter(
				(post) => !onlyBy || post.authorEmail === onlyBy,
			);
			return { items: max === undefined ? items : items.slice(0, max) };
		}
	}

	const Users$ = commandOf({
		name: "Users",
		useCases: { register: Register, login: Login },
	});
	const Posts$ = commandOf({
		name: "Posts",
		useCases: { publish: Publish, list: List },
	});
	return { Users: Users$, Posts: Posts$ };
}

/** Rejects a call whose `authorization` context is missing. */
export const requireAuth = transformOf({
	name: "requireAuth",
	apply: (operation, options: { except?: string[] }) =>
		options.except?.includes(operation.id) || operation.tags.includes("public")
			? operation
			: operationOf(operation, {
					invoke: (input, call) => {
						const context = call?.context as
							| { authorization?: string }
							| undefined;
						if (!context?.authorization) {
							throw new Unauthorized({ source: operation.id });
						}
						return operation.invoke(input, call);
					},
				}),
});
