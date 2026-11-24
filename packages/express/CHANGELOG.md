# Changelog

## 27.0.0-rc.6 — 2026-11-24

A candidate of 27.0.0, with no changes since 27.0.0-rc.5. See the [root CHANGELOG](../../CHANGELOG.md).

## 27.0.0-rc.5 — 2026-11-24

A candidate of 27.0.0, with no changes since 27.0.0-rc.4. See the [root CHANGELOG](../../CHANGELOG.md).

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

- File uploads (#118): an input that holds a file (`ctx.fileOf`) is read from a `multipart/form-data` body, from the stream (or the bytes of `express.raw()`) with the platform `Request.formData()`.
- A multipart body another parser of the app read first (multer, `express.text()`) is a 500 `MultipartBodyAlreadyRead` (exported), not an empty input.
- The package (#75): `express(options, hooks)`, a sink that serves the operations of an output on Express, on the route table of `@afora/core/adapters` (`compileRoutes`). It takes the options of every afora sink that serves HTTP (`basePath`, `route`, `responses`, `requestId`, `security`, `docs`, `debug`, `context`, `auth`) and the hooks `authenticator`, `middlewares` and `app`. Exports `express`, `ExpressStages`, `stages` and the types `ExpressOptions` and `ExpressHooks`. It passes `httpProviderContract` of `@afora/core/testing`.
