# Changelog

## Unreleased

### Changed

- TypeBox (`^1`) is a required peer dependency, shared with `@afora/core` and the generated application's own schemas.
- Record and entity fields may now be named `blueprint` and `options`, following the core's move of instance metadata to `Meta`. Covered by generation, persistence and extraction round trips; the spec shape is unchanged.

### Added

- Repository `deletion: "hard" | "soft"` in the spec, schema, validation (`invalid_deletion`), generation and extraction. Normalization omits the default `hard`; round trips preserve soft deletion behavior.
- First version. `afora.json` (version 1): `properties` (`base` + `with`, `enum`, `opaque` imports), `blueprints`, `records`, `entities`, `environments`, `repositories`, `extends` and `output.dir`; `useCases` is reserved. Fields in shorthand (`"Age?"`, `"string[]"`) or object form.
- `validateSpec(spec, extended?)`: issues with `path`, `code` and `message` for unknown references, name collisions, cycles, reserved and identity keys, `unique`/`sensitive`/`change`, plugins, repository actions and relations, and `with` options.
- `generate(spec, extended?)`: deterministic, Biome-clean files (`properties`, `blueprints`, `records`, `entities`, `environments`, `repositories`, `application`, `index`) using only the public API of `@afora/core`.
- `extractSpec(app)` and `normalizeSpec`: the inverse of `generate`, from `app.describe()`.
- `catalog()`, read from `@afora/core` at runtime; `specSchema` and `afora.schema.json`.
- `loadSpec`, `resolveExtended`, `writeGenerated` and `confinePath` (writes confined to the project, only files with the generated banner are overwritten or removed).
- `afora-codegen check | generate | extract`.
