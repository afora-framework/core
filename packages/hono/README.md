# @afora/hono

A [Hono](https://hono.dev) sink for [`@afora/core`](../../README.md) outputs. It turns the operations of an output into a Hono app: validated input, `200` with the response (sensitive values masked), RFC 9457 `application/problem+json` errors, and an OpenAPI document of the same routes. Outputs, stages and `statusOf` are described in [docs/outputs.md](../../docs/outputs.md).

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

| Option     | Meaning                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `basePath` | Prefix of every route, e.g. `"/api"`.                                                                                                                                                                                                      |
| `route`    | `{ [operationId]: { method?, path? } }`, as in the `openapi` sink.                                                                                                                                                                         |
| `docs`     | `{ path, info: { title, version, description? }, servers? }`: serves the `openapi` document of the same operations, routes and `basePath` at `path` (not under `basePath`). A `path` that is also a GET route throws `InvalidOutputStage`. |
| `debug`    | `true` adds the `trace` to problems and the real `detail` to 5xx ones. Off by default.                                                                                                                                                     |
| `context`  | `{ headers: { [contextKey]: headerName } }`.                                                                                                                                                                                               |
| `webhooks` | `{ [operationId]: { scheme, secret, ... } }`: verifies the signature of each request to these operations before parsing it. See [Webhooks](#webhooks).                                                                                     |

Invalid options throw `InvalidOutputStage` when the stage is made, and unknown operation ids in `route` or two operations on one method and path when the app is built.

## Behavior

- **Routes.** `POST {basePath}/{kebab(command)}/{kebab(operation)}` (`/users/change-password`); `route` changes the method and path. It is the routing of the `openapi` sink (`operationRoutes` in the core), so the served routes and the document agree.
- **Input.** `post`, `put` and `patch` read a JSON body (an empty body is `{}`; invalid JSON is a 400 `InvalidRequestBody` problem). `get` and `delete` read the query string, converting a value to a number or boolean when the input field takes one rather than a string; anything else is kept for the blueprint to reject. The operation validates the input: a 400 problem with `issues` (`path`, `code`, `message`, no values).
- **Context.** For an operation whose command or use case declares a `context`, each key listed in `context.headers` is read from its header; a missing header leaves the key out (so an optional key is `undefined`, a required one a 400 problem). Header values are converted like query values.
- **Success.** `200` with `outputValueOf(response)`: records go through `toJSON`, so sensitive values (a `Password`) are `"********"`.
- **Errors.** Status from `statusOf(error, operation, output.statuses)`: the output `statuses` first, then 400 for invalid input or context, 404 for a missing entity, 409 for a unique violation, 422 for an error the use case declares, else 500. The body is `problemOf` with `application/problem+json`; a 5xx says `"Internal error."` unless `debug` is on.
- **Unknown routes** are a `404` problem (`urn:afora:exception:NotFound`) instead of Hono's plain text, and anything thrown outside an operation (your own middleware) is a problem too, through `app.onError`.

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
		"Repos.pushed": { scheme: "github", secret: { env: "GITHUB_WEBHOOK_SECRET" } },
		"Mail.delivered": { scheme: "standard-webhooks", secret: { env: ["MAIL_SECRET", "MAIL_SECRET_OLD"] } },
		"Partner.notified": {
			scheme: "hmac-sha256",
			secret: { env: "PARTNER_SECRET" },
			header: "x-partner-signature",
			prefix: "sha256=",
		},
	},
});
```

| Field         | Meaning                                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheme`      | `"stripe"` (`Stripe-Signature`), `"github"` (`X-Hub-Signature-256`), `"standard-webhooks"` (`webhook-id`, `webhook-timestamp`, `webhook-signature`; used by Svix, Resend, Clerk...) or `"hmac-sha256"` (a header you name). |
| `secret`      | `{ env: "NAME" }`: the variable holding the secret. A list allows rotation: a request passes when any secret that is set verifies it.                                                                                       |
| `header`      | `"hmac-sha256"` only, and required there: the header with the signature.                                                                                                                                                  |
| `encoding`    | `"hmac-sha256"` only: `"hex"` (default) or `"base64"`.                                                                                                                                                                     |
| `prefix`      | `"hmac-sha256"` only: text before the signature, such as `"sha256="`.                                                                                                                                                      |
| `tolerance`   | `"stripe"` and `"standard-webhooks"` only: how many seconds the signed timestamp may be away from now, against replays. `300` by default; `0` turns the check off.                                                         |
| `unknownKeys` | `"reject"` (default): a key the input does not declare is a 400, as on any route. `"strip"`: those keys are dropped first, with `stripUndeclared` from `@afora/core`, so the input declares only what the operation reads. |

- **Secrets.** The variable is read on each request: first from the bindings of the request (`c.env`: Cloudflare Workers, or the third argument of `app.request` in tests), then from `process.env` (Bun, Node). A webhook with none of its variables set is a `500` problem `WebhookSecretMissing`, whose detail is masked. Secrets and variable names never reach the OpenAPI document.
- **Signatures** are HMAC-SHA256 checked with Web Crypto (`crypto.subtle.verify`, which compares in constant time), so it runs on Bun, Node and Workers. Stripe's and standard-webhooks' headers may carry several signatures; any one that matches passes.
- **Order.** Signature, then JSON (invalid JSON is the usual 400 `InvalidRequestBody`), then `unknownKeys`, then the context from headers, then the operation. Other routes are not affected.
- **Idempotency.** Verification keeps no state, so a request sent twice (a retry) runs twice. Map the delivery id into the context (`context: { headers: { delivery: "webhook-id" } }`) and let the operation ignore one it has already handled.
- **Routes.** A webhook operation needs a body: one routed with `get` or `delete`, or an id that is not an operation of the output, throws `InvalidOutputStage` when the app is built.
- **OpenAPI.** The document at `docs.path` lists the signature headers of each webhook route as required parameters, adds its `401` response and marks it with `x-afora-webhook: { scheme }`.

`verifyWebhook(options, secrets, { header, body, now? })` is the check on its own, for a route you write by hand: it resolves to `undefined` when the request is signed, or to why not (`"missing_signature"`, `"malformed_signature"`, `"expired"`, `"mismatch"`).

## Authentication and custom context

Options are JSON, so there is no callback for the context. Cross-cutting rules such as authentication are a `transform` stage that wraps `invoke`: it sees the context the sink built from headers and can reject the call, which then goes through `statuses` like any other error.

```ts
import {
	ExceptionLayers,
	exceptionOf,
	operationOf,
	outputOf,
	transformOf,
} from "@afora/core";
import { hono } from "@afora/hono";

const Unauthorized = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "Unauthorized",
	message: "Sign in first.",
});

// the operation's use case (or command) declares `context: blueprintOf((ctx) => ({ authorization: ctx.optional.string }))`
export const requireAuth = transformOf({
	name: "requireAuth",
	apply: (operation) =>
		operation.tags.includes("public")
			? operation
			: operationOf(operation, {
					invoke: async (input, call) => {
						const { authorization } = (call?.context ?? {}) as {
							authorization?: string;
						};
						if (!authorization)
							throw new Unauthorized({ source: operation.id });
						// verify the token and put the user into the call, if the context declares it
						return operation.invoke(input, call);
					},
				}),
});

outputOf({
	name: "Blog",
	commands: [Users, Posts],
	statuses: { Unauthorized: 401 },
	pipe: [
		requireAuth(),
		hono({ context: { headers: { authorization: "authorization" } } }),
	],
});
```

The context only reaches `invoke` for operations that declare one, so the key (`authorization` here) must be in the `context` blueprint of the command or use case.

## Catalog

`HonoStages` is `stageCatalogOf(hono)`, and `stages` are the entries codegen reads to resolve `{ "sink": "hono" }` in an `afora.json`:

```ts
import { stages } from "@afora/hono";
// [{ name: "hono", module: "@afora/hono", export: "hono", kind: "sink" }]
```
