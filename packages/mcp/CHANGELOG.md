# Changelog

## Unreleased

### Optimistic concurrency and atomic increment (#44, #34)

- The guide teaches `"versioned": true` on entities (the `version` identity key, `RepositoryConcurrencyConflict`) and the `increment` action.

### Added

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
