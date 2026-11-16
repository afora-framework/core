# Changelog

## 27.0.0-rc.3 — 2026-11-16

A candidate of 27.0.0, with no changes since 27.0.0-rc.2. See the [root CHANGELOG](../../CHANGELOG.md).

## 27.0.0-rc.2 — 2026-11-16

A candidate of 27.0.0, with no changes since 27.0.0-rc.1. See the [root CHANGELOG](../../CHANGELOG.md).

## 27.0.0-rc.1 — 2026-11-16

The first release candidate of 27.0, with the API of 0.0.13; it needs `@afora/core >=27.0.0-rc.1`. See the [root CHANGELOG](../../CHANGELOG.md).

## 0.0.13 — 2026-11-16

### A status chosen at run time (#116)

- A call of a use case that returns `withStatus(status, body)` replies with the body as its `value`: the status is HTTP only.

### Added

- The sink enforces the `access` of use cases (#60): the caller is the `principal` a session was opened with (`endpoint.session(socket, { principal })`, also in the `extra` of `handle`), else what the `authenticator` hook gives (`websocket(options, { authenticator })`, type `WebSocketHooks`, whose `request.header(name)` reads the values of the session). Without one, an operation with an access answers a 401 problem.

### Added

- First version. `websocket(options)`, a sink for `outputOf` that serves the operations over a JSON message protocol (`{ id?, op, input? }` → `{ id, value }` or `{ id, problem }`), with the context from the values of a session, masked responses and problem errors with the status of `statusOf`. `endpoint.session(socket, { values, hub, authorize })` adds topic subscriptions (`{ subscribe }`, `{ unsubscribe }`) limited by `subscriptions.topics` and `authorize`; `wsHub()` is an in-memory hub that is also an `IEventPublisher`, so `publishEvents` pushes domain events to the subscribers of a topic. Runtime-agnostic: adapters for `Bun.serve`, Hono's `upgradeWebSocket` and Workers are a few lines (see the README).
- `WsStages` (`stageCatalogOf(websocket)`) and `stages`, the catalog entries codegen reads (`--stages @afora/ws`).
