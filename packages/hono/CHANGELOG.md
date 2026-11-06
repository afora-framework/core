# Changelog

## 1.0.0 — unreleased (draft: dated when it is published)

### Added

- First version. `hono(options)`, a sink for `outputOf` that returns a Hono app: one route per operation (the routing of the `openapi` sink, `operationRoutes` from `@afora/core`), a JSON body for body methods and the query string for `get` and `delete` (scalars coerced to numbers and booleans where the input takes them), the context built from request headers (`context.headers`), `200` with the masked response (`outputValueOf`), problem+json errors with the status of `statusOf` and the output `statuses`, a 404 problem for unknown routes, and the OpenAPI document of the same operations at `docs.path`.
- `HonoStages` (`stageCatalogOf(hono)`) and `stages`, the catalog entries `{ name, module, export }` that codegen reads.
