# T15: the steps DSL for use cases

T16 implements this design, and T17 brings it to `afora.json` and MCP. It
builds on T13 (context, `errors`, registration and `describe()`). The DSL is a
contract: v1 is small and closed, and it only grows by adding step kinds or
optional fields.

## 1. Principle: the TypeScript form is the JSON form

A use case can declare `steps` instead of a hand-written `execute`. The steps
are **plain data**. They are the same objects in TypeScript and in JSON,
except for three places where TypeScript passes a value and JSON passes a name:

- the record or entity class of `build`;
- the exception class of `ensure`;
- the function of `run`.

So the descriptor in `describe()` is the step list itself, with those values
replaced by names. Code generation and extraction then become a direct
mapping, and typing stays cheap.

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

```json
"Register": {
  "input": "RegisterInput", "response": "UserResponse",
  "dependencies": { "users": "Users" },
  "errors": ["UserAlreadyExists"],
  "implementation": { "steps": [
    { "find": "users.findByEmail", "args": ["$input.email"], "as": "existing" },
    { "ensure": "absent", "value": "$existing", "error": "UserAlreadyExists" },
    { "run": "hashPassword", "fn": { "import": "./handlers/password.ts#hashPassword" }, "args": ["$input.plainPassword"], "as": "hash" },
    { "build": "User", "values": { "name": "$input.name", "email": "$input.email", "password": "$hash" }, "as": "user" },
    { "create": "users", "value": "$user", "as": "saved" },
    { "return": { "user": "$saved" } }
  ] }
}
```

The class `useCaseOf` returns with `steps` is **concrete**: its prototype
`execute` is the interpreter, so `class Register extends useCaseOf({...}) {}`
needs no body. A subclass that overrides `execute` is hand-written, and
`describe()` reports it as `{ kind: "opaque" }`.

`steps` and a hand-written `execute` are the two implementations. Generated
code for a steps use case is complete, with no hand-written file.

## 2. Values: references, literals and mappings

A _value_ is one of:

- **A reference**: a string that starts with `$`. The roots are:
  - `$input` (the parsed input);
  - `$context` (the parsed context, T13);
  - `$env.<dependency>` (the variables of an environment dependency);
  - `$<name>` (the result of an earlier step bound with `as`).

  A path follows the root with `.` segments: identifiers, or non-negative
  integer indices (`$saved.tags.0`). A missing segment resolves to
  `undefined`. It never throws, and blueprints and `ensure` decide.
- **A literal**: any JSON value that is not a reference string. A string that
  starts with `$` is written `{ "literal": "$5" }`. Any object whose only key
  is `literal` is a literal of its value.
- **A mapping**: an object or an array whose members are values, resolved
  recursively. `{ "user": "$saved" }` is a mapping.

There are no operators, expressions or string interpolation. Anything
computed goes through `run`.

The names `input`, `context`, `env` and `literal` are reserved. A step's `as`
must be an identifier, unique within the use case, not reserved, and bound
before any reference to it.

## 3. Step kinds (v1, closed)

| Step                           | Shape                                              | Does                                                                                                                                                                                                                       | Result (`as`)        |
| ------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `find`                         | `{ find: "<repo>.<action>", args?: value[], as? }` | calls a **read** action of a repository dependency: `findBy*`, `findManyBy*`, `findMany`, `exists`, `findPage`, `count`                                                                                                    | its result           |
| `ensure`                       | `{ ensure: kind, value, other?, error, details? }` | `kind` is one of `exists` (not `undefined`/`null`), `absent`, `equals`/`notEquals` (`other` required, structural equality as in queries), `true`, `false`; on failure, `throw new error({ source: useCaseName, details })` | none                 |
| `build`                        | `{ build: Class, values, as }`                     | `new Class(values)`, a record or entity; invalid values throw as in a hand-written `new`                                                                                                                                   | the instance         |
| `change`                       | `{ change: "$ref", key, value, as? }`              | `entity.change[key](value)`; `key` must be in the class's change keys                                                                                                                                                      | the record           |
| `invoke`                       | `{ invoke: "$ref", method, args?: value[], as? }`  | calls a public method of a record or entity, including plugin methods such as `publish` or `verifyPassword`                                                                                                                | its result (awaited) |
| `create` / `update` / `delete` | `{ create: "<repo>", value, as? }`                 | the repository action of that name                                                                                                                                                                                         | its result           |
| `call`                         | `{ call: "<useCase>", input: value, as? }`         | the use-case dependency function: validated child, inherited context, events moved up                                                                                                                                      | its response         |
| `run`                          | `{ run: "<name>", fn, args?: value[], as? }`       | `await fn(...args, { context })`; `name` is unique within the use case                                                                                                                                                     | its result           |
| `return`                       | `{ return: value }`                                | the response, validated by the response blueprint as today                                                                                                                                                                 | none                 |
- Steps run in order, each awaited. `return` is required and must be the
  last step, exactly once.
- There is no branching except `ensure`, and no loops. That is deliberate:
  anything else goes through `run`, or through a hand-written `execute`.
- Every repository and use-case call goes through the bound dependency
  functions, so the T13 scope (transactions), the event collection and the
  `guard` trace frames work exactly as for a hand-written `execute`.
- `error` must be listed in the use case's `errors`, which documents it.

## 4. Validation at declaration (runtime)

`useCaseOf` validates `steps` and throws `InvalidUseCaseStep` (layer
`UseCase`, `details: { index, reason }`) when:

- a step has an unknown kind, a missing or extra field, or a bad `as`;
- a reference has an unknown root, uses a name not yet bound, or uses
  `$context` without a declared context;
- a reference to `$input.<key>` or `$context.<key>` names a first-level key
  the blueprint does not declare. Deeper paths are not checked;
- `<repo>` is not a repository dependency, `<action>` is not one of its
  actions, or a `find` names a write action;
- `<useCase>` is not a use-case dependency, or `$env.<dependency>` is not an
  environment dependency;
- `build` is not a record or entity class;
- `ensure.error` is not in `errors`, or `equals`/`notEquals` has no `other`;
- `run` has no function or a duplicate name;
- `return` is missing, duplicated or not last;
- `change.key` is not a change key of the class `build` produced for that
  reference, when that class is statically known (bound by `build`).
  Otherwise it is checked at execution.

The same rules apply in `validateSpec` (T17), with stable issue codes that
mirror the reasons: `unknown_step`, `invalid_reference`, `unbound_reference`,
`unknown_dependency`, `unknown_action`, `write_in_find`, `undeclared_error`,
`missing_return`, `invalid_step_name`, and so on.

## 5. Types (kept cheap)

- `UseCaseStep<Dependencies>` is a discriminated union. TypeScript checks the
  dependency names and the action names. It does **not** check value
  compatibility:
  - `find` is a template literal of `${RepoKey}.${ReadAction}`, from each
    repository dependency's `actions`;
  - `create`/`update`/`delete` take repository keys whose repository has that
    action;
  - `call` takes use-case keys;
  - `ensure.error` and `build` take classes;
  - references are typed `` `$${string}` ``.
- When `steps` is given, the overload returns a concrete class and does not
  require `execute`.
- Value types are checked at execution by the blueprints, as for any input.
  Static value typing may be a later, additive refinement.
- Budget: T16 adds a `use-case.sandbox.ts` case with the six steps above and
  measures with `bun run test:type-perf`. It must stay under the per-edit
  target (100k). A snapshot change is a stop-and-report point.

## 6. `describe()` (extends T13)

`implementation` is one of:

- `{ kind: "steps", steps }`. In it, `build` and `ensure.error` become names
  (`"User"`, `"UserAlreadyExists"`; a core exception is
  `{ "core": "RepositoryUniqueViolation" }`), and `run.fn` becomes
  `{ kind: "opaque" }`;
- `{ kind: "opaque" }`, for a hand-written `execute`.

On extraction, a `run` function maps through the `imports` option with the
key `useCases.<Name>.run.<name>`. Without it, extraction fails with an
actionable error, as for opaque providers and use cases.

`build` and `error` must be registered declarations (T13 rules), because the
JSON refers to them by name.

## 7. Errors at execution

- A reference resolves to `undefined` for missing paths. `ensure` and
  blueprints reject what matters.
- A `change`/`invoke` target that is not a record or entity, or a method that
  does not exist, throws `InvalidUseCaseStep` with `details.index`, inside the
  `UseCase` guard frame.
- Errors thrown by actions, `run` functions or `new Class` propagate
  unchanged, with the trace frames of the use case.

## 8. Tests (T16)

- One test file per step kind.
- References: roots, paths, indices, literal escapes, mappings, reserved names.
- Every declaration-time rule, each with its reason.
- A full `Register`/`Login` flow on `inMemoryProvider`, with events collected,
  child `call` with context, a scope applied through steps (fake mapping),
  and the response validated.
- `describe()` output for steps and opaque use cases.
- `test:api` and `test:types` updates.
