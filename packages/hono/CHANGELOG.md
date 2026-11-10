# Changelog

## Unreleased

### Added

- `webhooks`: `{ [operationId]: { scheme, secret, header?, encoding?, prefix?, tolerance?, unknownKeys? } }` verifies the signature of each request to those operations over the raw body before parsing it, for the schemes `"stripe"`, `"github"`, `"standard-webhooks"` and `"hmac-sha256"`, with Web Crypto (Bun, Node, Workers). The secret is read from the request bindings, then `process.env`; a list of variables allows rotation; `tolerance` guards timestamped schemes against replays (300 s by default). A bad signature is a 401 problem `InvalidWebhookSignature`, a missing secret a 500 `WebhookSecretMissing`; both are exported. `unknownKeys: "strip"` drops the keys the input does not declare (`stripUndeclared` from `@afora/core`). The OpenAPI document lists the signature headers and the 401 of each webhook route. `verifyWebhook` is exported for routes written by hand.

### Fixed

- `stages` gives `kind: "sink"`, as documented, so codegen rejects `{ "transform": "hono" }`.

## 0.0.1 — unreleased (draft: dated when it is published)

### Added

- First version. `hono(options)`, a sink for `outputOf` that returns a Hono app: one route per operation (the routing of the `openapi` sink, `operationRoutes` from `@afora/core`), a JSON body for body methods and the query string for `get` and `delete` (scalars coerced to numbers and booleans where the input takes them), the context built from request headers (`context.headers`), `200` with the masked response (`outputValueOf`), problem+json errors with the status of `statusOf` and the output `statuses`, a 404 problem for unknown routes, and the OpenAPI document of the same operations at `docs.path`.
- `HonoStages` (`stageCatalogOf(hono)`) and `stages`, the catalog entries `{ name, module, export }` that codegen reads.
