# Changelog

## Unreleased

### Changed

- TypeBox (`^1`) is a required peer dependency, shared with `@afora/core` and the generated application's own schemas.
- Record and entity fields may now be named `blueprint` and `options`, following the core's move of instance metadata to `Meta`. Covered by generation, persistence and extraction round trips; the spec shape is unchanged.

### Added

- `exceptions` and `useCases` in the spec (the v1 rejection of `useCases` is gone): exceptions `{ layer, message? }`, use cases with metadata, `input`/`response`/`context` (blueprint name or inline `fields`), `dependencies`, `errors` (declared or core exceptions, listed by `catalog().exceptionLayers` / `coreExceptions`) and an `implementation` that is `{ steps }` (the T15 DSL, validated with the core's codes plus `unknown_exception`, `unknown_blueprint`, `invalid_import`, `import_dependency`) or `{ import }` (generated `<Name>Base` that the hand-written class extends). Generated as `exceptions.ts` and `use-cases.ts` and registered in `application.ts`; extracted from `describe()` (`imports` keys `useCases.<Name>` and `useCases.<Name>.run.<name>`, else `ExtractionError`); normalized (default `tags`, `deprecated` and message dropped). An exception whose message is a function is extracted without `message`.
- `provider` in the spec, at the application and per repository: `"inMemory"`, `{ "use", "options" }` or `{ "import": "./file.ts#name" }`, with `{ "import" }` references nested in the options. Validated (`unknown_provider`, `invalid_provider`, `invalid_import`, `invalid_provider_catalog`), normalized (`"inMemory"` is `{ use: "inMemory", options: {} }`; an omitted provider is never a shared one), generated (`provider:` in `applicationOf` / `repositoryOf`, named imports) and extracted from `describe()`. External providers are a codegen option, `{ providers: [{ name, module, export }] }`, accepted by `validateSpec(spec, extended, options)` and `generate(spec, extended, options)`; the CLI takes `--providers <module>`. An opaque provider needs `imports` (`provider`, `repositories.<Name>.provider`; CLI `--import key=./file.ts#name`) or extraction throws `ExtractionError`.
- Repository actions `findMany`, `exists` and `findPage` in the spec, schema, validation, generation and extraction.
- Repository `deletion: "hard" | "soft"` in the spec, schema, validation (`invalid_deletion`), generation and extraction. Normalization omits the default `hard`; round trips preserve soft deletion behavior.
- First version. `afora.json` (version 1): `properties` (`base` + `with`, `enum`, `opaque` imports), `blueprints`, `records`, `entities`, `environments`, `repositories`, `extends` and `output.dir`; `useCases` is reserved. Fields in shorthand (`"Age?"`, `"string[]"`) or object form.
- `validateSpec(spec, extended?)`: issues with `path`, `code` and `message` for unknown references, name collisions, cycles, reserved and identity keys, `unique`/`sensitive`/`change`, plugins, repository actions and relations, and `with` options.
- `generate(spec, extended?)`: deterministic, Biome-clean files (`properties`, `blueprints`, `records`, `entities`, `environments`, `repositories`, `application`, `index`) using only the public API of `@afora/core`.
- `extractSpec(app)` and `normalizeSpec`: the inverse of `generate`, from `app.describe()`.
- `catalog()`, read from `@afora/core` at runtime; `specSchema` and `afora.schema.json`.
- `loadSpec`, `resolveExtended`, `writeGenerated` and `confinePath` (writes confined to the project, only files with the generated banner are overwritten or removed).
- `afora-codegen check | generate | extract`.
