# Outputs

`outputOf` turns commands into **operations** and runs them through a **pipe** of stages: transforms change or remove operations, and a last stage, a **sink**, builds something concrete (an OpenAPI document, an HTTP app, MCP tools).

```ts
import { outputOf, select } from "@afora/core";

const Api = outputOf({
	name: "Api",
	commands: [Users, Posts],
	statuses: { UserAlreadyExists: 409 }, // optional, by exception name
	pipe: [select({ tags: ["public"] }), someSink({ basePath: "/api" })],
});

Api.operations; // OperationDescriptor[] after the transforms, in declaration order
Api.build(); // the sink's result, built on the first call and memoized
Api.pipe(select({ exclude: ["Users.login"] })); // a new, unnamed output with more stages
Api.pipe(otherSink()); // when the last stage is a sink, its result
```

Each operation is a frozen **`OperationDescriptor`** (version 1): `id` (`"Users.register"`), `command`, `name`, `useCase`, `description` (the use case's, else the command's), `tags` (the command's then the use case's, deduplicated), `deprecated`, `input`, `response`, `context` (the command's, else the use case's), `errors`, `meta` (`{}` until a transform sets it) and `invoke(input, { context })`, which is `command.run`. `operationOf(operation, patch)` returns a modified copy; only `meta` (replaced), `tags`, `description`, `deprecated` and `invoke` can be patched, anything else throws `InvalidOutputStage`.

`outputOf` throws `InvalidOutputStage` (`Output` layer, `details.reason`) for an empty `name`, an entry that is neither a command made by `commandOf` nor an application, a pipe entry that is not a stage, a sink that is not last, or `statuses` that is not a map of exception names to integers between 400 and 599, and `DuplicateOperation` when two operations share an `id`. The operations are computed at declaration; `build()` throws when the pipe has no sink. The output is frozen, tagged and identified by `isOutput`. `commands` also takes an application (all its commands, the bound ones when it has a provider, in registration order) or a list mixing commands and applications: `outputOf({ name: "Api", commands: app })`. The same command twice counts once; two different commands whose operations share an `id` are a `DuplicateOperation`.

To register an output in an application, use `outputs: { Api }` (see [Applications](applications.md)).

**Stages** come from factories, so a stage is a name plus JSON options (validated like the options of `providerOf`, and frozen):

```ts
import { transformOf } from "@afora/core";
import { sinkOf } from "@afora/core/adapters"; // the plumbing for sink authors

const hide = transformOf({
	name: "hide",
	apply: (operation, options: { tag: string }) =>
		operation.tags.includes(options.tag) ? null : operation, // null removes it
});
const ids = sinkOf({
	name: "ids",
	build: (operations, options: { prefix?: string }, { output }) =>
		operations.map(({ id }) => `${options.prefix ?? ""}${output.name}/${id}`),
});

outputOf({
	name: "Api",
	commands: [Users],
	pipe: [hide({ tag: "internal" }), ids()],
});
```

`apply` and `build` also get `{ output: { name, statuses } }`. `stageDescriptionOf(stage)` (from `@afora/core/experimental`) gives `{ kind, name, options }` for a stage made by a factory and `{ kind: "opaque" }` for a hand-written object of the stage shape (accepted at runtime). `stageCatalogOf(...factories)` (from `@afora/core/adapters`) resolves names to stages (`catalog.resolve("select", options)`), and `StdStages` holds the built-in ones. `select` keeps the operations that match `tags` (any of), `operations` (ids to keep) and `exclude` (ids to drop).

**Errors at the boundary.** The helpers of this paragraph and the next are imported from `@afora/core/adapters` (see [API tiers](api-tiers.md)): a sink uses them, application code does not need them. `statusOf(error, operation?, statuses?)` gives an HTTP-style status: `statuses[error.name]` if given; 400 for `InvalidUseCaseInput`, `InvalidUseCaseContext`, `InvalidCommandContext` and any exception whose `details.issues` is a list; 404 for `RepositoryEntityNotFound` and `UnknownCommandOperation`; 409 for `RepositoryUniqueViolation`, `RepositoryConcurrencyConflict` (a versioned entity written by someone else since it was read) and `UseCaseEntityConflict`; 422 for an exception listed in `operation.errors`; 500 for anything else, including `CommandEventFailed` (the call committed, but the response cannot claim success) and errors that are not exceptions. `problemOf(error, { status, debug? })` returns an RFC 9457 object (`type: "urn:afora:exception:<name>"`, `title`, `status`, `detail`, `layer`), served as `PROBLEM_MEDIA_TYPE` (`application/problem+json`). `issues` (`path`, `code`, `message`; no values, no causes) only appears for a 400, `trace` only with `debug: true`, and the `detail` of a 5xx is `"Internal error."` unless `debug` is set, so internal messages do not leak.

**Masking.** `outputValueOf(value)` is `JSON.parse(JSON.stringify(value))`: every record goes through its `toJSON`, so sensitive values (a `Password` always) are masked at any depth. A sink must send its response values through it.

**The `openapi` sink.** `openapi({ info, servers?, basePath?, route?, responses?, requestId?, security? })` (in `StdStages`) builds an OpenAPI 3.1 document from the operations:

```ts
import { openapi, outputOf } from "@afora/core";

const Docs = outputOf({
	name: "Blog",
	commands: [Users, Posts],
	statuses: { UserAlreadyExists: 409 },
	pipe: [
		openapi({
			info: { title: "Blog", version: "1.0.0" },
			basePath: "/api",
			route: {
				"Posts.list": { method: "get" },
				"Posts.get": { method: "get", path: "/posts/{slug}" },
				"Posts.publish": { path: "/posts", status: 201 },
			},
			responses: {
				"Posts.get": { headers: { "cache-control": "max-age=60" } },
			},
			requestId: true,
			security: {
				schemes: { bearer: { type: "http", scheme: "bearer" } },
				operations: {
					"Posts.publish": { scheme: "bearer", scopes: ["write"] },
				},
			},
		}),
	],
});

Docs.build(); // { openapi: "3.1.0", info, paths, components: { schemas, securitySchemes } }
```

- **Routes.** `POST {basePath}/{kebab(command)}/{kebab(operation)}`, e.g. `/api/users/change-password`; `route` changes `method` (`get`, `post`, `put`, `patch`, `delete`), `path` and the success `status` per operation id. Two operations on one method and path (`/posts/{a}` and `/posts/{b}` count as one), or a `route`, `responses` or `security.operations` entry for an unknown id, throw `InvalidOutputStage` when the document is built.
- **Path parameters.** A `{name}` segment of a `path` (`/posts/{slug}`; a whole segment, a letter or `_` first) is the input key `name`, which must be a scalar property of the input, else the build throws `InvalidOutputStage`. It is a required `in: path` parameter and is left out of the body or the query. Paths with `:` or `*` (Hono or Express patterns) are rejected when the stage is made, and `basePath` takes no parameters.
- **Shared options.** `basePath`, `route`, `responses`, `requestId` and `security` are the `RouteOptions`, which the sinks that serve HTTP, such as `hono`, take too, so the served routes and the document agree. For those sinks, `@afora/core/adapters` has `ROUTE_OPTION_KEYS` (the keys), `operationRoutes(operations, options, source?)` (the routes: a `Map` of id to `{ method, path, parameters, status, headers }`, the path with its `{name}` segments), `routeOptionsIssue(options, where)` (validates the options) and `requestIdHeaderOf(options)` (names the request id header).
- **WebSocket.** The `websocket` sink of [`@afora/ws`](../packages/ws/README.md) serves the operations over JSON messages on any runtime, with topic subscriptions fed by [`publishEvents`](commands.md#event-policies). `coerceTextValues(blueprint, texts)` (from `@afora/core/adapters`) converts text (a query string, headers, session values) to the numbers and booleans a blueprint takes, for sinks that read text.
- **Webhooks.** The `hono` sink of `@afora/hono` can verify the signature of incoming webhooks (Stripe, GitHub, Standard Webhooks, plain HMAC-SHA256) before an operation runs, and drop the keys its input does not declare: see its [`webhooks` option](../packages/hono/README.md#webhooks).
- **Operations.** `operationId` is the id with an underscore for the dot (`Users_register`; a collision throws), `summary` is the id, plus `description`, `tags` and `deprecated` from the descriptor. `post`, `put` and `patch` send the input as a JSON body (omitted when it has no fields); `get` and `delete` send it as query parameters, which needs every field to be a scalar property, otherwise the build throws `InvalidOutputStage` (route it with `post`). Path parameters are taken out of both first. The `context` is transport-specific and not in the document: sinks that serve HTTP map it (headers, middleware).
- **Responses.** The `route` status (`200` by default; `201`, `202` or `204`) with the response schema (sensitive keys are `writeOnly`), except `204`, which has no content; `400` and `500` always, and one response per status of the declared `errors`, given by `statusOf` with the output `statuses` (422 by default). An operation does not expose its repository dependencies, so `404` and `409` are documented when a declared error maps to them. Errors are `application/problem+json` with `components.schemas.Problem` (RFC 9457 plus `layer` and `issues`).
- **Headers.** `responses: { [operationId]: { headers: { name: value } } }` adds static headers to the success response of an operation (`cache-control`, say; not `content-type`), documented as `{ schema: { type: "string", const: value } }`. `requestId: true` (`x-request-id`) or `requestId: "<header>"` documents a request id header on every response, problems included.
- **Security.** `security: { schemes, operations?, default? }` documents how operations authenticate: `schemes` are `components.securitySchemes` (`http`, `apiKey`, `oauth2`, `openIdConnect` or `mutualTLS`, as OpenAPI writes them), `default: { scheme, scopes? }` is the document `security`, and `operations: { [operationId]: { scheme, scopes? } | false }` the `security` of each operation (`false` is `security: []`, a public operation under a `default`). A requirement naming an unknown scheme is rejected when the stage is made. It is documentation only: no sink enforces it, a middleware or a `transform` stage does.
- **Models.** Records and entities reachable from inputs and responses are `components.schemas` named by class name and referenced with `$ref` (see [OpenAPI](openapi.md)). Two different classes with one name, an anonymous class or a class named `Problem` throw `InvalidOutputStage`.
