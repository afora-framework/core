# UseCases

`useCaseOf` declares an abstract operation with input and response blueprints and a collection of concrete UseCase classes as dependencies. This combines the **Command** pattern (an instance holds the operation's arguments) with **method injection** (dependency functions are supplied to `execute`).

```ts
import { blueprintOf, entityOf, useCaseOf } from "@afora/core";

const UserInput = blueprintOf((ctx) => ({ name: ctx.string }));
class User extends entityOf(UserInput) {}
const UserResponse = blueprintOf(() => ({ user: User }));

class CreateUser extends useCaseOf({
	name: "CreateUser",
	blueprint: UserInput,
	response: UserResponse,
}) {
	override async execute() {
		return { user: new User(this.input) };
	}
}

class RegisterUser extends useCaseOf({
	name: "RegisterUser",
	blueprint: UserInput,
	dependencies: { createUser: CreateUser },
	response: UserResponse,
}) {
	override async execute({ createUser = this.dependencies.createUser } = {}) {
		return await createUser(this.input);
	}
}

const operation = new RegisterUser({ name: "Ana" });
const { user } = await operation.execute();
for (const event of operation.pullEvents()) await event.handle();

// Partial overrides replace direct dependencies; other dependencies resolve normally.
await new RegisterUser({ name: "Ana" }).execute({
	createUser: async (input) => ({ user: new User(input) }),
});
```

The constructor validates its arguments and exposes their parsed values as read-only `this.input`. Implement `execute` as an async prototype method, not an arrow-function field. It must return the value shape of the response blueprint, including record/entity instances for those fields. The framework wraps the method automatically to validate the response and collect events; no `super.execute()` call is needed. Each instance allows one execution attempt, including failures; concurrent or subsequent calls reject with `UseCaseAlreadyExecuted`.

Dependencies default to `{}`. Each dependency function creates a fresh child, resolves its dependencies and returns its validated response. Await all dependency calls before returning. Functions are usable only during execution. Use the destructured defaults shown above to keep both no-argument calls and partial overrides inferred in TypeScript. `execute(deps = this.dependencies)` also supports no-argument calls, but its inferred override type requires the complete dependency map. During execution, `this.dependencies` exposes the resolved functions, including overrides. Overrides apply only to direct dependencies, and their inputs and responses are validated against the declared child. There is no global container.

Events from managed children move to the parent when each child finishes, including on failure and when the parent's response omits the child result. Then the validated parent response is traversed through declared records, entities, nested blueprints and lists. Repeated object references are visited once; separately emitted duplicate events are preserved. Child events follow completion order, followed by remaining response events. No handlers run automatically. `pullEvents()` immediately drains the queue, which remains available after failure. Invalid responses are not drained. Overrides contribute events from their returned entities; hidden operations inside an override must expose their events separately.

With a logger set (`configure({ logger })`), each execution, each repository call made through it and a failure, once, are logged; see [Logging](logging.md).

## Context and metadata

A use case can declare a `context`, a blueprint for what the caller supplies with each call (the signed-in user, a request id), and metadata that tools can read:

```ts
const RegisterBase = useCaseOf({
	name: "Register",
	blueprint: UserInput,
	response: UserResponse,
	context: blueprintOf((ctx) => ({ userId: ctx.id, requestId: ctx.string })),
	description: "Signs a user up.", // optional
	tags: ["users"], // optional, default []
	deprecated: false, // optional, default false
	errors: [UserAlreadyExists, RepositoryUniqueViolation], // exceptionOf classes a caller should expect
});

const operation = new Register(input, { context: { userId, requestId } });
operation.context; // Readonly<{ userId: string; requestId: string }>, parsed and frozen
```

With a declared `context`, the second constructor argument is required by type and validated by its blueprint; a missing or invalid one throws `InvalidUseCaseContext` (`UseCase` layer, `details.issues`). Without one, `options.context` is not accepted and `this.context` is `undefined`. `UseCaseContext<typeof Register>` extracts the type, and `UseCaseOptions` is the type of the second argument.

A child called through a dependency function receives its parent's context narrowed to the keys of its own `context` blueprint and validated by it. A child with no context gets none; a child that declares one under a parent without context fails with `InvalidUseCaseContext`. Overrides passed to `execute` keep the signature `(input) => response`.

The class gets the frozen statics `context`, `description`, `tags`, `deprecated` and `errors`, beside `useCaseName`, `blueprint`, `response` and `dependencies`. `context` is a non-optional blueprint, `tags` are distinct non-empty strings, and `errors` are distinct classes made by `exceptionOf`; anything else throws `InvalidUseCaseDeclaration`. `errors` documents what to expect and changes nothing at runtime: an exception that is not listed still propagates.

`UseCaseInput`, `UseCaseResponse` and `UseCaseDependencies` extract a declaration's types. `isUseCase` identifies instances; `isUseCaseClass` identifies concrete declarations with a prototype `execute`. UseCases carry their own kind and cannot be used as fields of ordinary data blueprints. Validation errors carry `details.issues`; errors crossing an execution boundary preserve their cause and gain a `UseCase` trace frame using the declared name.

## Steps

Instead of writing `execute`, a use case can declare `steps`: plain data that the use case interprets. The class is concrete, so it needs no body, and `describe()` reports the steps (a hand-written `execute` is `{ kind: "opaque" }`).

```ts
class Register extends useCaseOf({
	name: "Register",
	blueprint: RegisterInput, // { name, email, plainPassword }
	response: UserResponse, // { user: User }
	dependencies: { users: Users },
	errors: [UserAlreadyExists],
	steps: [
		{ find: "users.findByEmail", args: ["$input.email"], as: "existing" },
		{ ensure: "absent", value: "$existing", error: UserAlreadyExists },
		{
			run: "hashPassword",
			fn: hashPassword,
			args: ["$input.plainPassword"],
			as: "hash",
		},
		{
			build: User,
			values: { name: "$input.name", email: "$input.email", password: "$hash" },
			as: "user",
		},
		{ create: "users", value: "$user", as: "saved" },
		{ return: { user: "$saved" } },
	],
}) {}
```

The steps are the same objects in TypeScript and in JSON, except for the class of `build`, the exception class of `ensure.error` and the function of `run`, which the descriptor names or marks `opaque`. TypeScript checks the dependency and action names (`"users.findByEmail"` only exists if `Users` has that read action); the values are checked at execution by the blueprints. Steps run in order, each awaited, and every repository and use case call goes through the same dependency functions as a hand-written `execute`: execution scope, events, trace frames, `UseCaseAlreadyExecuted` and `execute({ ...overrides })` behave identically.

A _value_ is a reference, a literal or a mapping:

| Value                             | Meaning                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `"$input.email"`                  | the parsed input; a path of identifiers and indices follows the root (`$saved.tags.0`); a missing segment is `undefined` |
| `"$context.userId"`               | the parsed context (only if the use case declares one)                                                                   |
| `"$env.mail.FROM"`                | a variable of an environment dependency                                                                                  |
| `"$name"`                         | the result of an earlier step bound with `as`                                                                            |
| `"text"`, `1`, `true`, `null`     | a JSON literal; write `{ literal: "$5" }` for a string that starts with `$`                                              |
| `{ user: "$saved" }`, `["$a", 2]` | a mapping, resolved recursively                                                                                          |

There are no operators or interpolation: anything computed goes through `run`. The names `input`, `context`, `env` and `literal` are reserved.

| Step                                                   | Does                                                                                                                                                                               | Result (`as`) |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `{ find: "<repo>.<action>", args?, as? }`              | a read action: `findBy*`, `findManyBy*`, `findMany`, `exists`, `findPage`, `count`                                                                                                 | its result    |
| `{ ensure, value, other?, error, details? }`           | `ensure` is `exists`, `absent`, `equals`, `notEquals` (`other` required, structural equality as in queries), `true` or `false`; on failure throws `new error({ source, details })` | none          |
| `{ build: Class, values, as }`                         | `new Class(values)`, a record or entity                                                                                                                                            | the instance  |
| `{ change: "$ref", key, value, as? }`                  | `record.change[key](value)`; `key` must be a change key                                                                                                                            | the record    |
| `{ invoke: "$ref", method, args?, as? }`               | a public method of a record or entity (`publish`, `verifyPassword`...), awaited                                                                                                    | its result    |
| `{ create \| update \| delete: "<repo>", value, as? }` | the repository action of that name                                                                                                                                                 | its result    |
| `{ call: "<useCase>", input, as? }`                    | the use case dependency: validated child, inherited context, events moved up                                                                                                       | its response  |
| `{ run: "<name>", fn, args?, as? }`                    | `await fn(...args, { context })`; `name` is unique in the use case                                                                                                                 | its result    |
| `{ return: value }`                                    | the response, validated by the response blueprint; required, last, once                                                                                                            | none          |

`useCaseOf` validates the steps at declaration and throws `InvalidUseCaseStep` (`UseCase` layer, `details: { index, reason, code }`) for an unknown or malformed step, a bad or repeated `as`, a reference to an unbound name, a `$context` without a declared context, a first-level `$input.<key>` or `$context.<key>` the blueprint lacks, an unknown repository, action, use case or environment, a `find` of a write action, a `build` that is not a record class, an `ensure.error` missing from `errors`, a `change.key` that is not a change key of the class `build` made, and a missing, repeated or misplaced `return`. A `change` or `invoke` on something that is not a record, or on a member it lacks, throws `InvalidUseCaseStep` with the `index` while the steps run. In an application, the classes of `build` and `ensure.error` must be registered (`UnregisteredApplicationReference`); `describe()` gives `implementation: { kind: "steps", steps }` with them by name (`"User"`, `"UserAlreadyExists"`, or `{ core: "RepositoryUniqueViolation" }` for an exported exception) and `run.fn` as `{ kind: "opaque" }`. A subclass that overrides `execute` is hand-written, so it is `{ kind: "opaque" }`.
