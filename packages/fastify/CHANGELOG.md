# Changelog

## Unreleased

### Added

- The package (#75): `fastify(options, hooks)`, a sink that serves the operations of an output on Fastify, on the route table of `@afora/core/adapters` (`compileRoutes`). It takes the options of every afora sink that serves HTTP (`basePath`, `route`, `responses`, `requestId`, `security`, `docs`, `debug`, `context`, `auth`) and the hooks `authenticator`, `middlewares` and `app`. Exports `fastify`, `FastifyStages`, `stages` and the types `FastifyOptions` and `FastifyHooks`. It passes `httpProviderContract` of `@afora/core/testing`.
