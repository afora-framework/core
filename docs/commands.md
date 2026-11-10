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
	events: "after-commit", // "after-commit" (default) | "manual" | handler
	onEventError: (error, event, info) => {}, // optional, "after-commit" only
});

const { user } = await Users.run("register", input, { context });
const { value, events } = await Users.execute("register", input, { context }); // no event policy
```

The keys of `useCases` are the operation names: identifiers holding concrete use case classes. `commandOf` validates its settings and throws `InvalidCommandDeclaration` (`Command` layer, `details.reason`) for anything else. The command is frozen and exposes `commandName`, `description`, `tags`, `context`, `useCases`, `transaction`, `environments`, `env`, `events`, `onEventError` and `operations`; `isCommand` identifies one.

In an application, register commands under `commands: { Users }` (keyed by `commandName`, else `InvalidApplicationDeclaration`); every use case of every command must be in `useCases` (`UnregisteredApplicationReference`, `details: { command, useCase }`). With a `provider`, `app.commands.Users` (or `app.command(Users)`) is the same command rebuilt over the bound use cases, memoized, with the same settings; the transaction check runs again against the bound providers and throws `InvalidCommandDeclaration` at `applicationOf`. Every environment of a command must be in `environments` (`UnregisteredApplicationReference`, `details: { command }`), and the rebuilt command keeps them. `app.describe().commands` gives each command's operations (`{ ref }` of the use case), `transaction`, `environments` (by name, only when it declares any), `events` (a handler appears as `{ kind: "opaque" }`) and `onEventError` (only when set).

`run(op, input, options)` does this:

1. An unknown operation throws `UnknownCommandOperation` (`details.operation`).
2. With a command `context`, `options.context` is validated by that blueprint (`InvalidCommandContext`, `details.issues`) and each use case gets it narrowed to its own context keys; a use case without a context gets none. Without a command `context`, `options.context` goes to the use case as is, typed and validated by it.
3. A fresh use case is built and executed. Input errors stay use case errors.
4. With `transaction: true`, `execute()` runs inside the `transaction` of the provider of the repositories, which therefore see the transaction (relations and child use cases included). A rejection rolls back and propagates. Every repository reachable from the use cases (through child use cases and relations) must share one provider, and it must support `transaction`; otherwise `InvalidCommandDeclaration` lists the repositories. At declaration `commandOf` checks the providers the repositories declared; repositories without one are bound by an application later, so all of them are checked when an application binds the command, or on the first call of a command used alone. A command with no repository ignores the flag.
5. The events are drained **after** the transaction resolves, so a call that rolled back handles none.
6. The event policy applies, in `run` only:
   - `"after-commit"`: awaits `event.handle()` in emission order. On the first failure, `onEventError(error, event, info)` is awaited (`info` as a handler gets it, below) and the next event runs; without it, `run` throws `CommandEventFailed` (`cause`, `details: { operation, event, handled, remaining }`). The commit already happened, so the data is saved even when this error is thrown.
   - `"manual"`: `run` drops the events; use `execute` to get them.
   - a function: awaited with `(events, { command, operation, context, env, logger })`; a rejection is a `CommandEventFailed`. `logger` is the one of the application that bound the command (see [Logging](logging.md)), and an event handled by `"after-commit"` gets it too.
7. The validated response is returned.

`execute` performs steps 1 to 5 and returns `{ value, events }` without applying the policy, for outboxes and tests. The whole call runs under a `Command` guard, so errors gain the frame `command @ Users.register`. Concurrent calls are independent; each builds its own use case.

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
