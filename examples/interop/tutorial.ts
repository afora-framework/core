import {
	Access,
	blueprintOf,
	commandOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	outputOf,
	Route,
	repositoryOf,
	resourceOf,
	useCaseOf,
} from "@afora/core";
import { hono } from "@afora/hono";

// --- the domain -------------------------------------------------------------

export class User extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.text, roles: ctx.list.string })),
	{ plugins: (ctx) => [ctx.authenticatable] }, // email, password, verifyPassword
) {}

export class Post extends entityOf(
	blueprintOf((ctx) => ({
		title: ctx.text,
		slug: ctx.slug,
		body: ctx.text,
		authorId: ctx.string,
		published: ctx.boolean,
	})),
	{ unique: ["slug"], change: ["title", "body", "published"] },
) {}

const Users = repositoryOf({
	entity: User,
	actions: ["findById", "findByEmail", "create"],
});
const Posts = repositoryOf({
	entity: Post,
	actions: ["findById", "findBySlug", "findPage", "create", "update"],
});

// --- a rule of your own -----------------------------------------------------

const PostNotFound = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "PostNotFound",
	message: "There is no post with this slug.",
});
const NotTheAuthor = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "NotTheAuthor",
	message: "Only the author publishes a post.",
});

@Route("POST", "/posts/{slug}/publish")
@Access({ scopes: ["posts:write"], context: { userId: "subject" } })
export class PublishPost extends useCaseOf({
	name: "PublishPost",
	blueprint: blueprintOf((ctx) => ({ slug: ctx.slug })),
	response: blueprintOf(() => ({ post: Post })),
	context: blueprintOf((ctx) => ({ userId: ctx.string })),
	dependencies: { posts: Posts },
	errors: [PostNotFound, NotTheAuthor],
}) {
	override async execute() {
		const { posts } = this.dependencies;
		const post = await posts.findBySlug(this.input.slug);
		if (!post) throw new PostNotFound({ source: "PublishPost" });
		if (post.authorId !== this.context.userId) {
			throw new NotTheAuthor({ source: "PublishPost" });
		}
		post.change.published(true);
		return { post: await posts.update(post) };
	}
}

// --- the operations ---------------------------------------------------------

// The name of the variable, never the secret: these options are described
const jwt = { secret: { env: "JWT_SECRET" } } as const;

const Accounts = commandOf({
	name: "Accounts",
	useCases: (ctx) => ({
		register: ctx.register(Users, {
			route: { method: "post", path: "/users", status: 201 },
		}),
		login: ctx.login(Users, {
			as: "user",
			token: { ...jwt, scopesFrom: "roles" }, // the roles of a user are its scopes
			route: { method: "post", path: "/login" },
		}),
	}),
});

const Blog = commandOf({
	name: "Blog",
	useCases: (ctx) => ({
		...resourceOf(Posts, {
			path: "/posts",
			actions: ["create", "get", "list"],
			access: { create: { scopes: ["posts:write"] } },
		})(ctx),
		publish: PublishPost,
	}),
});

// --- the server -------------------------------------------------------------

const Api = outputOf({
	name: "Api",
	commands: [Accounts, Blog],
	statuses: { PostNotFound: 404, NotTheAuthor: 403 },
	pipe: [
		hono({
			auth: { jwt }, // reads the bearer token `login` issued
			docs: {
				path: "/openapi.json",
				info: { title: "Blog", version: "1.0.0" },
			},
		}),
	],
});

export const api = Api.build();

if (import.meta.main) Bun.serve({ fetch: api.fetch });
