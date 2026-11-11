# HTTP providers

A use case says where it is served ([`route`](use-cases.md#routes)) and who may call it ([`access`](auth.md)), and names no server. The server is chosen where the application is put together: the sink of an [output](outputs.md). Each server has a package, and they all take the same options and answer the same way, because none of them parses a request: they route to one table the core compiles.

| Package                                           | Server  | The output builds   |
| ------------------------------------------------- | ------- | ------------------- |
| [`@afora/hono`](../packages/hono/README.md)       | Hono    | a `Hono` app        |
| [`@afora/fastify`](../packages/fastify/README.md) | Fastify | a `FastifyInstance` |
| [`@afora/express`](../packages/express/README.md) | Express | an Express app      |
| [`@afora/elysia`](../packages/elysia/README.md)   | Elysia  | an Elysia app       |

```ts
import { applicationOf, outputOf } from "@afora/core";
import { fastify } from "@afora/fastify"; // or hono, express, elysia

const Api = outputOf({
	name: "Api",
	commands: [Blog],
	pipe: [
		fastify(
			{
				basePath: "/api",
				docs: {
					path: "/openapi.json",
					info: { title: "Blog", version: "1.0.0" },
				},
			},
			{ middlewares: [rateLimit] },
		),
	],
});

export const App = applicationOf({
	name: "blog",
	// ...
	commands: { Blog },
	outputs: { Api },
});

await App.start();
await App.outputs.Api.build().listen({ port: 3000 });
```

Changing the server is changing the import and the name of the sink. The use cases, their routes, their access and the OpenAPI document stay as they are.

## The same options

Every provider takes the `HttpOptions`, as JSON, so the stage can live in an `afora.json`: `basePath`, `route`, `responses`, `requestId`, `security`, `docs`, `debug`, `context` and `auth`. They are described in [Outputs](outputs.md), and each package lists them. A provider may add options of its own (`webhooks` in `@afora/hono`).

## The same hooks

What JSON cannot hold is the second argument of the sink, its hooks:

| Hook            | What it is                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `authenticator` | `(request) => Principal \| null`: who calls. The same function works on every provider.                          |
| `middlewares`   | Middlewares **of the server**: Hono middlewares, Fastify `onRequest` hooks, Express middlewares, Elysia plugins. |
| `app`           | An instance of the server you made, to add the routes to. Its own middlewares and handlers are kept.             |

So server concerns stay server code: CORS, rate limiting, compression, logging of requests and anything else the ecosystem of the server already has are its own middlewares, given as they are. A value a middleware resolves (a tenant, a locale) reaches a use case through `context.variables`.

Hooks are not data: `describe()` and `afora.json` describe the sink by its name and its JSON options.

## One behavior

A request is handled by `compileRoutes` (from `@afora/core/adapters`), which decides everything once, when the output is built: which keys come from the path, the query, a header or a cookie, how text is converted, which context keys are read, whether the caller is asked for, the status and headers of a success, the cookies to send. A request then only reads, validates and runs; the provider adds the lookup of its own router. The response body is serialized once.

That is also why the providers cannot drift apart: `httpProviderContract` (from `@afora/core/testing`) is one set of cases, on real requests, that all four packages pass: declared routes, input from each place, context, 400 problems with issues, statuses, masked values, access (401 and 403, and closed without an authenticator), cookies, the request id and the document.

## Writing a provider

A provider for another server is a sink of about a hundred lines:

```ts
import {
	compileRoutes,
	HTTP_OPTION_KEYS,
	type HttpOptions,
	httpOptionsIssue,
	sinkOf,
} from "@afora/core/adapters";

export const myServer = sinkOf<MyApp, HttpOptions, MyHooks>({
	name: "myServer",
	validate: (options) => httpOptionsIssue(options, "myServer"),
	build: (operations, options, context, hooks) => {
		const table = compileRoutes(operations, options, context, {
			source: "myServer",
			authenticator: hooks?.authenticator,
		});
		const app = hooks?.app ?? new MyApp();
		for (const route of table.routes) {
			// route.path has {name} parameters: write them as the server does
			app.on(route.method, route.path, async (native) =>
				send(native, await route.handle(requestOf(native))),
			);
		}
		if (table.docs)
			app.on("get", table.docs.path, (native) =>
				send(native, table.docs.handle(requestOf(native))),
			);
		return app;
	},
});
```

- **`requestOf`** adapts the request of the server to `{ param(name), query(), header(name), text(), variable?(name), native? }`. `text()` is the body as it was sent: the table parses it, so an invalid body is a problem like the others.
- **`send`** writes `{ status, headers, cookies, body }` as is: `body` is a string or `null`, `cookies` one `set-cookie` header each.
- **`table.notFound(request)`** and **`table.failure(error, { request })`** are the problems for the handlers of the server, when the sink owns the app.
- **Test it** with `httpProviderContract("myServer", { sink, fetch, close? }, { describe, it, expect })`: `fetch(server, request)` sends a standard `Request` to what the sink built and gives a `Response`.
