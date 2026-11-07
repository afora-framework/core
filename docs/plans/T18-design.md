# T18: Command

T19 implements `commandOf`, T20 registers commands in `applicationOf`, and T21
brings them to `afora.json` and MCP. A command groups use cases under
operation names and is the **execution boundary** of a call: the context is
validated once, the transaction is opened and closed, the events are handled
by a policy, and the trace gets a `command` frame. Output (T22) turns commands
into operations.

## 1. Declaration

```ts
const Users = commandOf({
	name: "Users",
	description: "Accounts.", // optional
	tags: ["accounts"], // optional, default []
	context: RequestContext, // a blueprint; optional
	useCases: {
		register: Register,
		login: Login,
		changePassword: ChangePassword,
	},
	transaction: true, // optional, default false
	events: "after-commit", // "after-commit" (default) | "manual" | handler
	onEventError: (error, event) => {}, // optional, after-commit only
});
```

- **Operation names** are the keys of `useCases`: identifiers, unique. The
  values are concrete use-case classes (`isUseCaseClass`).
- `commandOf` validates:
  - `name` is a non-empty string;
  - `description` is a string and `tags` are distinct strings;
  - `context` is a non-optional blueprint;
  - `useCases` is non-empty, with identifier keys and concrete classes;
  - `transaction` is a boolean;
  - `events` is one of the two strings or a function;
  - `onEventError` is a function, only with `"after-commit"`.

  Anything else throws `InvalidCommandDeclaration`, a new exception in the
  `Command` layer, with `details.reason`.
- **Transaction check at declaration.** With `transaction: true`, collect
  every repository reachable from the use cases: their dependencies,
  recursively through child use cases. Then:
  - they must all resolve to the **same provider**;
  - that provider must have `transaction`.

  Otherwise `InvalidCommandDeclaration` lists the offending repositories. The
  check runs again when an application binds the command to its provider
  (T20).

The command object is frozen and has these properties:
- `[Kind]: "command"`;
- `commandName`;
- `description`;
- `tags`;
- `context`;
- `useCases`, the frozen operation map;
- `transaction`;
- `events`;
- `operations`: `readonly string[]`, in declaration order.

`isCommand(value)` tells whether a value is one.

## 2. Running

```ts
const { user } = await Users.run("register", input, { context }); // response
const { value, events } = await Users.execute("register", input, { context }); // no policy
```

`run` executes these steps:
1. Validates `op`. An unknown one throws `UnknownCommandOperation` (layer
   `Command`, `details.operation`).
2. Validates the context:
   - With a command `context`, it validates `options.context` by that
     blueprint (`InvalidCommandContext`, layer `Command`, `details.issues`)
     and gives the use case the context narrowed to its own context keys,
     with the T13 rule.
   - Without a command context, `options.context` goes to the use case as is,
     and the use case validates it.
3. Builds the use case, `new UseCase(input, { context, [ScopeKey]: scope })`.
   Input errors stay use-case errors, as today.
4. **Transaction.** With `transaction: true`, it runs `execute()` inside
   `provider.transaction(async (scoped) => ...)`. The scope is
   `{ providers: new Map([[provider, scoped]]) }`. A rejection rolls back and
   propagates.
5. Drains the events (`useCase.pullEvents()`) **after** the transaction
   resolves, so a rolled-back call handles none.
6. **Event policy** (`run` only):
   - `"after-commit"`: awaits `event.handle()` in emission order. On the
     first failure:
     - with `onEventError`, it awaits `onEventError(error, event)` and goes
       on with the next event;
     - without it, it throws `CommandEventFailed` (layer `Command`, `cause`,
       `details: { operation, event: event.name, handled, remaining }`).
       The commit already happened, and the documentation says so.
   - `"manual"`: the events are dropped by `run`. Use `execute` to get them.
   - A handler: awaits `handler(events, { command, operation, context })`.
     A rejection propagates as `CommandEventFailed`.
7. Returns the validated response.

`execute` performs steps 1 to 5 and returns `{ value, events }` without
applying the policy. It exists for outboxes and tests.

**Trace.** The whole call runs under
`guard({ layer: Command, source: "<Name>.<op>" })`, so a use-case error gets
the frame `command:Users.register`.

Each call builds a fresh use case (one execution per instance, as today).
There is no global state, and concurrent `run`s are independent; the
provider's transaction serializes them if it does.

## 3. Types

- `CommandOf<UseCases, Context>`.
- `run<Op extends keyof UseCases & string>(op, input: UseCaseInput<UseCases[Op]>, ...options)`
  returns `Promise<UseCaseResponse<UseCases[Op]>>`.
- `options` is `{ context: BlueprintInput<Context> }` when the command
  declares a context, or the use case's `UseCaseOptions` when it does not.
  It is a rest tuple, as in T13.
- `CommandOperation<C>` (the operation names), `CommandInput<C, Op>`,
  `CommandResponse<C, Op>`, `AnyCommand`.
- Budget: add a sandbox case (`src/core/command/command.sandbox.ts`) and
  measure with `bun run test:type-perf`. A snapshot change is a
  stop-and-report point.

## 4. Applications (T20)

`applicationOf({ commands: { Users } })`:
- the key must equal `commandName` (`InvalidApplicationDeclaration`);
- every use case of every command must be registered in `useCases`
  (`UnregisteredApplicationReference`, `details: { command, useCase }`).

With a provider, `app.commands.Users` is a command over the app-bound use
cases (T14 binding), memoized. The transaction check runs again against the
app provider. `app.command(Users)` mirrors `app.repository`.

`describe()` gains:

```ts
commands: Record<
	string,
	{
		from: string;
		name: string;
		description?: string;
		tags: readonly string[];
		context?: FieldsDescription;
		operations: Record<string, { ref: string }>; // op → use case name
		transaction: boolean;
		events: "after-commit" | "manual" | { kind: "opaque" };
		onEventError?: { kind: "opaque" };
	}
>;
```

## 5. JSON (T21)

```json
"commands": {
  "Users": {
    "description": "Accounts.",
    "context": { "fields": { "userId": "id?" } },
    "useCases": { "register": "Register", "login": "Login" },
    "transaction": true,
    "events": "after-commit"
  }
}
```

```ts
export const Users = commandOf({
	name: "Users",
	description: "Accounts.",
	context: blueprintOf((ctx) => ({ userId: ctx.optional.id })),
	useCases: { register: Register, login: Login },
	transaction: true,
	events: "after-commit",
});
```

- A handler or an `onEventError` is `{ "import": "./events.ts#dispatch" }`.
- On extraction, both map through the `imports` option with the keys
  `commands.Users.events` and `commands.Users.onEventError`. Without a
  mapping, extraction fails with an actionable error.
- `transaction: false`, `events: "after-commit"` and `tags: []` are the
  defaults, and normalization drops them.

## 6. Files and tests (T19)

Files: `src/core/command/command.ts`, `exceptions.ts`
(`InvalidCommandDeclaration`, `UnknownCommandOperation`,
`InvalidCommandContext`, `CommandEventFailed`, all recognized by
`isExportedException`), `types/command.interface.ts`, `command.test.ts` and
`command.sandbox.ts`. Remove the empty `src/core/commands` and
`src/core/actions`.

The tests cover:
- the declaration rules;
- running every operation;
- context validation and narrowing;
- a transaction that commits, and one that rolls back on a use-case error and
  on a step `ensure` (with `inMemoryProvider`, whose transaction support
  exists), with no events handled on rollback;
- the transaction check: mixed providers, and a provider without
  `transaction`;
- each event policy, including `onEventError` and `CommandEventFailed`
  details;
- `execute`;
- the trace frame;
- concurrent runs.
