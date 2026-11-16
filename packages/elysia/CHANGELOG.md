# Changelog

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

- File uploads (#118): a `multipart/form-data` body is read as `FormData` (other bodies stay text) for an input that holds a file (`ctx.fileOf`).
- A `multipart/form-data` body is left unread until the route asks, so a malformed one is a 400 `InvalidRequestBody`, and one sent to a route without a file is read as text (a 400).
- The package (#75): `elysia(options, hooks)`, a sink that serves the operations of an output on Elysia, on the route table of `@afora/core/adapters` (`compileRoutes`). It takes the options of every afora sink that serves HTTP (`basePath`, `route`, `responses`, `requestId`, `security`, `docs`, `debug`, `context`, `auth`) and the hooks `authenticator`, `middlewares` and `app`. Exports `elysia`, `ElysiaStages`, `stages` and the types `ElysiaOptions` and `ElysiaHooks`. It passes `httpProviderContract` of `@afora/core/testing`.
