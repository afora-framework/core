# Real time with WebSockets

This guide serves a small task board over a WebSocket: clients call the same operations an HTTP API would, and every client subscribed to a topic receives the change once it is committed. It uses [`@afora/ws`](../packages/ws/README.md), which depends on no runtime, so the same endpoint runs on Bun, Node and Workers; only the few lines that accept a socket change.

```bash
bun add @afora/core @afora/ws typebox
# or: npm install @afora/core @afora/ws typebox
```

## 1. The domain and its events

An entity declares the events it queues ([Entities](entities.md)), and a command publishes the events of its calls with the `publishEvents` policy ([Commands](commands.md#event-policies)). Here every created or updated task goes to the topic `tasks`:

```ts
import {
	applicationOf,
	blueprintOf,
	commandOf,
	entityOf,
	type EventDefinition,
	eventOf,
	inMemoryProvider,
	outputOf,
	publishEvents,
	repositoryOf,
} from "@afora/core";
import { websocket, wsHub } from "@afora/ws";

class Task extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text, done: ctx.boolean })),
	{
		name: "Task",
		change: ["done"],
		onCreate: () => TaskCreated,
		onUpdate: () => TaskUpdated,
	},
) {}

// No handler: each event only carries the task, for the policy to publish
const TaskCreated: EventDefinition = eventOf("task.created", Task);
const TaskUpdated: EventDefinition = eventOf("task.updated", Task);

const TaskStore = repositoryOf({
	entity: Task,
	actions: ["create", "findById", "findPage", "update"],
});

const hub = wsHub(); // the subscribers of this process

const Tasks = commandOf({
	name: "Tasks",
	useCases: (ctx) => ({
		create: ctx.create(TaskStore, { as: "task" }),
		list: ctx.list(TaskStore),
		update: ctx.update(TaskStore, { as: "task" }),
	}),
	events: publishEvents({ publisher: "realtime", topic: "tasks" }),
});
```

`topic` may also name `{id}`, `{event}`, `{command}` or `{operation}`: `"tasks/{id}"` gives each task a topic of its own, which the sink below allows as `tasks/*`. `publishEvents` publishes after the call succeeded and, in a command with a transaction, after it committed: a client never sees a change that was rolled back. The entity goes out through its `toJSON`, so a sensitive value is masked in a push as it is in a response.

## 2. The sink

The `websocket` sink turns the operations of an output into messages. `subscriptions.topics` lists the topics a client may ask for; without it, every subscription is refused.

<!-- docs:code continue -->
```ts
const Live = outputOf({
	name: "Live",
	commands: [Tasks],
	pipe: [websocket({ subscriptions: { topics: ["tasks", "tasks/*"] } })],
});

export const App = applicationOf({
	name: "board",
	entities: { Task },
	repositories: { TaskStore },
	commands: { Tasks },
	outputs: { Live },
	publishers: { realtime: hub },
	provider: inMemoryProvider(),
});
```

The options are JSON, so the same output can be written in an [`afora.json`](afora-json.md) (`{ "sink": "websocket", "options": { ... } }`, with `--stages @afora/ws`).

## 3. Accepting sockets

Build the endpoint once, then give each socket a session. The session reads each message, runs the operation and sends the reply; `close()` leaves its topics. On Bun:

<!-- docs:code continue -->
```ts
import type { WsSession, WsValues } from "@afora/ws";

const endpoint = App.outputs.Live.build();

Bun.serve<{ values: WsValues; session?: WsSession }>({
	port: 3000,
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

On Node, serve it through Hono with `@hono/node-ws`, and on Workers with a `WebSocketPair`: the [package README](../packages/ws/README.md#adapters) has both. The session is the same in each.

## 4. The conversation

A client subscribes, then calls an operation by its id (`<command>.<operation>`). The reply carries the `id` of the request; the push carries the topic and goes to every subscriber, the caller included, so match replies by `id` rather than by order:

```text
→ { "id": 1, "subscribe": "tasks" }
← { "id": 1, "subscribed": "tasks" }

→ { "id": 2, "op": "Tasks.create", "input": { "title": "Write the guide", "done": false } }
← { "topic": "tasks", "event": { "name": "task.created", "command": "Tasks", "operation": "create", "entity": { ... } } }
← { "id": 2, "value": { "task": { "id": "...", "title": "Write the guide", "done": false, ... } } }

→ { "id": 3, "op": "Tasks.create", "input": {} }
← { "id": 3, "problem": { "type": "urn:afora:exception:InvalidUseCaseInput", "status": 400, "issues": [...], ... } }
```

Input is validated as on HTTP, an error is the same `application/problem+json` body under `problem`, and the status of each exception comes from the output's `statuses`, as for any sink ([Outputs](outputs.md)). A use case whose response is a list sends the array as it is, and a status chosen with [`withStatus`](use-cases.md#a-status-chosen-at-run-time) stays with the HTTP sinks: a WebSocket reply carries the body.

## 5. Who is calling, and what they may follow

The socket is authenticated once, on the upgrade, and the session carries the result. Two ways:

- **Values.** Pass what you trust in `values` (a header of the upgrade, the subject of a verified token), and fill the context of the operations from them with the `context` option: `websocket({ context: { userId: "x-user" } })`. The client never chooses its context.
- **A principal.** `endpoint.session(ws, { hub, principal })` with the `Principal` your upgrade authenticated: every operation that declares an [`access`](auth.md) is checked against it, as on HTTP. Without one, those operations answer 401.

Topics are private by default, and a topic pattern is not a permission on its own: an entity pushed to `tasks/*` reaches every subscriber of it. Check the topic against the caller with `authorize`:

<!-- docs:code skip: fragment of the open handler above; canFollow stands for your own check -->
```ts
endpoint.session(ws, {
	hub,
	values: ws.data.values,
	authorize: (topic, values) => canFollow(values["x-user"], topic), // false is a 403
});
```

## 6. More than one process

`wsHub()` keeps its subscribers in memory, so it reaches the sockets of one process or isolate. To reach every instance behind a load balancer, implement `WsHub` (`subscribe`, `unsubscribe`, `size`, `publish`) over a broker: Bun's `server.publish`, Redis, or a Durable Object that holds the sockets. The command and the sink do not change.

## 7. Testing it

`endpoint.handle(message, { values })` answers one message with no connection, so a test calls operations without a socket. Subscriptions need a session: give `endpoint.session` an object with a `send` method and read what it received.

<!-- docs:code continue -->
```ts
const reply = await endpoint.handle({
	id: 1,
	op: "Tasks.create",
	input: { title: "Write the guide", done: false },
});
// { id: 1, value: { task: { ... } } }

const received: string[] = [];
const session = endpoint.session(
	{ send: (text) => received.push(text) },
	{ hub },
);
await session.message(JSON.stringify({ id: 1, subscribe: "tasks" }));
```

For the rest of an application's tests (spying on the database, overriding a dependency), see [Testing an application](testing.md).
