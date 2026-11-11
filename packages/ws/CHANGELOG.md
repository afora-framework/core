# Changelog

## Unreleased

### Added

- The sink enforces the `access` of use cases (#60): the caller is the `principal` a session was opened with (`endpoint.session(socket, { principal })`, also in the `extra` of `handle`), else what the `authenticator` hook gives (`websocket(options, { authenticator })`, type `WebSocketHooks`, whose `request.header(name)` reads the values of the session). Without one, an operation with an access answers a 401 problem.

### Added

- First version. `websocket(options)`, a sink for `outputOf` that serves the operations over a JSON message protocol (`{ id?, op, input? }` → `{ id, value }` or `{ id, problem }`), with the context from the values of a session, masked responses and problem errors with the status of `statusOf`. `endpoint.session(socket, { values, hub, authorize })` adds topic subscriptions (`{ subscribe }`, `{ unsubscribe }`) limited by `subscriptions.topics` and `authorize`; `wsHub()` is an in-memory hub that is also an `IEventPublisher`, so `publishEvents` pushes domain events to the subscribers of a topic. Runtime-agnostic: adapters for `Bun.serve`, Hono's `upgradeWebSocket` and Workers are a few lines (see the README).
- `WsStages` (`stageCatalogOf(websocket)`) and `stages`, the catalog entries codegen reads (`--stages @afora/ws`).
