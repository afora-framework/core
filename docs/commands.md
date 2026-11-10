# Commands

`commandOf` groups use cases under operation names and is the **execution boundary** of a call: the context is validated once, a transaction can wrap the use case, the events it raised are handled by a policy, and the trace gets a `command` frame.

```ts
import { blueprintOf, commandOf } from "@afora/core";

const Users = commandOf({
	name: "Users",
	description: "Accounts.", // optional
	tags: ["accounts"], // optional, default []
	context: blueprintOf((ctx) => ({ userId: ctx.id, requestId: ctx.string })), // optional
	useCases: { register: Register, login: Login },
	transaction: true, // optional, default false
	environmentDependencies: [Mail, Queue], // optional: one environment or a list, merged in order
	events: "after-commit", // "after-commit" (default) | "manual" | a policy (publishEvents(...)) | handler
	onEventError: (error, event, info) => {}, // optional, "after-commit" only
});

const { user } = await Users.run("register", input, { context });
const { value, events } = await Users.execute("register", input, { context }); // no event policy
```

The keys of `useCases` are the operation names: identifiers holding concrete use case classes. `commandOf` validates its settings and throws `InvalidCommandDeclaration` (`Command` layer, `details.reason`) for anything else. The command is frozen and exposes `commandName`, `description`, `tags`, `context`, `useCases`, `transaction`, `environments`, `env`, `events`, `onEventError` and `operations`; `isCommand` identifies one.

`useCases` may also be a function of the [standard use cases](std-use-cases.md), each made for a repository: `useCases: (ctx) => ({ create: ctx.create(Posts), login: Login })`. `commandOf` is `commandBuilderOf(StdUseCases)`:

`commandBuilderOf(...catalogs)` gives a `commandOf` whose `useCases` may also be a function of the use case plugins of the catalogs (see [Use cases](use-cases.md#plugins)), each called with a repository; classes written by hand go beside them. The function runs once, at declaration, and a plugin that cannot make its use case throws `UseCaseUnavailable` there. A later catalog wins a name; anything that is not a catalog throws `InvalidCommandDeclaration`.

```ts
const commandOf = commandBuilderOf(useCaseCatalogOf(get, publish));

const Blog = commandOf({
	name: "Blog",
	useCases: (ctx) => ({
		post: ctx.get(Posts),
		publish: ctx.publish(Posts), // a type error if Post is not publishable
		custom: MyUseCase,
	}),
});
```

In an application, register commands under `commands: { Users }` (keyed by `commandName`, else `InvalidApplicationDeclaration`); every use case of every command must be in `useCases` (`UnregisteredApplicationReference`, `details: { command, useCase }`), except those a use case plugin made, which the command registers itself under their `useCaseName`. With a `provider`, `app.commands.Users` (or `app.command(Users)`) is the same command rebuilt over the bound use cases, memoized, with the same settings; the transaction check runs again against the bound providers and throws `InvalidCommandDeclaration` at `applicationOf`. Every environment of a command must be in `environments` (`UnregisteredApplicationReference`, `details: { command }`), and the rebuilt command keeps them. `app.describe().commands` gives each command's operations (`{ ref }` of the use case), `transaction`, `environments` (by name, only when it declares any), `events` (a policy made by `eventPolicyOf` appears as `{ kind: "policy", name, options }`, any other handler as `{ kind: "opaque" }`) and `onEventError` (only when set).

`run(op, input, options)` does this:

1. An unknown operation throws `UnknownCommandOperation` (`details.operation`).
2. With a command `context`, `options.context` is validated by that blueprint (`InvalidCommandContext`, `details.issues`) and each use case gets it narrowed to its own context keys; a use case without a context gets none. Without a command `context`, `options.context` goes to the use case as is, typed and validated by it.
3. A fresh use case is built and executed. Input errors stay use case errors.
4. With `transaction: true`, `execute()` runs inside the `transaction` of the provider of the repositories, which therefore see the transaction (relations and child use cases included). A rejection rolls back and propagates. Every repository reachable from the use cases (through child use cases and relations) must share one provider, and it must support `transaction`; otherwise `InvalidCommandDeclaration` lists the repositories. At declaration `commandOf` checks the providers the repositories declared; repositories without one are bound by an application later, so all of them are checked when an application binds the command, or on the first call of a command used alone. A command with no repository ignores the flag.
5. The events are drained **after** the transaction resolves, so a call that rolled back handles none.
6. The event policy applies, in `run` only:
   - `"after-commit"`: awaits `event.handle()` in emission order. On the first failure, `onEventError(error, event, info)` is awaited (`info` as a handler gets it, below) and the next event runs; without it, `run` throws `CommandEventFailed` (`cause`, `details: { operation, event, handled, remaining }`). The commit already happened, so the data is saved even when this error is thrown.
   - `"manual"`: `run` drops the events; use `execute` to get them.
   - a function: awaited with `(events, { command, operation, context, env, logger, publisher })`; a rejection is a `CommandEventFailed`, and a `CommandEventFailed` the function throws itself (saying which event failed) is passed up as it is. `logger` is the one of the application that bound the command (see [Logging](logging.md)), and an event handled by `"after-commit"` gets it too. `publisher(name)` gives a publisher of the application (see [Event policies](#event-policies)).
7. The validated response is returned.

`execute` performs steps 1 to 5 and returns `{ value, events }` without applying the policy, for outboxes and tests. The whole call runs under a `Command` guard, so errors gain the frame `command @ Users.register`. Concurrent calls are independent; each builds its own use case.

## Event policies

An event policy is a handler made by a factory of `eventPolicyOf`, with JSON options. A command runs it like any handler, and an application describes it by name and options, so it can be written in an `afora.json` (`"events": { "policy": "publishEvents", "options": {...} }`).

**`publishEvents`** publishes the events of a call to a publisher of the application, once the call succeeded and committed: to a WebSocket hub, a queue, a broker.

```ts
import { applicationOf, commandOf, publishEvents } from "@afora/core";

const Posts = commandOf({
	name: "Posts",
	useCases: { create: CreatePost },
	events: publishEvents({ publisher: "realtime", topic: "posts/{id}" }),
});

const App = applicationOf({
	name: "Blog",
	commands: { Posts },
	// ...the rest of the declarations
	publishers: { realtime: hub }, // any { publish(topic, event) }
});
```

For each event, in emission order, it runs the event's own handler (as `"after-commit"` does), then publishes `{ name, command, operation, entity }` to the topic. `entity` is the entity as JSON, through its `toJSON`, so sensitive values are masked; the context and the variables are never published.

| Option           | Meaning                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `publisher`      | The key of the publisher in `applicationOf({ publishers })`.                                              |
| `topic`          | The topic of each event; `{event}`, `{command}`, `{operation}` and `{id}` (the entity's id) are replaced. |
| `events`         | The names of the events to publish; all of them by default. Their handlers run either way.                |
| `handle`         | `false` skips the events' own handlers, so the policy only publishes. `true` by default.                  |
| `onPublishError` | `"log"` (default) or `"throw"`, below.                                                                    |

What fails:

| Failure                                 | Result                                                                                                                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An event's handler                      | `CommandEventFailed` with `details: { operation, event, handled, remaining }`, as with `"after-commit"`; later events are neither handled nor published.                                                                                             |
| A publish, with `onPublishError: "log"` | An `error` line `event-publish-failed` (`command`, `operation`, `event`, `publisher`, `topic`, `exception`) on the logger of the application, and the next event goes on. The call already committed, so a lost push does not turn it into an error. |
| A publish, with `"throw"`               | `CommandEventFailed` for that event.                                                                                                                                                                                                                 |
| A publisher no application declares     | `CommandEventFailed` caused by `PublisherNotBound` (`Application` layer, `details.publisher`).                                                                                                                                                       |

`onEventError` only applies to `"after-commit"`, so a command with a policy cannot have it. Invalid options throw `InvalidEventPolicy` (`Event` layer, `details.reason`) when the policy is made.

**Publishers.** `applicationOf({ publishers: { realtime: hub } })` declares them by key (an identifier; the value an object with a `publish(topic, event)` method, else `InvalidApplicationDeclaration`). An application has those of the applications it extends too, its own winning a key. A command whose policy names a key the application does not have throws `UnregisteredApplicationReference` at `applicationOf`. A call finds the publisher in the application that bound the command, else in the started application, so a command used alone works once an application with the publisher has started. `app.describe().publishers` gives each key with the application that declared it.

**Your own policies.** `eventPolicyOf({ name, validate?, handle, publishers? })` makes a factory: `validate(options)` returns why the options cannot be used (or `undefined`), `handle(events, info, options)` is the handler, and `publishers(options)` names the publisher keys it uses, so an application checks them. `eventPolicyDescriptionOf(handler)` gives `{ kind: "policy", name, options }` or `undefined`, and `eventPolicyCatalogOf(...factories)` groups factories by name, as codegen resolves them (`StdEventPolicies` holds `publishEvents`; `--policies` adds yours, see [afora.json](afora-json.md#catalogs-providers-stages-and-event-policies)).

`memoryPublisher()` from `@afora/core/testing` keeps each `{ topic, event }` in `published`, for tests.

## Environments

`environmentDependencies` takes one environment made by `environmentOf`, or a list of distinct ones, whose variables are merged in order, as a repository does (anything else throws `InvalidCommandDeclaration`). They are not read at declaration:

- `command.env` gives their variables, typed, read and validated on first use (a missing or rejected variable throws `InvalidEnvironment`); `command.environments` is the list.
- The event handlers get them as `info.env`: the handler policy and `onEventError`. They are read only when a handler reads `info.env`.
- A use case keeps declaring the environments it needs as dependencies (`dependencies: { mail: Mail }`, `this.dependencies.mail.FROM`, `$env.mail.FROM` in steps): when the command declares the same environment (the same object), the use case and its children get the variables of the call.

`run` and `execute` take `env`, some variables of the command's environments, typed, in place of the loaded ones for that call only:

```ts
const Mailer = commandOf({
	name: "Mailer",
	useCases: { notify: Notify }, // Notify declares { mail: Mail }
	environmentDependencies: [Mail, Queue],
	events: async (events, { env }) => publish(env.QUEUE_URL, events),
});

Mailer.env.QUEUE_URL; // string
await Mailer.run("notify", input, { env: { FROM: "test@example.com" } }); // Notify sees FROM, and the loaded rest of Mail
```

Each environment that has a given key is validated by its blueprint with the given variables over the loaded ones; one whose every key is given is not loaded at all, so a test can run without the real variables. A key no environment declares, a value the blueprint rejects, or an `env` that is not an object throws `InvalidCommandEnvironment` (`Command` layer, `details: { keys, issues }`), which `statusOf` maps to 500: it is configuration, not input. The variables of `command.env` do not change, and an override given to a use case's own `execute` still wins. The `env` of a call does not reach repository providers, which read `context.env` from the repository's own `environmentDependencies`. Sinks never pass it: `@afora/hono` only passes `context`.

Types: `CommandOf`, `CommandOperation`, `CommandInput`, `CommandResponse`, `CommandOptions` and `AnyCommand`. `options` is `{ context }` when the command declares a context, or the use case's `UseCaseOptions` when it does not.
