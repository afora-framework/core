# Changelog

## 27.0.0-rc.6 — 2026-11-24

### Security

- `afora_generate` runs `tsc` with `--pretty false`, so a project whose tsconfig sets `pretty` gets its diagnostics parsed and redacted like any other, and a `tsc` that fails without a diagnostic is reported by its exit code, never with what it printed. (SEC-53)
- **Breaking.** A package named by `extends` is looked up in the `node_modules` of the project only, never in a parent directory, a package cache or the registry, and its spec, with what that spec extends, must really be inside `<project>/node_modules`; otherwise the issue is `unresolved_extends`. Gets the fix of `@afora/codegen`. (SEC-54)
- `unresolved_extends` names a file from the project root, never by an absolute path. (SEC-55)
- Gets the fix of `@afora/codegen` for a free-form JSON key printed as a shorthand property (SEC-56).

## 27.0.0-rc.5 — 2026-11-24

### Security

- The diagnostics of `afora_generate` carry the file, line, column, TS code and a message whose string and template literals and quoted types are redacted (`"…"`, `'…'`); a quoted plain name such as `'ServiceFactory'` is kept. A type of a project module written `as const` no longer brings its values into the answer. (SEC-32)
- An `afora.json`, or a spec it extends, that is not valid JSON is reported without the parser's message, which could quote the file; `unresolved_extends` gives the paths inside the project from its root. (SEC-33)
- Gets the fix of `@afora/codegen` for a spec string with a long run of spaces (SEC-31).
- Gets the fix of `@afora/codegen` for an `output.dir` with a root or a drive (SEC-39): `afora_spec_validate`, `afora_spec_write`, `afora_generate` and `afora_extract` (its `outputDir`) report it as `invalid_output`.

### Fixed

- `afora_project` gives the default route of an operation in linear time for a name with a long run of capitals; the routes are the same as before.
- `afora_generate` type-checks with the TypeScript installed in the project (`node_modules/typescript` of the project directory), run by the server's own runtime, and only with it: a `tsc` of a parent directory, the `PATH` or a package cache is never run (`bunx --no-install` and `npx --no-install` looked there). A project without TypeScript gets `typecheck: { ran: false }` with the reason. (SEC-41)
- Gets the fix of `@afora/codegen` for `node_modules` and `.git` in the spellings Windows reads as them (SEC-40).
- `afora_project` shows `hooks: true` on an output whose sink was given hooks in code (an authenticator, middlewares), and its `authentication` and notes say so. `afora_extract` asks for `outputs.<Name>.pipe.<index>` in `imports` for such a stage instead of dropping its hooks (#199).

## 27.0.0-rc.4 — 2026-11-16

### Security

- The parser of `tsc` output reads a diagnostic line in linear time; a line repeating `(0,0): error TS0: ` took seconds.

## 27.0.0-rc.3 — 2026-11-16

### Security

- `afora_spec_validate`, `afora_spec_write` and `afora_generate` get the boundary fixes of `@afora/codegen` (SEC-05, SEC-06, SEC-17). When loading what a spec extends fails, `unresolved_extends` carries the loader's reason instead of a generic "was not loaded".
- The `app` of `afora_project` and `afora_extract` must be a `.ts`, `.tsx`, `.mts`, `.js` or `.mjs` module outside `node_modules` and `.git`, and only the `--app` module when the server was started with one. A failed import is reported by a code (`import_failed`, `not_an_application`, `extract_failed`), never with what the runtime printed. (SEC-18)

### Changed

- The guide describes `changePassword`, that `update` never takes a sensitive key, `owner.key: "id"`, `restore` with `owner`, `relations` and `maxLimit`.

## 27.0.0-rc.2 — 2026-11-16

A candidate of 27.0.0, with no changes since 27.0.0-rc.1. See the [root CHANGELOG](../../CHANGELOG.md).

## 27.0.0-rc.1 — 2026-11-16

The first release candidate of 27.0, with the API of 0.0.13; it needs `@afora/core >=27.0.0-rc.1`. See the [root CHANGELOG](../../CHANGELOG.md).

## 0.0.13 — 2026-11-16

### A status chosen at run time (#116)

- A tool call of a use case that returns `withStatus(status, body)` gives the body: the status is HTTP only. The guide names `route.statuses`.

### File fields (#118)

- The guide shows file fields, `"file"` and `{ "file": { "types", "maxBytes" } }`, read from a `multipart/form-data` body.

### Serial ids (#122)

- The guide names `"id": "serial"`, an integer the database assigns on `create`, and the providers that assign ids.

### Security: the project boundary (#69)

- Every tool that validates, writes or generates refuses with `outside_project` what `@afora/codegen` now reports: an `import` or `extends` through a package path with a `.` or `..` segment, a backslash, a percent-encoded character, a built-in module (`child_process`, `fs`, `bun`) or a symlink that leaves the project, and an `output.dir` in `node_modules` or `.git`. An `extends` refused this way is not read. A relative module is also checked as the URL a runtime resolves (a `?` or `#` is refused), the `node_modules`/`.git` check ignores case and follows a symlinked `output.dir`, and a spec extended inside the project is held to the same rules, at any depth (`resolveExtended` with `root`).
- `afora_generate` runs `bunx --no-install tsc`: a project without TypeScript no longer makes it fetch the `tsc` package of the registry and run it.

- A use case whose response is a list (#117) answers its tool call with the JSON array as text, as any other response; the guide says a `response` can be a list field (`"Article[]"`).

- The guide and the tool descriptions cover the top-level `services` of a spec (#115): a use case dependency that names a service, the factory of each as an import, and `services.<name>` among the `imports` of `afora_extract`.

### `params` on a `run` step

- The guide's example declares `"params"` on its `run` step and says to declare it whenever the function relies on what it gets, so the args are checked before it runs.

### Code first, access and the project boundary (#75, #60, #64, #69)

- New tool `afora_project` (read-only): entities, repositories, every operation with how it is implemented and its declared route and access, and each output with the route every operation is served at (and whether the sink, the use case or the default decided it) and who may call it, plus notes on operations left open or that will answer 401. It reads a TypeScript application directly (`--app` or `app`), from `app.describe()`, with no `afora.json` and no `imports`; else the file. `source: "app" | "file"` chooses between them when the project has both. With both, the result has `drift: { between, inSync, differences }`: where the application and `afora.json` say different things (an entity, repository, operation or output in only one of them, other repository actions, an operation implemented, routed or protected differently, another route in an output), so a spec that fell behind the code is seen at once. `compare: false` skips it; what a spec inherits with `extends` is not reported as missing from the file; an application that cannot be read gives `drift.error`, not a failed call. `projectDifferences` is exported. `projectViewOfSpec`, `projectViewOfDescription` and the types `ProjectView` and `RouteView` are exported.
- The guide has "Routes and access", "Steps or code" (what steps are for, that they have no branching, loops or expressions, when a `run` step is enough and when to move to an `import` use case) and "A project written in code".
- The `mcpTools` sink enforces the `access` of use cases: the caller is `extra.principal`, else the `authenticator` hook (`mcpTools(options, hooks)`, type `McpToolsHooks`), else the token of the new `auth` option; without one such a tool answers a 401 problem. A tool description says what it requires, and `annotations` carry `readOnlyHint` and `destructiveHint` from the route of the use case.
- The peer dependency on `@afora/core` is `>=0.0.9`: the sink uses the access of operations and `jwtOf`.
- **Security.** An `{ "import": ... }` or an `extends` that names a file outside the project (a relative path that leaves it, an absolute path, a URL) is rejected with `outside_project` by every tool that validates, writes or generates, and an `extends` outside the project is not read. The trust model is in the README.

### Optimistic concurrency and atomic increment (#44, #34)

- The guide teaches `"versioned": true` on entities (the `version` identity key, `RepositoryConcurrencyConflict`) and the `increment` action.

### Added

- The guide teaches records that expire (`"expires": { "after": { "days": 400 } }` or `{ "at": "until" }` on an entity).
- The guide and the tool descriptions teach the lifecycle events of entities (`"events": { "onCreate": "created" }`).
- The guide and the tool descriptions teach event policies (`"events": { "policy": "publishEvents", "options": {...} }`) and the top-level `publishers`; `afora_catalog` lists the policies under `policies`, and `--policies <module>` adds those of another catalog.

## 0.0.1 — unreleased (draft: dated when it is published)

### Added

- The guide teaches the standard use cases of `afora.json` (`{ "generic", "repository", "options" }`), and `afora_catalog` lists them under `useCases`. It also covers the `restore` action and step.

- The guide and the repository `actions` accept `findCursor`, the query that pages by position.
- `mcpTools` sink (with `McpStages` and `stages`): exposes the operations of an afora output as MCP tools (`{ tools, call, register, server }`), with inline input schemas, masked responses, problem JSON errors with `isError` and a `context` mapping.
- Commands and outputs: `afora_spec_upsert`/`remove`/`write` accept `command` and `output` declarations, `afora_catalog` lists the `stages` a pipe may name, the guide teaches both, and `afora_extract` takes `imports` for `commands.<Name>.events`, `commands.<Name>.onEventError` and `outputs.<Name>.pipe.<index>`. `afora-mcp --stages <module>` (and `createServer({ stages })`) supplies the catalog of external stages, as `--providers` does for providers.
- Exceptions, use cases and steps: `afora_spec_upsert`/`remove`/`write` accept `exception` and `useCase` declarations (invalid ones are issues and nothing is written), `afora_catalog` lists `exceptionLayers` and `coreExceptions`, the guide teaches the steps DSL, and `afora_extract` takes `imports` for hand-written use cases and `run` functions.
- Providers: the guide, `afora_spec_write`/`afora_spec_upsert` (repository `provider`) and `afora_generate` handle `provider` and the actions `findMany`, `exists`, `findPage`; invalid providers are issues and nothing is written. `afora-mcp --providers <module>` (and `createServer({ providers })`) supplies the catalog of external providers, listed by `afora_catalog`; `afora_extract` takes `imports` for a provider created without `providerOf`.
- Repository authoring accepts `deletion: "hard" | "soft"`, validates it through the codegen schema, and generates/extracts soft deletion without losing the setting.

### Changed

- TypeBox (`^1`) is a required peer dependency, shared with `@afora/core` and `@afora/codegen`.

### Added

- First version. `afora-mcp --project <dir> [--app file.ts#App]`, a stdio MCP server with the tools `afora_catalog`, `afora_spec_read`, `afora_extract`, `afora_spec_validate`, `afora_spec_upsert`, `afora_spec_remove`, `afora_spec_write` and `afora_generate`, and the resources `afora://spec/schema`, `afora://catalog` and `afora://spec/guide`.
- Writes confined to the project; only files with the generated banner are overwritten or removed.
- `afora_generate` runs `tsc --noEmit` and returns the diagnostics of the generated files.
