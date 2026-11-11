# @afora/hono

A [Hono](https://hono.dev) sink for [`@afora/core`](../../README.md) outputs. It turns the operations of an output into a Hono app: validated input (from the body, the query and path parameters), the response with the status and headers you declare (sensitive values masked), RFC 9457 `application/problem+json` errors, and an OpenAPI document of the same routes. Outputs, stages and `statusOf` are described in [docs/outputs.md](../../docs/outputs.md).

```bash
bun add @afora/core @afora/hono hono typebox
```

`@afora/core`, `hono` (`^4.13.14`) and TypeBox (`^1`) are peer dependencies. The package uses only web APIs, so it runs on Bun, Node >= 22 and Workers.

## Example

```ts
import { outputOf } from "@afora/core";
import { hono } from "@afora/hono";

const Api = outputOf({
	name: "Blog",
	commands: [Users, Posts], // commandOf(...) declarations
	statuses: { InvalidCredentials: 401, Unauthorized: 401 },
	pipe: [
		hono({
			basePath: "/api",
			route: { "Posts.list": { method: "get" } },
			docs: {
				path: "/openapi.json",
				info: { title: "Blog", version: "1.0.0" },
			},
			context: { headers: { authorization: "authorization" } },
		}),
	],
});

export default Api.build(); // a Hono app: Bun.serve, Workers and `app.request(...)` all take it
```

```
POST /api/users/register  { "name": "Ana", "email": "ana@example.com", "plainPassword": "S3cret-pass!" }
-> 200 { "user": { "name": "Ana", "email": "ana@example.com", "password": "********", ... } }

POST /api/users/login  { "email": "ana@example.com", "plainPassword": "wrong" }
-> 401 application/problem+json
   { "type": "urn:afora:exception:InvalidCredentials", "title": "InvalidCredentials",
     "status": 401, "detail": "Wrong email or password.", "layer": "use-case" }

POST /api/users/register  { "email": "nope" }
-> 400 application/problem+json  { ..., "issues": [{ "path": ["email"], "code": "...", "message": "..." }] }
```

## Options

All options are JSON, so the stage can live in an `afora.json` (`{ "sink": "hono", "options": { ... } }`).

| Option      | Meaning                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `basePath`  | Prefix of every route, e.g. `"/api"`.                                                                                                                                                                                                      |
| `route`     | `{ [operationId]: { method?, path?, status? } }`, as in the `openapi` sink: `path` may hold `{name}` parameters, `status` is `200` (default), `201`, `202` or `204`. See [Routes, statuses and headers](#routes-statuses-and-headers).     |
| `responses` | `{ [operationId]: { headers: { name: value } } }`: static headers of the success responses, such as `cache-control`.                                                                                                                       |
| `requestId` | `true` (`x-request-id`) or a header name: every response carries the request's id, or a new one.                                                                                                                                           |
| `security`  | `{ schemes, operations?, default? }`: security schemes and requirements for the OpenAPI document. What is enforced is the `access` of each use case: see [Authentication](#authentication).                                                |
| `docs`      | `{ path, info: { title, version, description? }, servers? }`: serves the `openapi` document of the same operations, routes and `basePath` at `path` (not under `basePath`). A `path` that is also a GET route throws `InvalidOutputStage`. |
| `debug`     | `true` adds the `trace` to problems and the real `detail` to 5xx ones. Off by default.                                                                                                                                                     |
| `context`   | `{ headers?: { [contextKey]: headerName }, variables?: { [contextKey]: variableName } }`: the context of an operation from request headers and from what a middleware set with `c.set`.                                                    |
| `webhooks`  | `{ [operationId]: { scheme, secret, ... } }`: verifies the signature of each request to these operations before parsing it. See [Webhooks](#webhooks).                                                                                     |

What JSON cannot hold goes in a second argument, the hooks: `hono(options, { authenticator, middlewares, app })`.

| Hook            | Meaning                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authenticator` | `(request) => Principal \| null`: who calls, from the credentials of the request. See [Authentication](#authentication).                                            |
| `middlewares`   | Hono middlewares (`cors()`, a rate limiter, your own), run in order before every route of the sink.                                                                 |
| `app`           | A Hono app to add the routes to, instead of a new one. Its own middlewares, `notFound` and `onError` are kept, so the sink does not replace them with problem ones. |

Hooks are not part of the description of the stage (`describe()`, `afora.json`).

Invalid options throw `InvalidOutputStage` when the stage is made, and unknown operation ids in `route` or two operations on one method and path when the app is built.

## Behavior

- **Routes.** `POST {basePath}/{kebab(command)}/{kebab(operation)}` (`/users/change-password`), or the [route the use case declares](../../docs/use-cases.md#routes) with `route` or `@Route`, after the `basePath`; the `route` option changes the method, path and status over both. It is the routing of the `openapi` sink (`operationRoutes` of `@afora/core/adapters`), so the served routes and the document agree.
- **Input.** `post`, `put` and `patch` read a JSON body (an empty body is `{}`; invalid JSON is a 400 `InvalidRequestBody` problem). `get` and `delete` read the query string, converting a value to a number or boolean when the input field takes one rather than a string; anything else is kept for the blueprint to reject. A `{name}` segment of the path fills the input key `name`, decoded and converted the same way, and wins over a `name` in the body or the query. So do the keys a use case route reads from the query (on a route with a body), from a header or from a cookie. The operation validates the input: a 400 problem with `issues` (`path`, `code`, `message`, no values).
- **Context.** For an operation whose command or use case declares a `context`, each key listed in `context.headers` is read from its header, and each key in `context.variables` from the variable a middleware set (`c.get(name)`); a missing one leaves the key out (so an optional key is `undefined`, a required one a 400 problem). Header values are converted like query values; variables are passed as they are (objects too), and the `context` blueprint validates both. A key cannot come from both.
- **Access.** An operation whose use case declares an [`access`](../../docs/auth.md) asks the `authenticator` hook who calls, and answers a 401 (`Unauthenticated`) or a 403 (`Forbidden`) problem before the input is validated. Without the hook, such an operation always answers 401.
- **Success.** The `route` status (`200` by default) with `outputValueOf(response)`: records go through `toJSON`, so sensitive values (a `Password`) are `"********"`. A `204` has no body. The `responses` headers of the operation are added.
- **Errors.** Status from `statusOf(error, operation, output.statuses)`: the output `statuses` first, then 400 for invalid input or context, 404 for a missing entity, 409 for a unique violation, 422 for an error the use case declares, else 500. The body is `problemOf` with `application/problem+json`; a 5xx says `"Internal error."` unless `debug` is on.
- **Request id.** With `requestId`, every response of the app (successes, problems, unknown routes, the docs) carries the id in that header: the one the request sent, if it is 1 to 200 visible ASCII characters, else a new `crypto.randomUUID()`.
- **Unknown routes** are a `404` problem (`urn:afora:exception:NotFound`) instead of Hono's plain text, and anything thrown outside an operation (your own middleware) is a problem too, through `app.onError`.

## Routes, statuses and headers

```ts
hono({
	route: {
		"Entries.get": { method: "get", path: "/entries/{slug}" },
		"Entries.create": { path: "/entries", status: 201 },
		"Entries.update": { method: "patch", path: "/entries/{slug}" },
		"Entries.remove": {
			method: "delete",
			path: "/entries/{slug}",
			status: 204,
		},
	},
	responses: {
		"Entries.get": {
			headers: { "cache-control": "public, max-age=60, s-maxage=86400" },
		},
	},
	requestId: true,
});
```

```
GET /entries/hello            -> 200, cache-control and x-request-id; input { slug: "hello" }
PATCH /entries/hello  { "title": "New" }  -> input { slug: "hello", title: "New" }
DELETE /entries/hello         -> 204, no body
```

- **Path parameters.** `{name}` is a whole segment, and `name` must be a scalar key of the operation's input; otherwise the app (and the document) throw `InvalidOutputStage` when built. Hono patterns (`:name`, `*`) are rejected: the path is written once, for both the routes and the document, which gets an `in: path` parameter and leaves the key out of the body or query.
- **Headers.** `responses` headers are static and only on successes, so a problem is never cached by a `cache-control` meant for the content; `content-type` is the sink's. Headers that depend on the request belong to a middleware.

## Webhooks

`webhooks` names the operations that receive webhooks from another service. The sink checks the signature of each request over the raw body, byte for byte as it was sent, before it parses anything. A request that fails is a `401` problem `InvalidWebhookSignature`. Its `detail` never says what was wrong; the `trace` of a `debug` problem does. Change the status with the output `statuses` (`{ InvalidWebhookSignature: 403 }`).

```ts
hono({
	webhooks: {
		"Payments.received": {
			scheme: "stripe",
			secret: { env: "STRIPE_WEBHOOK_SECRET" },
			unknownKeys: "strip",
		},
		"Repos.pushed": {
			scheme: "github",
			secret: { env: "GITHUB_WEBHOOK_SECRET" },
		},
		"Mail.delivered": {
			scheme: "standard-webhooks",
			secret: { env: ["MAIL_SECRET", "MAIL_SECRET_OLD"] },
		},
		"Partner.notified": {
			scheme: "hmac-sha256",
			secret: { env: "PARTNER_SECRET" },
			header: "x-partner-signature",
			prefix: "sha256=",
		},
	},
});
```

| Field         | Meaning                                                                                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheme`      | `"stripe"` (`Stripe-Signature`), `"github"` (`X-Hub-Signature-256`), `"standard-webhooks"` (`webhook-id`, `webhook-timestamp`, `webhook-signature`; used by Svix, Resend, Clerk...) or `"hmac-sha256"` (a header you name). |
| `secret`      | `{ env: "NAME" }`: the variable holding the secret. A list allows rotation: a request passes when any secret that is set verifies it.                                                                                       |
| `header`      | `"hmac-sha256"` only, and required there: the header with the signature.                                                                                                                                                    |
| `encoding`    | `"hmac-sha256"` only: `"hex"` (default) or `"base64"`.                                                                                                                                                                      |
| `prefix`      | `"hmac-sha256"` only: text before the signature, such as `"sha256="`.                                                                                                                                                       |
| `tolerance`   | `"stripe"` and `"standard-webhooks"` only: how many seconds the signed timestamp may be away from now, against replays. `300` by default; `0` turns the check off.                                                          |
| `unknownKeys` | `"reject"` (default): a key the input does not declare is a 400, as on any route. `"strip"`: those keys are dropped first, with `stripUndeclared` from `@afora/core`, so the input declares only what the operation reads.  |

- **Secrets.** The variable is read on each request: first from the bindings of the request (`c.env`: Cloudflare Workers, or the third argument of `app.request` in tests), then from `process.env` (Bun, Node). A webhook with none of its variables set is a `500` problem `WebhookSecretMissing`, whose detail is masked. Secrets and variable names never reach the OpenAPI document.
- **Signatures** are HMAC-SHA256 checked with Web Crypto (`crypto.subtle.verify`, which compares in constant time), so it runs on Bun, Node and Workers. Stripe's and standard-webhooks' headers may carry several signatures; any one that matches passes.
- **Order.** Signature, then JSON (invalid JSON is the usual 400 `InvalidRequestBody`), then `unknownKeys`, then the context from headers, then the operation. Other routes are not affected.
- **Idempotency.** Verification keeps no state, so a request sent twice (a retry) runs twice. Map the delivery id into the context (`context: { headers: { delivery: "webhook-id" } }`) and let the operation ignore one it has already handled.
- **Routes.** A webhook operation needs a body: one routed with `get` or `delete`, or an id that is not an operation of the output, throws `InvalidOutputStage` when the app is built.
- **OpenAPI.** The document at `docs.path` lists the signature headers of each webhook route as required parameters, adds its `401` response and marks it with `x-afora-webhook: { scheme }`.

`verifyWebhook(options, secrets, { header, body, now? })` is the check on its own, for a route you write by hand: it resolves to `undefined` when the request is signed, or to why not (`"missing_signature"`, `"malformed_signature"`, `"expired"`, `"mismatch"`).

## Authentication

Who may call an operation is declared on its use case, with [`access`](../../docs/auth.md), and the core enforces it. The sink only has to say **who is calling**, which is the `authenticator` hook: it gets the request and gives a `Principal` (`{ subject, scopes, claims? }`), or `null` for an anonymous caller.

```ts
import { Access, outputOf, Route, useCaseOf } from "@afora/core";
import { hono } from "@afora/hono";

@Route("PATCH", "/entries/{slug}")
@Access({ scopes: ["entries:write"], context: { userId: "subject" } })
class UpdateEntry extends useCaseOf({
	name: "UpdateEntry",
	blueprint: EntryChanges,
	response: EntryResponse,
	context: blueprintOf((ctx) => ({ userId: ctx.id })),
}) {
	// this.context.userId is the authenticated caller
}

const api = outputOf({
	name: "Cms",
	commands: [Entries],
	pipe: [
		hono(
			{ security: { schemes: { bearer: { type: "http", scheme: "bearer" } } } },
			{
				authenticator: async (request) => {
					const token = request
						.header("authorization")
						?.replace(/^Bearer /, "");
					const session = token ? await sessions.find(token) : undefined; // your check
					return session
						? { subject: session.userId, scopes: session.scopes }
						: null;
				},
			},
		),
	],
}).build();
```

- **`request`** has `header(name)` (lower case), `cookie(name)`, the `operation` being called and `native`, the Hono `Context`.
- **It is asked only for operations with an `access`** other than `{ public: true }`, once per request.
- **It may throw `Unauthenticated`** (from `@afora/core`) to refuse credentials it does not accept; `null` and a throw are both a 401.
- **The document** gets the `security` of each such operation from its `access`, under the scheme of `security.schemes`, with its `401` and `403` responses.

A value that is not about access (a tenant resolved from the host, a feature flag) still reaches the context through a middleware and `context.variables`:

```ts
hono(
	{ context: { variables: { tenant: "tenant" } } },
	{
		middlewares: [
			async (c, next) => {
				c.set("tenant", tenantOf(c.req.header("host")));
				await next();
			},
		],
	},
);
```

The context only reaches the use case for operations that declare one, so the key (`tenant` here) must be in the `context` blueprint of the command or use case.

## Catalog

`HonoStages` is `stageCatalogOf(hono)` (from `@afora/core/adapters`), and `stages` are the entries codegen reads to resolve `{ "sink": "hono" }` in an `afora.json`:

```ts
import { stages } from "@afora/hono";
// [{ name: "hono", module: "@afora/hono", export: "hono", kind: "sink" }]
```
