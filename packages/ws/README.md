# @afora/ws

A WebSocket sink for [`@afora/core`](../../README.md) outputs. It serves the operations of an output over JSON messages, with the same validation, masked responses and RFC 9457 problems as the HTTP sink, and lets a connection subscribe to topics that [`publishEvents`](../../docs/commands.md#event-policies) fills with domain events. It depends on no runtime: the sink builds an endpoint, and a few lines of Bun, Hono or Workers feed it the messages of a socket.

```bash
bun add @afora/core @afora/ws typebox
# or: npm install @afora/core @afora/ws typebox
```

`@afora/core` and TypeBox (`^1`) are peer dependencies. The package uses only web APIs, so it runs on Bun, Node >= 22 and Workers.

## Example

<!-- docs:code file: realtime.ts -->
```ts
// realtime.ts
import { wsHub } from "@afora/ws";
export const hub = wsHub();
```

<!-- docs:code file: app.ts -->
<!-- docs:code context
// your use cases
import { blueprintOf, useCaseOf } from "@afora/core";

const Title = blueprintOf((ctx) => ({ title: ctx.string }));
class CreatePost extends useCaseOf({ name: "CreatePost", blueprint: Title, response: Title }) {
	override async execute() {
		return this.input;
	}
}
class ListPosts extends useCaseOf({ name: "ListPosts", blueprint: blueprintOf(() => ({})), response: blueprintOf(() => ({})) }) {
	override async execute() {
		return {};
	}
}
-->
```ts
// app.ts
import { applicationOf, commandOf, outputOf, publishEvents } from "@afora/core";
import { websocket } from "@afora/ws";
import { hub } from "./realtime";

const Posts = commandOf({
	name: "Posts",
	useCases: { create: CreatePost, list: ListPosts },
	events: publishEvents({ publisher: "realtime", topic: "posts" }),
});

const Live = outputOf({
	name: "Live",
	commands: [Posts],
	pipe: [
		websocket({
			context: { userId: "x-user" },
			subscriptions: { topics: ["posts", "posts/*"] },
		}),
	],
});

export const App = applicationOf({
	name: "Blog",
	commands: { Posts },
	outputs: { Live },
	publishers: { realtime: hub },
	// ...entities, repositories, use cases
});
```

```text
→ { "id": 1, "subscribe": "posts" }
← { "id": 1, "subscribed": "posts" }

→ { "id": 2, "op": "Posts.create", "input": { "title": "Hello" } }
← { "id": 2, "value": { "post": { "id": "...", "title": "Hello", ... } } }
← { "topic": "posts", "event": { "name": "postCreated", "command": "Posts", "operation": "create", "entity": { ... } } }

→ { "id": 3, "op": "Posts.create", "input": {} }
← { "id": 3, "problem": { "type": "urn:afora:exception:InvalidUseCaseInput", "status": 400, "issues": [...], ... } }
```

The push goes to every socket subscribed to the topic, including the one that made the call, after the call succeeded and committed.

## Adapters

Build the endpoint once (`App.outputs.Live.build()`), then give each socket a session. The session reads each message and sends the reply through `socket.send`; `close()` leaves its topics.

**Bun**

<!-- docs:code context
import type { WsSession } from "@afora/ws";
import { App } from "./app";
import { hub } from "./realtime";
-->
```ts
const endpoint = App.outputs.Live.build();

Bun.serve<{ values: Record<string, string | undefined>; session?: WsSession }>({
	fetch(request, server) {
		const values = { "x-user": request.headers.get("x-user") ?? undefined };
		if (server.upgrade(request, { data: { values } })) return undefined;
		return new Response("Upgrade required", { status: 426 });
	},
	websocket: {
		open(ws) {
			ws.data.session = endpoint.session(ws, { hub, values: ws.data.values });
		},
		message(ws, message) {
			void ws.data.session?.message(message);
		},
		close(ws) {
			ws.data.session?.close();
		},
	},
});
```

**Hono** (`upgradeWebSocket` from `hono/bun` or `hono/cloudflare-workers`; on Node, `@hono/node-ws`)

<!-- docs:code context
import type { WsSession } from "@afora/ws";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { App } from "./app";
import { hub } from "./realtime";

const app = new Hono(); // your Hono app
const endpoint = App.outputs.Live.build();
-->
```ts
app.get(
	"/ws",
	upgradeWebSocket((c) => {
		let session: WsSession;
		return {
			onOpen: (_event, ws) => {
				session = endpoint.session(ws, {
					hub,
					values: { "x-user": c.req.header("x-user") },
				});
			},
			onMessage: (event) => session.message(event.data as string),
			onClose: () => session.close(),
		};
	}),
);
```

**Workers**

<!-- docs:code isolated -->
<!-- docs:code context
import { App } from "./app";
import { hub } from "./realtime";

// the Workers types this block uses (from @cloudflare/workers-types in a Workers project)
declare global {
	const WebSocketPair: new () => { 0: WebSocket; 1: WebSocket & { accept(): void } };
	interface ResponseInit {
		webSocket?: WebSocket;
	}
}
const endpoint = App.outputs.Live.build();

export default {
	async fetch(request: Request): Promise<Response> {
		const values = { "x-user": request.headers.get("x-user") ?? undefined };
/* block */
	},
};
-->
```ts
const { 0: client, 1: server } = new WebSocketPair();
server.accept();
const session = endpoint.session(server, { hub, values });
server.addEventListener("message", (event) => session.message(event.data));
server.addEventListener("close", () => session.close());
return new Response(null, { status: 101, webSocket: client });
```

`wsHub()` keeps its subscribers in memory, so it reaches the sockets of one process or isolate. To reach every instance, implement `WsHub` (`subscribe`, `unsubscribe`, `size`, `publish`) over a broker: Bun's `ws.subscribe` and `server.publish`, Redis, or a Durable Object that holds the sockets.

## Options

All options are JSON, so the stage can live in an `afora.json` (`{ "sink": "websocket", "options": { ... } }`).

| Option            | Meaning                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `include`         | Operation ids to serve (`"Posts.create"`); every operation when omitted. An id that is not an operation throws `InvalidOutputStage` on build.         |
| `context`         | `{ [contextKey]: valueName }`: the context of an operation from the `values` of the session (headers of the upgrade, a token).                        |
| `subscriptions`   | `{ topics: ["posts", "posts/*"] }`: the topics a session may subscribe to; `*` is one segment between `/`. Without it, every subscription is refused. |
| `maxMessageBytes` | The largest message read, in bytes. 1 MiB by default.                                                                                                 |
| `debug`           | `true` adds the `trace` to problems and the real `detail` to 5xx ones. Off by default.                                                                |

Invalid options throw `InvalidOutputStage` when the stage is made.

## Protocol

| Client sends                    | Server answers                                                              |
| ------------------------------- | --------------------------------------------------------------------------- |
| `{ id?, op, input? }`           | `{ id, value }` or `{ id, problem }`                                        |
| `{ id?, subscribe: topic }`     | `{ id, subscribed: topic }` or `{ id, problem }`                            |
| `{ id?, unsubscribe: topic }`   | `{ id, unsubscribed: topic }`                                               |
| (an event published to a topic) | `{ topic, event: { name, command, operation, entity } }` to its subscribers |

- **Calls.** `op` is an operation id. The input is validated by the operation (a 400 problem with `issues`), the response goes through `outputValueOf` (sensitive values masked), and an error is `problemOf` with the status of `statusOf` and the output `statuses`; a 5xx says `"Internal error."` unless `debug` is on or the output declares the exception. An unknown `op` is a 404 `NotFound` problem.
- **`id`** is a non-empty string or a number, echoed in the reply; `null` when the request had none.
- **Invalid messages.** Text that is not UTF-8 or JSON, a frame that is not an object, an unknown key, not exactly one of `op`, `subscribe` and `unsubscribe`, `input` without `op`, a `subscribe` or `unsubscribe` topic over 512 bytes (UTF-8), or a message over `maxMessageBytes`: a 400 problem `InvalidWsMessage`, whose `detail` says why.
- **Subscriptions.** A topic must match `subscriptions.topics`, then `authorize(topic, values)` of the session, if given (ownership, roles): otherwise a 403 `WsTopicForbidden`. A session holds at most 1000 topics, since a pattern such as `posts/*` matches endless ones: past that, a new topic is a 403 `WsTopicForbidden` too, until the session unsubscribes from one. Subscribing again to a topic it holds answers `subscribed` and does not count twice. A topic is at most 512 bytes (UTF-8): a longer one is a 400 `InvalidWsMessage`, before `subscriptions.topics` and `authorize` are asked, so a session holds at most 1000 × 512 bytes of topics. Publishing is done by the server (`publishEvents`, `hub.publish`), never by a client; an event published to a longer topic reaches no one. A session without a hub, or `handle`, answers a 501 `WsSubscriptionsUnavailable`. The output `statuses` can change these three statuses.
- **Never throws.** `session.message` catches everything and answers a problem; a socket whose `send` throws is dropped by the hub.

`endpoint.handle(message, { values })` answers one message with no connection (calls only), for tests or a transport that is not a socket. `endpoint.operations` lists the operations served with their input JSON Schema.

## Security

- Authenticate on the upgrade, then pass what you trust as `values`; the client never chooses its context.
- Topics are private by default. Published entities are masked by `toJSON`, but the other fields reach every subscriber of a topic: scope topics (`posts/{id}`, `users/{userId}`) and check them in `authorize`.

## Catalog

`WsStages` is `stageCatalogOf(websocket)` (from `@afora/core/adapters`), and `stages` are the entries codegen reads to resolve `{ "sink": "websocket" }` in an `afora.json`. The CLIs read `--stages` as a file, so re-export them from a module of the project (`export { stages } from "@afora/ws";` in `stages.ts`) and pass `--stages ./stages.ts`:

```ts
import { stages } from "@afora/ws";
// [{ name: "websocket", module: "@afora/ws", export: "websocket", kind: "sink" }]
```
