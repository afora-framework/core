# Changelog

## Unreleased

### Changed

- TypeBox (`^1`) is a required peer dependency, shared with `@afora/core` and `@afora/codegen`.

### Added

- First version. `afora-mcp --project <dir> [--app file.ts#App]`, a stdio MCP server with the tools `afora_catalog`, `afora_spec_read`, `afora_extract`, `afora_spec_validate`, `afora_spec_upsert`, `afora_spec_remove`, `afora_spec_write` and `afora_generate`, and the resources `afora://spec/schema`, `afora://catalog` and `afora://spec/guide`.
- Writes confined to the project; only files with the generated banner are overwritten or removed.
- `afora_generate` runs `tsc --noEmit` and returns the diagnostics of the generated files.
