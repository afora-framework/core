# Changelog

## Unreleased

### Security

- **Breaking.** Every input key of a webhook operation comes from the signed body: a webhook whose route reads an input key from the path, the query, a header or a cookie throws `InvalidOutputStage` when the app is built. The README says which values a webhook can be deduplicated on. See [Webhooks](README.md#webhooks). (SEC-37)

## 27.0.0-rc.4 — 2026-11-16

A candidate of 27.0.0, with no changes since 27.0.0-rc.3. See the [root CHANGELOG](../../CHANGELOG.md).

## 27.0.0-rc.3 — 2026-11-16

A candidate of 27.0.0, with no changes since 27.0.0-rc.2. See the [root CHANGELOG](../../CHANGELOG.md).

## 27.0.0-rc.2 — 2026-11-16

A candidate of 27.0.0, with no changes since 27.0.0-rc.1. See the [root CHANGELOG](../../CHANGELOG.md).

## 27.0.0-rc.1 — 2026-11-16

The first release candidate of 27.0, with the API of 0.0.13; it needs `@afora/core >=27.0.0-rc.1`. See the [root CHANGELOG](../../CHANGELOG.md).

## 0.0.13 — 2026-11-16

### Added

- File uploads (#118): an input that holds a file (`ctx.fileOf`) is read from a `multipart/form-data` body with `c.req.formData()`.
- The package passes `httpProviderContract` of `@afora/core/testing`, with `@afora/fastify`, `@afora/express` and `@afora/elysia`.
- The option `auth: { jwt: ... }` (experimental) authenticates callers from a JSON Web Token.
- Hooks, the second argument of `hono(options, hooks)`, for what JSON cannot hold: `authenticator` (who calls, from the request: a `Principal` or `null`), `middlewares` (Hono middlewares run before every route) and `app` (a Hono app to add the routes to). The type `HonoHooks` is exported.
- An operation whose use case declares an `access` is enforced: it asks the `authenticator` and answers a 401 or a 403 problem; without the hook it answers 401.
- The route a use case declares (`route` or `@Route`) is served, with the input keys it reads from the query, headers and cookies.
- `webhooks`: `{ [operationId]: { scheme, secret, header?, encoding?, prefix?, tolerance?, unknownKeys? } }` verifies the signature of each request to those operations over the raw body before parsing it, for the schemes `"stripe"`, `"github"`, `"standard-webhooks"` and `"hmac-sha256"`, with Web Crypto (Bun, Node, Workers). The secret is read from the request bindings, then `process.env`; a list of variables allows rotation; `tolerance` guards timestamped schemes against replays (300 s by default). A bad signature is a 401 problem `InvalidWebhookSignature`, a missing secret a 500 `WebhookSecretMissing`; both are exported. `unknownKeys: "strip"` drops the keys the input does not declare (`stripUndeclared` from `@afora/core`). The OpenAPI document lists the signature headers and the 401 of each webhook route. `verifyWebhook` is exported for routes written by hand.
- Path parameters: `route: { "Entries.get": { method: "get", path: "/entries/{slug}" } }` fills the input key `slug` from the path (decoded, coerced like the query), over the body or query.
- `route[id].status` (`200`, `201`, `202` or `204`; `204` sends no body), `responses: { [operationId]: { headers } }` for static headers of successes (such as `cache-control`), and `requestId: true | "<header>"`, which propagates the request's id or generates one (`crypto.randomUUID`) on every response, problems included.
- `context.variables: { [contextKey]: variableName }` reads what a middleware set with `c.set`, as it is, beside `context.headers`.
- `security: { schemes, operations?, default? }` reaches the OpenAPI document (`components.securitySchemes`, `security`); the sink does not enforce it.

### Changed

- The peer dependency on `@afora/core` is `>=0.0.9`: the sink is built on `compileRoutes`.
- The requests are handled by the route table of `@afora/core/adapters` (`compileRoutes`), shared with the other HTTP sinks, so this package needs a `@afora/core` that has it. Responses are the same; the body is serialized once instead of twice. `HonoOptions` extends `HttpOptions`.
- `route[id].path` rejects `:` and `*`, which were accepted and served as Hono patterns while the document showed them as text; write parameters as `{name}`.

### Fixed

- `stages` gives `kind: "sink"`, as documented, so codegen rejects `{ "transform": "hono" }`.

## 0.0.1 — unreleased (draft: dated when it is published)

### Added

- First version. `hono(options)`, a sink for `outputOf` that returns a Hono app: one route per operation (the routing of the `openapi` sink, `operationRoutes` from `@afora/core`), a JSON body for body methods and the query string for `get` and `delete` (scalars coerced to numbers and booleans where the input takes them), the context built from request headers (`context.headers`), `200` with the masked response (`outputValueOf`), problem+json errors with the status of `statusOf` and the output `statuses`, a 404 problem for unknown routes, and the OpenAPI document of the same operations at `docs.path`.
- `HonoStages` (`stageCatalogOf(hono)`) and `stages`, the catalog entries `{ name, module, export }` that codegen reads.
