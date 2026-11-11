# Tutorial: an API, step by step

This page builds one small blog API, starting from the shortest program that works and adding one thing at a time. Each step says what the new lines buy you. The two listings are files of this repository (`examples/interop/crud.ts` and `tutorial.ts`), run by `bun run test:interop`.

afora is a TypeScript library: the commands are shown for Bun and for Node, and the code is the same on both.

## 1. Install

```bash
bun add @afora/core @afora/hono hono typebox
# or: npm install @afora/core @afora/hono hono typebox
```

`@afora/core` is the library, `@afora/hono` serves it on [Hono](https://hono.dev). The other servers (Fastify, Express, Elysia) take the same code: see [HTTP providers](providers.md).

## 2. A CRUD API on one screen

Save this as `blog.ts`:

```ts
import {
	blueprintOf,
	commandOf,
	entityOf,
	outputOf,
	repositoryOf,
	resourceOf,
} from "@afora/core";
import { hono } from "@afora/hono";

// What a post is: each field validates and normalizes its value
export class Post extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text, slug: ctx.slug, body: ctx.text })),
	{ unique: ["slug"], change: ["title", "body"] },
) {}

// Where posts are kept: in memory, until you name a provider
const Posts = repositoryOf({
	entity: Post,
	actions: ["findById", "findPage", "create", "update", "delete"],
});

// What can be done with them: the five operations of a REST resource
const Blog = commandOf({
	name: "Blog",
	useCases: resourceOf(Posts, { path: "/posts" }),
});

// How they are served: an HTTP API, with its OpenAPI document
const Api = outputOf({
	name: "Api",
	commands: [Blog],
	pipe: [
		hono({
			docs: {
				path: "/openapi.json",
				info: { title: "Blog", version: "1.0.0" },
			},
		}),
	],
});

export const api = Api.build();

if (import.meta.main) Bun.serve({ fetch: api.fetch });
```

```bash
bun blog.ts
# or, on Node:  npm install @hono/node-server tsx
#               replace the last line with:  serve({ fetch: api.fetch, port: 3000 })   // from "@hono/node-server"
#               npx tsx blog.ts
```

```
POST   /posts       { "title": "Hello", "slug": "hello", "body": "First post." }   -> 201 { "item": { "id": "...", ... } }
GET    /posts                                                                      -> 200 { "items": [...], "total": 1, ... }
GET    /posts/{id}                                                                 -> 200 { "item": {...} }
PATCH  /posts/{id}  { "title": "Hello again" }                                     -> 200 { "item": {...} }
DELETE /posts/{id}                                                                 -> 200 { "item": {...} }
GET    /openapi.json                                                               -> the OpenAPI 3.1 document of these routes
```

Four declarations, and what each one is for:

| Declaration    | What it says                               | What you did not write                                                                                      |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `entityOf`     | What a post is, and its rules              | Validation of every field, an `id`, `createdAt` and `updatedAt`, the rejection of keys you did not declare. |
| `repositoryOf` | Where posts are kept, and what may be done | The queries, and the check that `slug` is unique.                                                           |
| `commandOf`    | The operations of the application          | Five use cases: `resourceOf` picks the standard ones and gives each the route of a REST resource.           |
| `outputOf`     | How the operations leave the application   | The routes, the parsing, the status codes, the error format, the OpenAPI document.                          |

Try what the declarations already guarantee:

```
POST /posts  { "title": "Twice", "slug": "hello", "body": "..." }   (the slug exists)
-> 409 application/problem+json  { "title": "RepositoryUniqueViolation", ... }

POST /posts  { "title": "No body", "slug": "no-body", "extra": true }
-> 400 application/problem+json  { "issues": [{ "path": ["extra"], ... }, { "path": ["body"], ... }] }
```

Nothing in `blog.ts` handles those cases. A duplicate is a 409 because the repository enforces `unique`; an unknown key is a 400 because a record rejects what its blueprint does not declare.

### A record is not a plain object

`new Post({...})` gives a **record**: its values are validated when it is built and can only change through `post.change.title("...")`, which validates again. The values are read with getters (`post.title`), so two things surprise at first:

<!-- docs:code continue -->
```ts
const post = new Post({ title: "Hello", slug: "hello", body: "First post." });

({ ...post }); // {}: a spread copies own properties, and a record has none
post.toJSON(); // { id, createdAt, title, slug, body }: the plain object
JSON.stringify(post); // the same, as text: toJSON is what serializers call
```

That is on purpose: `toJSON()` is the one way out, so it is the one place where a sensitive value (a password) is masked, at any depth. Use `post.toJSON()` whenever you need the plain object. See [Records](records.md).

## 3. The whole application

The rest of this page grows the same API: users that sign in, a rule of your own, and who may call what. This is the complete file; the sections after it walk through the parts.

```ts
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
```

```bash
JWT_SECRET="a-secret-of-at-least-thirty-two-characters" bun blog.ts
```

## 4. A rule of your own

`resourceOf` covers what every resource does. A rule that is yours is a **use case**: a class that declares what it takes, what it gives and what it needs, and implements `execute`.

- **`blueprint`** is the input and **`response`** the output. Both are validated: `this.input` is typed and already checked, and a response that does not fit is an error, not a leak.
- **`dependencies`** are what it uses, here the repository of posts. They arrive as `this.dependencies`, and a test can replace them: `new PublishPost(input, options).execute({ posts: fake })`.
- **`errors`** lists the exceptions a caller should expect. `exceptionOf` makes each one, with the layer it belongs to.
- **`post.change.published(true)`** is the only way to change the record, because `published` is in its `change` list.

`PublishPost` is an ordinary class: `await new PublishPost({ slug: "hello" }, { context: { userId } }).execute()` runs it with no server at all, which is how you test it.

A rule that is a plain sequence (find, check, write, return) can also be written as data, with [steps](use-cases.md#steps), and then lives in an [`afora.json`](afora-json.md) too.

## 5. Where it is served

`@Route("POST", "/posts/{slug}/publish")` says where `PublishPost` is served, on the class itself. The input stays described once, by the blueprint: the route only says that the key `slug` comes from the path. A route can read keys from the query, a header or a cookie the same way:

<!-- docs:code skip: fragment, the decorator alone with its options -->
```ts
@Route("GET", "/posts/{slug}", {
	headers: { locale: "accept-language" },
	cookie: { session: "sid" },
})
```

The decorator names no server, and it is optional sugar: `route: { method: "post", path: "/posts/{slug}/publish" }` in the settings of `useCaseOf` is the same declaration, and needs no decorator support. Bun runs decorators as written; on Node use `tsx` (or any compiler), or the setting. See [Routes](use-cases.md#routes).

In the command, `publish: PublishPost` sits beside the standard operations: `resourceOf(...)(ctx)` is spread, so a command mixes the two freely.

## 6. Who may call it

`@Access({ scopes: ["posts:write"], context: { userId: "subject" } })` says who may call `PublishPost`:

- the caller is authenticated and has the scope `posts:write`;
- the context key `userId` is filled with **who was authenticated**, over anything the request sent. So `this.context.userId` in `execute` is never a value the client chose.

The check runs before the use case, on every server and transport: a caller with no token gets a 401, one without the scope a 403, both as `application/problem+json`. `resourceOf` takes the same declaration per operation (`access: { create: { scopes: ["posts:write"] } }`); here reading stays open, because `get` and `list` declare none.

**Who the caller is** comes from the sink. `auth: { jwt }` makes the `hono` sink read a bearer token, and the standard `login`, given `token`, issues one for the user that signed in, with the user's `roles` as its scopes:

```
POST /users  { "name": "Ana", "email": "ana@example.com", "password": "Str0ng!Pass", "roles": ["posts:write"] }
-> 201 { "item": { "email": "ana@example.com", "password": "********", ... } }

POST /login  { "email": "ana@example.com", "password": "Str0ng!Pass" }
-> 200 { "user": {...}, "token": "eyJ..." }

POST /posts/hello/publish                                   -> 401 { "title": "Unauthenticated", ... }
POST /posts/hello/publish   Authorization: Bearer eyJ...    -> 200 { "post": { "published": true, ... } }
```

The password in a response is `"********"`: `Password` is a sensitive property, and `toJSON()` masks it. The plain password is hashed with argon2 before it is stored.

The ready-made tokens are [experimental](auth.md#tokens-and-sessions); the declaration of access is not. With your own identity provider, give the sink an `authenticator` instead of `auth`: `hono(options, { authenticator: (request) => ... })`.

## 7. Errors and statuses

`PublishPost` throws `PostNotFound` and `NotTheAuthor`. Each is an exception with a layer, and the output decides its status: `statuses: { PostNotFound: 404, NotTheAuthor: 403 }`. Without an entry, an error a use case declares is a 422, a missing entity a 404, a unique violation a 409, invalid input a 400 with one issue per field, and anything unexpected a 500 whose detail is hidden. See [Outputs](outputs.md).

## 8. The document

`GET /openapi.json` describes the API as it is served: the routes, the parameters and where each is read from, the bodies, the responses with their statuses, the security scheme of the token and the scopes each operation needs. It is built from the same declarations as the routes, so it cannot go stale.

## 9. Another server

Nothing above depends on Hono. To serve the same application on Fastify:

```bash
bun add @afora/fastify fastify   # or: npm install @afora/fastify fastify
```

<!-- docs:code skip: fragment, shows the fastify stage that replaces hono({...}) in the pipe above -->
```ts
import { fastify } from "@afora/fastify";

// in the pipe, in place of hono({...}):
fastify({
	auth: { jwt },
	docs: { path: "/openapi.json", info: { title: "Blog", version: "1.0.0" } },
});

await Api.build().listen({ port: 3000 }); // a FastifyInstance: it runs on Node as it is
```

The options are the same and so is every response: the servers share one route table and one test suite. Each takes its own middlewares (CORS, rate limiting, logging) as a second argument. See [HTTP providers](providers.md).

## Where to go next

- A real database: `provider: drizzleProvider(...)` in an [application](applications.md), with [`@afora/drizzle`](../packages/drizzle/README.md).
- [Standard use cases](std-use-cases.md): ownership, soft deletion, publishing, tags.
- [Commands](commands.md): transactions and domain events.
- [afora.json](afora-json.md): the same application as data, and the [MCP server](../packages/mcp/README.md) that lets an agent build it.
- [Coming from Hono + Zod](coming-from-hono-zod.md): the same endpoint, before and after.
