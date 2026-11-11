# @afora/express

An [Express](https://expressjs.com) sink for [`@afora/core`](../../README.md) outputs. It turns the operations of an output into an Express app: the route each use case declares, validated input (from the body, the query, the path, headers and cookies), the access each use case declares, the response with its status (sensitive values masked), RFC 9457 `application/problem+json` errors, and an OpenAPI document of the same routes.

```bash
bun add @afora/core @afora/express express typebox
# or: npm install @afora/core @afora/express express typebox
```

`@afora/core`, `express` (`^5.3.0`) and TypeBox (`^1`) are peer dependencies. It runs wherever Express 5 does: Node >= 22 and Bun.

## Example

```ts
import {
	blueprintOf,
	commandOf,
	entityOf,
	outputOf,
	RepositoryEntityNotFound,
	repositoryOf,
	Route,
	useCaseOf,
} from "@afora/core";
import { express } from "@afora/express";

class Post extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text, slug: ctx.slug })),
) {}
const Posts = repositoryOf({ entity: Post, actions: ["findBySlug", "create"] });

@Route("GET", "/posts/{slug}")
class GetPost extends useCaseOf({
	name: "GetPost",
	blueprint: blueprintOf((ctx) => ({ slug: ctx.slug })),
	response: blueprintOf(() => ({ post: Post })),
	dependencies: { posts: Posts },
}) {
	override async execute() {
		const post = await this.dependencies.posts.findBySlug(this.input.slug);
		if (!post) {
			throw new RepositoryEntityNotFound({
				source: "GetPost",
				details: { id: this.input.slug },
			}); // a 404
		}
		return { post };
	}
}

const Blog = commandOf({ name: "Blog", useCases: { getPost: GetPost } });

const Api = outputOf({
	name: "Api",
	commands: [Blog],
	pipe: [
		express({
			basePath: "/api",
			docs: {
				path: "/openapi.json",
				info: { title: "Blog", version: "1.0.0" },
			},
		}),
	],
});

const app = Api.build(); // an Express app
app.listen(3000);
```

```
GET /api/posts/hello          -> 200 { "post": { "slug": "hello", ... } }
GET /api/posts/Not%20A%20Slug -> 400 application/problem+json, with "issues"
GET /openapi.json             -> the OpenAPI 3.1 document of the same routes
```

## Options

All options are JSON, so the stage can live in an `afora.json` (`{ "sink": "express", "options": { ... } }`). They are the options of every afora sink that serves HTTP, so moving an output from one server to another changes one import.

| Option      | Meaning                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basePath`  | Prefix of every route, e.g. `"/api"`.                                                                                                                                                                                |
| `route`     | `{ [operationId]: { method?, path?, status? } }`: overrides the route a use case declares, or the default `POST /{command}/{operation}`.                                                                             |
| `responses` | `{ [operationId]: { headers: { name: value } } }`: static headers of the success responses, such as `cache-control`.                                                                                                 |
| `requestId` | `true` (`x-request-id`) or a header name: every response of the sink carries the request's id, or a new one.                                                                                                         |
| `security`  | `{ schemes, operations?, default? }`: the security schemes of the OpenAPI document.                                                                                                                                  |
| `docs`      | `{ path, info: { title, version, description? }, servers? }`: serves the OpenAPI document of the same operations at `path` (not under `basePath`).                                                                   |
| `debug`     | `true` adds the `trace` to problems and the real `detail` to 5xx ones. Off by default.                                                                                                                               |
| `context`   | `{ headers?: { [contextKey]: headerName }, variables?: { [contextKey]: name } }`: the context of an operation from request headers and from what a middleware set in `res.locals`, else on the request (`req.user`). |
| `auth`      | `{ jwt: { secret: { env }, issuer?, audience?, algorithm?, header?, cookie? } }`: authenticates callers from a JSON Web Token. Experimental: see [Tokens and sessions](../../docs/auth.md#tokens-and-sessions).      |

What JSON cannot hold goes in a second argument, the hooks: `express(options, { authenticator, middlewares, app })`. The type `ExpressHooks` is exported.

| Hook            | Meaning                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `authenticator` | `(request) => Principal \| null`: who calls, from the credentials of the request. `request` has `header(name)`, `cookie(name)`, the `operation` and `native`, the Express `Request`. |
| `middlewares`   | Express middlewares: `(req, res, next) => ...`, run in order before the routes of the sink.                                                                                          |
| `app`           | The Express app to add the routes to, instead of a new one.                                                                                                                          |

Invalid options throw `InvalidOutputStage` when the stage is made, and unknown operation ids in `route` or two operations on one method and path when the output is built.

## Behavior

The requests are handled by the route table of the core (`compileRoutes` of `@afora/core/adapters`), shared by every afora sink that serves HTTP, so they all answer the same way. This package only routes and sends. The behavior is described once, in [Outputs](../../docs/outputs.md); in short:

- **Input.** `post`, `put` and `patch` read a JSON body, `get` and `delete` the query string. Over it come the keys the [route of the use case](../../docs/use-cases.md#routes) places: `{name}` segments of the path, and the query keys, headers and cookies it declares. Text is converted to the numbers and booleans the input takes, and the blueprint of the use case validates it: a 400 problem with `issues`.
- **Access.** An operation whose use case declares an [`access`](../../docs/auth.md) asks the `authenticator` hook (or `auth`) who calls, and answers a 401 or a 403 problem before the input is validated. With neither, such an operation always answers 401.
- **Success.** The status of the route (`200` by default) with the response as JSON; records go through `toJSON`, so sensitive values are masked. A `204` has no body. The keys a route sends with `setCookie` leave the body and become `set-cookie` headers.
- **Errors.** `application/problem+json`, with the status of `statusOf`: the `statuses` of the output first, then 400, 401, 403, 404, 409, 422 for a declared error, else 500, whose detail is `"Internal error."` unless `debug` is on.
- **Unknown routes** are a 404 problem and anything thrown outside an operation is a problem too, unless you gave the `app`.
- **The body.** The body is read from the request as text and parsed by the route table, so the sink needs no `express.json()`. Behind one (on an `app` of yours), the body it parsed is used.

## Middlewares and your own app

<!-- docs:code skip: fragment: the second argument of the stage; cors is the cors package and tenantOf stands for your code -->
```ts
import cors from "cors";

express(
	{ context: { variables: { tenant: "tenant" } } },
	{
		middlewares: [
			cors(),
			(req, res, next) => {
				res.locals.tenant = tenantOf(req.hostname);
				next();
			},
		],
	},
);
```

A value a middleware sets reaches the use case through `context.variables`, for the operations whose `context` blueprint declares the key.

`app` takes an Express app you made. The sink then adds only its routes: no not found handler and no error handler, so add yours after building the output. The middlewares of `hooks.middlewares` run on the routes of the sink only.

## Catalog

`ExpressStages` is `stageCatalogOf(express)` (from `@afora/core/adapters`), and `stages` are the entries codegen reads to resolve `{ "sink": "express" }` in an `afora.json`:

```ts
// stages.ts
export { stages } from "@afora/express";
```

```bash
bunx afora-codegen generate --stages ./stages.ts
```

## Testing a sink

This package passes `httpProviderContract` of `@afora/core/testing`, the cases every afora sink that serves HTTP must pass. A sink for another server is tested the same way; see [Outputs](../../docs/outputs.md).
