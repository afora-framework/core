# Outputs

`outputOf` turns commands into **operations** and runs them through a **pipe** of stages: transforms change or remove operations, and a last stage, a **sink**, builds something concrete (an OpenAPI document, an HTTP app, MCP tools).

```ts
import {
	blueprintOf,
	commandOf,
	entityOf,
	outputOf,
	repositoryOf,
	resourceOf,
	select,
} from "@afora/core";
import type { SinkFactory } from "@afora/core/adapters";

class User extends entityOf(
	blueprintOf((ctx) => ({ email: ctx.email })),
	{
		unique: ["email"],
	},
) {}
class Post extends entityOf(blueprintOf((ctx) => ({ title: ctx.text }))) {}
const actions = ["findById", "findPage", "create", "update", "delete"] as const;
const Users = commandOf({
	name: "Users",
	useCases: resourceOf(repositoryOf({ entity: User, actions: [...actions] }), {
		path: "/users",
	}),
});
const Posts = commandOf({
	name: "Posts",
	tags: ["public"],
	useCases: resourceOf(repositoryOf({ entity: Post, actions: [...actions] }), {
		path: "/posts",
	}),
});
declare const someSink: SinkFactory<unknown, { basePath: string }>; // a sink of a package
declare const otherSink: SinkFactory;

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

Each operation is a frozen **`OperationDescriptor`** (version 1): `id` (`"Users.register"`), `command`, `name`, `useCase`, `description` (the use case's, else the command's), `tags` (the command's then the use case's, deduplicated), `deprecated`, `input`, `response` (an object blueprint, or a list made by `listOf` for a use case that [answers an array](use-cases.md#a-list-as-the-response)), `context` (the command's, else the use case's), `errors`, `meta` (`{}` until a transform sets it) and `invoke(input, { context })`, which is `command.run`. An operation whose use case declares a [route](use-cases.md#routes) also has `route`, that declaration, and one whose use case declares an [access](auth.md) has `access`: `invoke(input, { context, principal })` then checks the caller first and rejects with `Unauthenticated` or `Forbidden`. `operationOf(operation, patch)` returns a modified copy; only `meta` (replaced), `tags`, `description`, `deprecated` and `invoke` can be patched, anything else throws `InvalidOutputStage`.

`outputOf` throws `InvalidOutputStage` (`Output` layer, `details.reason`) for an empty `name`, an entry that is neither a command made by `commandOf` nor an application, a pipe entry that is not a stage, a sink that is not last, or `statuses` that is not a map of exception names to integers between 400 and 599, and `DuplicateOperation` when two operations share an `id`. The operations are computed at declaration; `build()` throws when the pipe has no sink. The output is frozen, tagged and identified by `isOutput`. `commands` also takes an application (all its commands, the bound ones when it has a provider, in registration order) or a list mixing commands and applications: `outputOf({ name: "Api", commands: app })`. The same command twice counts once; two different commands whose operations share an `id` are a `DuplicateOperation`.

To register an output in an application, use `outputs: { Api }` (see [Applications](applications.md)).

**Stages** come from factories, so a stage is a name plus JSON options (validated like the options of `providerOf`, and frozen):

<!-- docs:code continue -->
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

`apply` and `build` also get `{ output: { name, statuses } }`. `stageDescriptionOf(stage)` (from `@afora/core/experimental`) gives `{ kind, name, options }` for a stage made by a factory (plus `hooks: true` for a sink given hooks) and `{ kind: "opaque" }` for a hand-written object of the stage shape (accepted at runtime). `stageKindOf(factory)` (from `@afora/core/adapters`) tells whether a factory made by `transformOf` or `sinkOf` builds transforms or sinks, without calling it (`"transform"`, `"sink"`, or `undefined` for any other function), e.g. to check that a pipe read from JSON ends with a sink. `stageCatalogOf(...factories)` (from `@afora/core/adapters`) resolves names to stages (`catalog.resolve("select", options)`), and `StdStages` holds the built-in ones. `select` keeps the operations that match `tags` (any of), `operations` (ids to keep) and `exclude` (ids to drop).

**Errors at the boundary.** The helpers of this paragraph and the next are imported from `@afora/core/adapters` (see [API tiers](api-tiers.md)): a sink uses them, application code does not need them. `statusOf(error, operation?, statuses?)` gives an HTTP-style status: `statuses[error.name]` if given; 400 for `InvalidUseCaseInput`, `InvalidUseCaseContext`, `InvalidCommandContext` and any exception whose `details.issues` is a list, except the internal ones listed below (an invalid response or step describes the server, not the call, so it is a 500); 401 for `UseCaseInvalidCredentials` and `Unauthenticated`; 403 for `Forbidden`; 404 for `RepositoryEntityNotFound` and `UnknownCommandOperation`; 409 for `RepositoryUniqueViolation`, `RepositoryConcurrencyConflict` (a versioned entity written by someone else since it was read), `RepositoryDeleteRestricted` (a delete its children [restrict](repositories.md#parents)) and `UseCaseEntityConflict`; 422 for an exception listed in `operation.errors`; 500 for anything else, including `CommandEventFailed` (the call committed, but the response cannot claim success) and errors that are not exceptions. `problemOf(error, { status, debug?, statuses?, operation? })` returns an RFC 9457 object (`type: "urn:afora:exception:<name>"`, `title`, `status`, `detail`, `layer`; the `detail` of an invalid input names its first issue, as in `Invalid UseCase input: "email" must match format "email" (and 1 more).`), served as `PROBLEM_MEDIA_TYPE` (`application/problem+json`). `issues` (`path`, `code`, `message`; no values, no causes; the first 100 at most, as a parse collects no more, and an exception raised with a longer `details.issues` is cut to the same) only appears for a 400, `trace` only with `debug: true`, and the `detail` of a 5xx is `"Internal error."` unless `debug` is set or the output declares the exception, so internal messages do not leak. Declared means an exception whose name is in the output `statuses` or that matches a class of `operation.errors`: listing it there exposes its message at a 5xx, so `statuses: { PublishFailed: 502 }` answers a 502 with the message of `PublishFailed`. This holds for afora's own exceptions too when you list them on purpose (`statuses: { CommandEventFailed: 503 }` shows its message). Being made by `exceptionOf` is not enough, since afora's own exceptions are made by it too, so an exception you do not list stays masked. Some are never exposed, even when listed: `UnexpectedError`, the exception an error that is not an exception becomes (a driver or provider failure, a bug; its message is the raw one, and so is that of any exception that passes it up), and `InvalidCommandEnvironment`, `InvalidEnvironment`, `InvalidApplicationEnvironment`, `InvalidUseCaseResponse`, `InvalidUseCaseStep` and `UndeclaredStatus`, which describe the server, not the call. These internal ones are masked and carry no `issues` at any status, even one chosen with `statuses`, unless `debug` is set. The sinks of afora (`http`, `hono`, `express`, `fastify`, `elysia`, `websocket`, `mcpTools`) pass their `statuses` and operation to `problemOf`, so they all follow this rule.

**Masking.** `outputValueOf(value)` is `JSON.parse(JSON.stringify(value))`: every record goes through its `toJSON`, so sensitive values (a `Password` always) are masked at any depth. A response declared by a blueprint or a list is masked the same way, even when it holds no record: every property declared `sensitive` at any depth (nested blueprints, lists and variants included), and the keys a record or entity declares `sensitive` where the blueprint is the record's (`response: Account.blueprint`, or the blueprint `Account` was declared from); a blueprint shared by several records masks the `sensitive` keys of all of them. Those keys follow a blueprint derived from the record's: its optional copy (`optionalOf(Account.blueprint)`), a join (`Fields.join(Other)`) and a slice (`sliceOf`, for the keys it keeps), at any depth. Masking walks the response the operation declares over the value it resolves with, so a transform whose `invoke` gives a copy of the value (a cache, a spread) is masked the same way; a value `outputValueOf` gets from outside an operation is masked only through its records' `toJSON`. A direct call (`execute()`, a use case called as a dependency) still reads the real values; only what leaves the process is masked. A key a route sends with `setCookie` keeps its real value in the cookie, since masking applies to the body. A sink must send its response values through it.

**A status chosen at run time.** A use case may return `withStatus(status, body)` from `execute`, e.g. a health check that answers `503` with the same body as its `200` (see [A status chosen at run time](use-cases.md#a-status-chosen-at-run-time)). `operation.invoke` then resolves with a view of the body made for that call, which reads as the body (fields, getters, `toJSON`, `Array.isArray`) and carries the status: `chosenStatusOf(value)` (from `@afora/core/adapters`) gives it, `undefined` when the use case chose none. A transform that replaces `invoke` (`operationOf(operation, { invoke })`) and wraps the original must resolve with the very value the original gave for the status to reach the sink: a copy or a new object has none, and is sent with the route status. A sink that serves HTTP sends the body with the status when the route declares it (its `status` or one of its `statuses`), and answers `UndeclaredStatus` (`Output` layer, a 500 whose detail is always masked) for any other. The body of a 5xx chosen this way is the response, not a problem. `outputValueOf` gives the body, so a sink that does not speak HTTP (`websocket`, `mcpTools`) ignores the status.

**The `openapi` sink.** `openapi({ info, servers?, basePath?, route?, responses?, requestId?, security? })` (in `StdStages`) builds an OpenAPI 3.1 document from the operations:

<!-- docs:code continue -->
```ts
import { openapi } from "@afora/core";

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

- **Routes.** `POST {basePath}/{kebab(command)}/{kebab(operation)}`, e.g. `/api/users/change-password`. The [route a use case declares](use-cases.md#routes) (`route` or `@Route`) replaces that default, after the `basePath`; the `route` option of the sink changes `method` (`get`, `post`, `put`, `patch`, `delete`), `path`, the success `status`, the other `statuses` a use case may choose and `body` (only on a `delete`, see below) per operation id, over both. The error for two operations on one route names both ids: a routed use case held by two commands needs a `route` entry for one of them. Two operations on one method and path (`/posts/{a}` and `/posts/{b}` count as one), or a `route`, `responses` or `security.operations` entry for an unknown id, throw `InvalidOutputStage` when the document is built.
- **Path parameters.** A `{name}` segment of a `path` (`/posts/{slug}`; a whole segment, a letter or `_` first) is the input key `name`, which must be a scalar property of the input, else the build throws `InvalidOutputStage`. It is a required `in: path` parameter and is left out of the body or the query. The keys a use case route reads from the query, a header or a cookie are `in: query`, `in: header` (named by the header) and `in: cookie` (named by the cookie) parameters, required when the input requires the key, and are left out of the body too; a sink path may not take one of them as a parameter. Paths with `:` or `*` (Hono or Express patterns) are rejected when the stage is made, and `basePath` takes no parameters.
- **Shared options.** `basePath`, `route`, `responses`, `requestId` and `security` are the `RouteOptions`, which the sinks that serve HTTP, such as `hono`, take too, so the served routes and the document agree. For those sinks, `@afora/core/adapters` has `ROUTE_OPTION_KEYS` (the keys), `operationRoutes(operations, options, source?)` (the routes: a `Map` of id to `{ method, path, parameters, status, statuses, headers, body, query, requestHeaders, cookies }`, the path with its `{name}` segments, `body` telling whether the remaining input is a JSON body, and the last three the input keys the use case route reads from the query, headers and cookies), `routeOptionsIssue(options, where)` (validates the options) and `requestIdHeaderOf(options)` (names the request id header).
- **Serving HTTP.** A sink for a server does not parse requests itself: `compileRoutes(operations, options, context, { source, authenticator? })` (from `@afora/core/adapters`) gives the route table of the output, made once, and the sink only routes each `{ method, path }` of `table.routes` to `handle(request)` and sends the `{ status, headers, cookies, body }` it resolves to (`body` is serialized, sensitive values masked). `request` is `{ param, query, header, text, form?, variable?, native? }` over the request of the server (`form` gives the `FormData` of a multipart body; see Uploads below). A body is read only as JSON: the request's `content-type` must be `application/json` or an `application/*+json` type (`application/merge-patch+json`; parameters such as `charset` allowed). Any other type, or a body with no `content-type`, is a 415 `UnsupportedMediaType` problem and the operation does not run, so what a browser form sends (`text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data` to a route without a file) never reaches an operation; an empty body with no `content-type` is `{}`, as an empty JSON body is. A query key named like a member of `Object.prototype` (`constructor`, `toString`) is read as any other key the input does not declare: a 400. The table also has `docs` (the route of the document), `notFound()` and `failure(error)`, and the options it takes are the `HttpOptions`: the `RouteOptions` plus `docs`, `debug`, `maxParts`, `context` and `auth` (`HTTP_OPTION_KEYS`, `httpOptionsIssue`). `auth: { jwt: { secret: { env }, issuer?, audience?, algorithm?, header?, cookie? } }` (experimental, see [Tokens and sessions](auth.md#tokens-and-sessions)) is an authenticator as JSON, for a stage that lives in an `afora.json`. The factory of `sinkOf` takes a second argument, the hooks, for what JSON cannot hold (an authenticator, middlewares); `build` gets it, and the description of the stage says `hooks: true` (when one of them is defined) without saying what they are, so extraction to an `afora.json` asks for an import of the stage instead of dropping them (see [Routes and access](afora-json.md#routes-and-access)). [`@afora/hono`](../packages/hono/README.md), `@afora/fastify`, `@afora/express` and `@afora/elysia` are built this way and pass `httpProviderContract` (from `@afora/core/testing`), the cases every such sink must pass: see [HTTP providers](providers.md).
- **Uploads.** An input with a file (`ctx.file`, or [`ctx.fileOf({ types, maxBytes })`](std-properties.md#files); any field whose schema is `format: "binary"`, a list of files included) is read from a `multipart/form-data` body when the request sends one: `request.form()` gives the `FormData` (every adapter has it; a server whose request has no `form` answers 415 `UnsupportedMediaType`, a body that is not valid multipart, or has no boundary, a 400 `InvalidRequestBody`, and an `Exception` that `form()` throws, such as Express's `MultipartBodyAlreadyRead` when another parser read the body first, its status, 500 by default). A multipart body sent to a route whose input has no file is a 415 `UnsupportedMediaType`, as any body that is not JSON. A file part is the `File` itself, never copied; a text part is coerced to the number or boolean the field takes, as a query string is; a field that is an object (a blueprint, a record, a variant, `json`) takes its part as JSON text (text that is not JSON is kept for the blueprint to reject); the parts of a repeated key are the items of a list field (one part is a list of one; a list of objects may also be one JSON text). The parts are walked once, at most `maxParts` of them (an option of every HTTP sink, 1000 by default; more is a 413 `TooManyParts` problem); of the keys that are not declared, only the first is kept (its first part), for the blueprint to reject, and the others are dropped unread. A file declared as a PNG, JPEG, GIF, WebP or AVIF must start with the bytes of that format (its first 32 bytes are read): one that does not is a 400 `InvalidFileContent` problem with an issue at its key, so a script or an SVG renamed `.png` is refused even where the property takes the type it claims. Other types are only what the client declares. The path, the route query, headers and cookies are then placed over it as over a JSON body, so a key read from a header is never taken from a part. The same route still takes a JSON body for its other keys, and the missing file is then a 400 issue at its key. Only a `post`, `put` or `patch` (or a `delete` with `body: true`) can take a file, at the top level of its input: on a `get` or a `delete` without a body, or as a path, query, header or cookie key, it throws `InvalidOutputStage`. The type and the size are checked by the property once the body is read (an issue at the key: a 400): the size of the body itself is for the server or the proxy to limit (Fastify's `bodyLimit`, 1 MiB by default; a `limit` in front of Express or Hono).
- **WebSocket.** The `websocket` sink of [`@afora/ws`](../packages/ws/README.md) serves the operations over JSON messages on any runtime, with topic subscriptions fed by [`publishEvents`](commands.md#event-policies). `coerceTextValues(blueprint, texts)` (from `@afora/core/adapters`) converts text (a query string, headers, session values) to the numbers and booleans a blueprint takes, for sinks that read text.
- **Webhooks.** The `hono` sink of `@afora/hono` can verify the signature of incoming webhooks (Stripe, GitHub, Standard Webhooks, plain HMAC-SHA256) before an operation runs, and drop the keys its input does not declare; every input key of a webhook comes from the signed body, so a webhook route that reads one from the path, the query, a header or a cookie throws `InvalidOutputStage` at build: see its [`webhooks` option](../packages/hono/README.md#webhooks).
- **Operations.** `operationId` is the id with an underscore for the dot (`Users_register`; a collision throws), `summary` is the id, plus `description`, `tags` and `deprecated` from the descriptor. `post`, `put` and `patch` send the input as a JSON body (omitted when it has no fields), or as `multipart/form-data` when it holds a file (`type: "string", format: "binary"`); `get` and `delete` send it as query parameters, which needs every field to be a scalar property, otherwise the build throws `InvalidOutputStage` (route it with `post`). A `delete` with `body: true` (in the [use case route](use-cases.md#routes) or in the `route` option of the sink, which wins) sends it as a JSON body instead, as `post` does, `required` only when a field left in it is; `body` on any other method is rejected, since a `get` never reads a body and the others always do. Path parameters are taken out of both first. The `context` is transport-specific and not in the document: sinks that serve HTTP map it (headers, middleware).
- **Responses.** The `route` status (`200` by default; `201`, `202` or `204`) with the response schema (sensitive keys are `writeOnly`, the keys a record declares `sensitive` too where the response is its blueprint or one derived from it by `optionalOf`, `join` or `sliceOf`, at any depth, as the response is masked; a list response is `type: array` with its `items`, whose records are components too), except `204`, which has no content; the same for each of the route `statuses`, described by the status (`Service unavailable.` for `503`) and documented as chosen by the operation (a status that is also an error status, such as `500`, gets both media types); `400` and `500` always, and one response per status of the declared `errors`, given by `statusOf` with the output `statuses` (422 by default). An operation does not expose its repository dependencies, so `404` and `409` are documented when a declared error maps to them. Errors are `application/problem+json` with `components.schemas.Problem` (RFC 9457 plus `layer` and `issues`).
- **Headers.** `responses: { [operationId]: { headers: { name: value } } }` adds static headers to the success response of an operation (`cache-control`, say; not `content-type`), documented as `{ schema: { type: "string", const: value } }`. `requestId: true` (`x-request-id`) or `requestId: "<header>"` documents a request id header on every response, problems included.
- **Security.** `security: { schemes, operations?, default? }` documents how operations authenticate: `schemes` are `components.securitySchemes` (`http`, `apiKey`, `oauth2`, `openIdConnect` or `mutualTLS`, as OpenAPI writes them), `default: { scheme, scopes? }` is the document `security`, and `operations: { [operationId]: { scheme, scopes? } | false }` the `security` of each operation (`false` is `security: []`, a public operation under a `default`). A requirement naming an unknown scheme is rejected when the stage is made. On its own it is documentation: what is enforced is the [access](auth.md) each use case declares, and an operation with one gets its `security` from that declaration (the `default` scheme, else the only one, with the declared scopes; `security: []` for `{ public: true }` under a `default`), plus a `401` response, and a `403` with scopes or an owner. `false` in `operations` for an operation with an access throws `InvalidOutputStage`.
- **Models.** Records and entities reachable from inputs and responses are `components.schemas` named by class name and referenced with `$ref` (see [OpenAPI](openapi.md)). Two different classes with one name, an anonymous class or a class named `Problem` throw `InvalidOutputStage`.
