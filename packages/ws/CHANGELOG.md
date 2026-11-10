# Changelog

## Unreleased

### Added

- First version. `websocket(options)`, a sink for `outputOf` that serves the operations over a JSON message protocol (`{ id?, op, input? }` → `{ id, value }` or `{ id, problem }`), with the context from the values of a session, masked responses and problem errors with the status of `statusOf`. `endpoint.session(socket, { values, hub, authorize })` adds topic subscriptions (`{ subscribe }`, `{ unsubscribe }`) limited by `subscriptions.topics` and `authorize`; `wsHub()` is an in-memory hub that is also an `IEventPublisher`, so `publishEvents` pushes domain events to the subscribers of a topic. Runtime-agnostic: adapters for `Bun.serve`, Hono's `upgradeWebSocket` and Workers are a few lines (see the README).
- `WsStages` (`stageCatalogOf(websocket)`) and `stages`, the catalog entries codegen reads (`--stages @afora/ws`).
