# Changelog

## Unreleased

### Added

- File uploads (#118): an input that holds a file (`ctx.fileOf`) is read from a `multipart/form-data` body, from the stream (or the bytes of `express.raw()`) with the platform `Request.formData()`.
- The package (#75): `express(options, hooks)`, a sink that serves the operations of an output on Express, on the route table of `@afora/core/adapters` (`compileRoutes`). It takes the options of every afora sink that serves HTTP (`basePath`, `route`, `responses`, `requestId`, `security`, `docs`, `debug`, `context`, `auth`) and the hooks `authenticator`, `middlewares` and `app`. Exports `express`, `ExpressStages`, `stages` and the types `ExpressOptions` and `ExpressHooks`. It passes `httpProviderContract` of `@afora/core/testing`.
