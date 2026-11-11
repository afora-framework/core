# Changelog

## Unreleased

### Added

- The package (#75): `elysia(options, hooks)`, a sink that serves the operations of an output on Elysia, on the route table of `@afora/core/adapters` (`compileRoutes`). It takes the options of every afora sink that serves HTTP (`basePath`, `route`, `responses`, `requestId`, `security`, `docs`, `debug`, `context`, `auth`) and the hooks `authenticator`, `middlewares` and `app`. Exports `elysia`, `ElysiaStages`, `stages` and the types `ElysiaOptions` and `ElysiaHooks`. It passes `httpProviderContract` of `@afora/core/testing`.
