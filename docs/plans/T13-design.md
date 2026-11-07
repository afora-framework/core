# T13: use-case context, metadata, execution scope and registration

T14 implements this design. T15 designs the steps DSL on top of it, and T17
brings use cases to `afora.json`. Everything here is additive to the public API.

## 1. Declaration

`useCaseOf` takes these new optional settings:

```ts
useCaseOf({
	name: "Register",
	blueprint: RegisterInput,
	response: UserResponse,
	dependencies: { users: Users, database: Database },
	context: RequestContext, // a blueprint; optional
	description: "Signs a user up.", // optional
	tags: ["users"], // optional, default []
	deprecated: false, // optional, default false
	errors: [UserAlreadyExists, RepositoryUniqueViolation], // exceptionOf classes; optional, default []
});
```

The declared class gets these statics, frozen: `useCaseName`, `blueprint`,
`response` and `dependencies` (which exist today), plus `context` (the
blueprint or `undefined`), `description` (`string | undefined`), `tags`,
`deprecated` and `errors`. `useCaseOf` validates the settings:

- `context` is a non-optional blueprint;
- `description` is a string;
- `tags` are distinct non-empty strings;
- `deprecated` is a boolean;
- `errors` are distinct classes made by `exceptionOf`.

Anything else throws `InvalidUseCaseDeclaration`.

`errors` lists what a caller should expect. It changes nothing at runtime.
Outputs use it to document error responses (T22). An exception that is not
listed still propagates as it does today.

## 2. Context per call

```ts
new Register(input, { context: { userId, requestId } });
this.context; // Readonly<BlueprintValue<RequestContext>>, parsed and frozen
```

- The second constructor argument is `UseCaseOptions`. When the declaration
  has a `context`, `options.context` is **required** by type (a constructor
  rest tuple chosen by a conditional on the context blueprint) and validated
  by its blueprint. Invalid or missing context throws `InvalidUseCaseContext`
  (layer `UseCase`, `details.issues`), the way invalid input does.
- Without a declared context, `options.context` is not accepted by type, and
  at runtime a given context is ignored. `this.context` is typed `undefined`.
- `context` is a read-only instance member, next to `input`. Use cases are not
  records, so this reserves no record key.

**Inheritance.** A child use case called through a dependency function
receives the parent's context, narrowed to the keys of its own context
blueprint (picked from the parent's parsed value) and then validated by it.

- A child that declares no context receives none.
- A child that declares one under a parent without context fails when called,
  with `InvalidUseCaseContext`.

An override function passed to `execute` keeps its signature, `(input) =>
response`. Passing it the context is a later addition.

## 3. Execution scope (internal, used by Command)

The execution state (`ExecutionState` in `use-case.ts`) gains `context` and
`scope`. A scope is internal:

```ts
interface ExecutionScope {
	/** Provider used by the call for each provider the repositories declared. */
	readonly providers: ReadonlyMap<IRepositoryProvider, IRepositoryProvider>;
}
```

- It is passed through an **unexported** symbol key of the constructor
  options (`new UC(input, { context, [ScopeKey]: scope })`). `ScopeKey` lives
  in `src/core/use-case/scope.ts` and is not exported by `src/index.ts`, so
  it adds nothing to the public surface. `src/core/command` (T19) imports it.
- Children inherit the parent's scope.
- `bindRepository` routes `provider` through the scope: the `view` Proxy's
  `get` returns `scope.providers.get(original) ?? original` for the
  `provider` key, so methods of `RepositoryOf` subclasses use the scoped
  provider too. `context` is unchanged (the provider still gets the same
  `RepositoryContext`).
- Relation loading (`references.ts`) resolves the provider of each related
  repository from its state; that lookup also applies the active scope. The
  scope travels with the call: thread it from the view through
  `hydrate`/`hydrateMany`, not through a global. No `AsyncLocalStorage`,
  because the core must load in browsers.
- Without a scope, behavior is exactly today's.

## 4. Registration: `applicationOf({ useCases, exceptions })`

There are two new collections:

- `useCases: { Register, CreateUser }`, keyed by name. **The key must equal
  `useCaseName`**, otherwise `InvalidApplicationDeclaration`. That keeps the
  JSON names and the runtime names the same.
- `exceptions: { UserAlreadyExists }`, made by `exceptionOf`, keyed by their
  `name`. The same rule applies.

Validation, on the resolved set, extended applications included:

- Every dependency of a registered use case must itself be registered: a use
  case, a repository or an environment. Otherwise
  `UnregisteredUseCaseDependency`, a new exception in the `Application`
  layer, with `details.useCase` and `details.dependency`.
- Records and entities held by `blueprint`, `response` or `context`, at any
  depth, must be registered (the existing `UnregisteredApplicationReference`).
- Each class in `errors` must be registered in `exceptions` **unless it is an
  exception exported by `@afora/core`**, such as `RepositoryUniqueViolation`.
  Otherwise `UnregisteredApplicationReference`.

**Binding.** With a `provider`, `app.useCases.Register` is a subclass of
`Register` whose static `dependencies` swap each repository for the
application-bound one, recursively through child use cases. It is memoized
per application, so the same subclass comes back every time. Without a
provider, `app.useCases.Register === Register`. The originals are never
mutated, as with repositories today. `app.useCase(Register)` mirrors
`app.repository(Users)`.

## 5. `describe()`

```ts
useCases: Record<
	string,
	{
		from: string;
		name: string; // useCaseName
		description?: string;
		tags: readonly string[];
		deprecated: boolean;
		input: FieldsDescription;
		response: FieldsDescription;
		context?: FieldsDescription;
		errors: readonly (
			| { kind: "exception"; ref: string }
			| { kind: "core"; name: string }
		)[];
		dependencies: Record<
			string,
			{ kind: "use-case" | "repository" | "environment"; ref: string }
		>;
		implementation: { kind: "opaque" }; // T16 adds { kind: "steps", steps }
	}
>;
exceptions: Record<
	string,
	{
		from: string;
		layer: ExceptionLayers;
		message?: string; // only when declared as a string
	}
>;
```

A field that is a registered blueprint, record or entity is a reference by
name, as the existing field descriptions already do.

## 6. JSON (T17) and the generated code

```json
{
	"exceptions": {
		"UserAlreadyExists": {
			"layer": "use-case",
			"message": "A user with this email already exists."
		}
	},
	"useCases": {
		"Register": {
			"description": "Signs a user up.",
			"tags": ["users"],
			"input": "RegisterInput",
			"response": { "fields": { "user": "User" } },
			"context": { "fields": { "userId": "id?" } },
			"dependencies": { "users": "Users", "database": "Database" },
			"errors": ["UserAlreadyExists", "RepositoryUniqueViolation"],
			"implementation": { "import": "./handlers/register.ts#Register" }
		}
	}
}
```

- `input`, `response` and `context` take a blueprint name or an inline
  `{ "fields": {...} }`.
- An `import` implementation generates an abstract base that the hand-written
  class extends. The application imports the hand-written class:

```ts
// use-cases.ts (generated)
export abstract class RegisterBase extends useCaseOf({ name: "Register", blueprint: RegisterInput, response: ..., context: ..., dependencies: { users: Users, database: Database }, errors: [UserAlreadyExists, RepositoryUniqueViolation], description: "Signs a user up.", tags: ["users"] }) {}

// handlers/register.ts (hand-written)
export class Register extends RegisterBase {
  override async execute({ users = this.dependencies.users } = {}) { ... }
}

// application.ts (generated)
import { Register } from "../handlers/register";
export const App = applicationOf({ ..., useCases: { Register }, exceptions: { UserAlreadyExists } });
```

There is no import cycle: the handler imports the generated base and the
application imports the handler.

- Extraction maps `implementation: { kind: "opaque" }` to `{ "import": ... }`
  through the `imports` option (key `useCases.Register`). Without it,
  extraction fails with an actionable error, as for opaque providers.
- T15 adds `"implementation": { "steps": [...] }`.

## 7. Types and budget

- `UseCaseConstructor` gains a `Context` type parameter, defaulting to "no
  context", so existing spellings keep working.
- `UseCaseContext<Class>` extracts the context value. `UseCaseOptions` is
  public.
- Keep the conditional for the constructor tuple shallow, and measure with
  `bun run test:type-perf`. T14 adds a `use-case.sandbox.ts` case with a
  context and must stay under the per-edit budget (target 100k).
- A change in the type-perf snapshot is a stop-and-report point.

## 8. Tests (T14)

- Context: required, validated, frozen, inherited and narrowed for children,
  missing for children that need it, and ignored when not declared.
- Metadata: statics and validation errors.
- Scope: repository methods, `RepositoryOf` subclass methods calling
  `this.*`, relation loading, and children all use the scoped provider. This
  is tested with a fake mapping, without a transaction (that is T19).
- `applicationOf`: `useCases` and `exceptions` collections, all three
  validation rules, binding to the application provider (recursive and
  memoized), and `describe()` output.
- `test:api` diff: only additions.
