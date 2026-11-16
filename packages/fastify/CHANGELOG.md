# Changelog

## 27.0.0-rc.1 — 2026-11-16

The first release candidate of 27.0, with the API of 0.0.13; it needs `@afora/core >=27.0.0-rc.1`. See the [root CHANGELOG](../../CHANGELOG.md).

## 0.0.13 — 2026-11-16

### Added

- File uploads (#118): a `multipart/form-data` parser keeps the bytes, read with the platform `Request.formData()` for an input that holds a file (`ctx.fileOf`); no new dependency.
- A `multipart/form-data` body sent to a route without a file is read as text (a 400 `InvalidRequestBody`), not an empty input.
- The package (#75): `fastify(options, hooks)`, a sink that serves the operations of an output on Fastify, on the route table of `@afora/core/adapters` (`compileRoutes`). It takes the options of every afora sink that serves HTTP (`basePath`, `route`, `responses`, `requestId`, `security`, `docs`, `debug`, `context`, `auth`) and the hooks `authenticator`, `middlewares` and `app`. Exports `fastify`, `FastifyStages`, `stages` and the types `FastifyOptions` and `FastifyHooks`. It passes `httpProviderContract` of `@afora/core/testing`.
