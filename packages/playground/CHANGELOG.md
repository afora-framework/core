# Changelog

## Unreleased

### Added

- First version as its own package. The local TypeScript playground and the `afora playground` CLI, moved out of `@afora/core`: project-aware completion, hover types and diagnostics, Bun execution, examples and experiments saved as `.afora/sandbox/**/*.sandbox.ts`. `--source` uses the `src/` of the afora repository, for developing afora itself. `@afora/core` is a peer dependency.
