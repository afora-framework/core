# Troubleshooting

Errors you are likely to meet, with what they mean and the fix. The names are the exception classes (`error.name`, or `error.is(Class)`); the messages are quoted as the code writes them, with your names in place of the placeholders. Match on the class, the layer or an issue `code` in your code, not on the text of a message: the text is not part of the [contract](../VERSIONING.md).

For every exception there is a `trace`: print `error.toString()` to see each layer it crossed, from the origin. See [Exceptions](exceptions.md).

## Declaring things

### ReservedRecordKey

> `"set" is a member of record "User" and cannot be a key of its blueprint.`

A key of the blueprint has the name of a member of the record (`set`, `toJSON`, `onSet`, `onSetAll`, `change` when there are `change` keys) or of `Object.prototype` (`toString`, `constructor`, `__proto__`...). A subclass that declares a member with the name of a key throws it too, on its first instance. Rename the key. See [Records](records.md).

### ReservedBlueprintKey

> `"optional" is reserved and cannot be a plugin property.`

A blueprint plugin declared a key that `ctx` reserves (`optional`, `list`, `listOf`, `optionalOf`, `propertyOf`, `variantOf`). Rename it. See [Blueprints](blueprints.md).

### InvalidRepositoryDeclaration

`repositoryOf` was given something it cannot use. `details.reason` says which: an action that is not valid, `findBy<Key>` for a key that is not unique, `restore` without `deletion: "soft"`, a missing or extra entry in `relations`, a provider that is not one. Read the reason; it names the thing. See [Repositories](repositories.md).

### UseCaseUnavailable

> `The use case "update" is not available for "TaskRepository": the repository lacks the action "update".`

A standard use case (`ctx.update(Tasks)`, or one of `resourceOf`) needs actions or plugins the repository does not have. Add them to `actions` (`details.missing` lists them), or leave that use case out. A variant of the same error, `the entity has no change key an input can take`, means `update` needs at least one key in the `change` option of the entity. It is thrown when the command is declared. See [Standard use cases](std-use-cases.md).

### UnregisteredApplicationReference, UnregisteredRepositoryDependency, UnregisteredUseCaseDependency

> `Post holds User, which is not registered in the application.`

`applicationOf` checks the set as a whole. A record or entity held at any depth, a repository's entity, `relations` and environments, a use case's dependencies, and every command of an output must be registered in the same application (or one it extends). Add the missing one to `entities`, `repositories`, `useCases`, `commands` and so on. See [Applications](applications.md).

### InvalidCommandDeclaration, InvalidOutputStage

`details.reason` says what. Common causes: a `useCases` key that is not an identifier, a pipe with a sink that is not last, `statuses` that is not a map from exception name to a number between 400 and 599, two operations on one route, a path parameter that is not a scalar key of the input. See [Commands](commands.md) and [Outputs](outputs.md).

## Using records and use cases

### UndeclaredRecordProperty

> `Property "extra" is not declared in record "User".`

The value has a key the blueprint does not declare, at any depth (`details.key` is the path, such as `addresses.0.extra`). Records reject it; they never trim it. With `safeParse` it is an issue with code `undeclared_key`, and an output answers 400. Declare the key, or stop sending it.

### InvalidRecordValue, InvalidPropertyValue

> `Invalid value for "address.zip" of record "User": ...`

A value failed its property's rules. `details.key` names the key and `details.issues` has every problem, not only the first. To check input without throwing, use `Class.safeParse(value)`, which gives `{ issues }`. See [Standard Schema](standard-schema.md).

### DeletedEntity

> `Entity "User" of id "..." was destroyed and cannot change.`

You called `set`, `change.<key>` or `destroy()` on an entity that is deleted. After a soft delete, `restore` gives a new, live entity; change that one. See [Entities](entities.md).

### UseCaseAlreadyExecuted

> `A UseCase instance can execute only once.`

An instance runs once, including when it failed, and a second or concurrent `execute` rejects. Build a new instance for each call (`new Register(input).execute()`), or use `app.run(Register, input)`. See [Use cases](use-cases.md).

### InvalidUseCaseDependencies

The overrides given to `execute` name a dependency the use case does not declare, give the wrong kind of value for one (a function for a use case, an object of methods for a repository), or a dependency was called after `execute` ended (do not keep a dependency function in a variable that outlives the call). See [Use cases](use-cases.md) and the [recipe](recipes/override-repository-method.md).

### RepositoryUsedOutsideApplication

> `"UserRepository" is bound to the application "blog", and its declaration no longer reads or writes: use app.repositories.Users, run its use cases with app.run, or give the repository of the application to execute.`

An application with a provider bound the repository, so the module-level one refuses to read another store. Call `app.repositories.Users`, `app.run(UseCase, input)` or `new app.useCases.UseCase(input)`. In a test, give `execute` the repository of the application. See [Applications](applications.md).

### ApplicationNotStarted

> `No application is started: call await app.start() first.`

Something that needs the started application (`useApplication()`, for one) ran before `await app.start()`. Start it once at boot. `ApplicationAlreadyStarted` is the opposite: another application is the started one; use `start({ replace: true })` in tests that create several.

### ProviderNotBound

> `The provider "db" is made by an application: register its storage in applicationOf({ providers }) and call the repository through the application.`

A repository that uses a provider made with `providerFrom` was called outside an application. Register the storage in `applicationOf({ providers })` and call through `app.repositories`.

## Repositories

### RepositoryUniqueViolation

> `"UserRepository" already holds an entity with this "email".`

A `create` or `update` would give an entity a value of a unique key that another entity holds, soft-deleted ones included. `details.key` names the key. An output answers 409. Catch it with `error instanceof RepositoryUniqueViolation` or `error.is(RepositoryUniqueViolation)`. See [Repositories](repositories.md).

### RepositoryEntityNotFound

No entity has the id, or it is soft-deleted or expired. An output answers 404.

### RepositoryConcurrencyConflict

> `"DocRepository" holds another version of "..." than 2: it changed since it was read.`

The entity is `versioned` and someone wrote it between your read and your `update`. Read it again and retry, or report the conflict (an output answers 409). See [Entities](entities.md#versioned-entities).

### InvalidRepositoryCursor

`findCursor` got an `after` that is not a cursor it gave, or one made for another `orderBy` or `where`. Pass back the `next` of the page before, with the same query. An output answers 400. See the [cursor recipe](recipes/cursor-pagination.md).

### InvalidRepositoryQuery

A query the repository cannot run: for example a sensitive key as an order of a cursor. `details.reason` says which.

## Environment and startup

### InvalidEnvironment, InvalidApplicationEnvironment

> `Invalid environment variables: DATABASE_URL, PORT.`

A variable is missing or its value is rejected by the blueprint of the environment. `environmentOf(...).load()` throws `InvalidEnvironment` with the keys; `await app.start()` reports every environment at once as `InvalidApplicationEnvironment`, with `details.environments` (`{ Database: ["DATABASE_URL"] }`). Set the variables, or give `environmentOf(blueprint, { source })` another source. Variables are converted to numbers and booleans when the property is one, so `PORT: ctx.integer` reads `"3000"`. See [Environments](environments.md).

### SchemaLockMismatch

> `The application does not match its schema lock: ...`

`app.start({ lock })` found that an entity changed since `afora.lock.json` was written, in a way that needs a declaration (`fill`, `renamedFrom`, `previousNames`, an `upgrade` step). `details.problems` lists each. Declare what the change needs, then refresh the lock with `afora-codegen schema lock`. `afora-codegen schema check` runs the same check in CI and prints a stub for each missing step. See [Schema evolution](schema-evolution.md) and [CLI](cli.md#afora-codegen-schema).

### PasswordHasherRequired

> `No password hasher is available: this runtime has neither Bun.password nor native argon2 (node:crypto, Node >= 24.7). Call configure({ hasher }) with your own PasswordHasher.`

`Password` hashes with argon2id and the runtime has none. Call `configure({ hasher })` at startup with `hash`, `verify` and, if you use `verifySync`, `verifySync`. `SyncVerifyUnsupported` means the hasher you configured has no `verifySync`; use `verify`. See the [README](../README.md#install).

## Access and HTTP

### Unauthenticated, Forbidden

A use case with an `access` was called without a caller (401), or by one who lacks a scope or is not the owner (403, `details.reason` is `"scope"` or `"owner"`). A sink that has no authentication configured passes no principal, so it answers 401 on every operation with an `access` other than `public`: configure the sink's `auth`. See [Access](auth.md).

### A 400 with `undeclared_key`, or a body that is rejected

The HTTP sink validates the body with the blueprint, so extra keys are rejected. The body of the response has `issues` with `path`, `code` and `message` (no values). A 500 hides its detail unless the sink has `debug: true`.

## Issue codes of `safeParse`

`required`, `invalid_type`, `invalid_value`, `undeclared_key`, `too_few_items`, `too_many_items`, `not_record`. They are part of the contract, and a new one is additive: keep a fallback for codes you do not know. See [Standard Schema](standard-schema.md).

## afora-codegen and afora-mcp

Each problem of a spec prints as `path: [code] message`, then `N problems.`, and the exit code is 1. The full list of commands is in the [CLI reference](cli.md); these are the codes that surprise people.

| Code or message                                                       | Meaning and fix                                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outside_project`                                                     | A path in the spec (`extends`, an `import`, a module of a catalog) is absolute, a URL, or climbs out of the project directory. Use a path relative to the project, inside it, or a package.                                      |
| `import_cycle`                                                        | The generated files would import each other in a loop through a hand-written module that holds several classes or functions. Move the class or function to a module of its own.                                                  |
| `file_collision`                                                      | Two use cases would be generated as the same file name, ignoring case. Rename one.                                                                                                                                               |
| `unknown_provider`, `unknown_stage`, `unknown_event_policy`           | The spec names a provider, stage or event policy that is not in the catalog. Pass the catalog with `--providers`, `--stages` or `--policies`, or fix the name. `inMemory`, `select`, `openapi` and `publishEvents` are built in. |
| `stage_kind_mismatch`, `sink_not_last`                                | A transform where a sink is expected, or a sink that is not the last stage of a pipe.                                                                                                                                            |
| `unknown_exception`                                                   | A `statuses` or `errors` entry names an exception that is neither declared in the spec nor exported by `@afora/core`.                                                                                                            |
| `refused <path>: exists and does not start with the generated banner` | `generate` will not overwrite a file you wrote. Move it, or delete it if it is stale; generated files carry a banner and are rewritten freely.                                                                                   |
| `refused <path>: resolves outside the project (symlink)`              | Generated paths stay inside the project and are never symbolic links.                                                                                                                                                            |
| `<file> does not export an application named <Name>`                  | `extract` and `schema` take `<file.ts>#ExportName` and the export must be an application (it has `describe()`).                                                                                                                  |
| `extract needs <file.ts>#ExportName`                                  | The `#Export` part is missing.                                                                                                                                                                                                   |
| `<file> does not exist: write it with afora-codegen schema lock`      | `schema check` with no lock file. Run `schema lock` once and commit `afora.lock.json`.                                                                                                                                           |
| `Not written: declare what the changes need, or pass --force.`        | `schema lock` refused to replace a lock over a change that needs a `fill`, `renamedFrom`, `previousNames` or `upgrade` step. Add it, or pass `--force` if you mean it.                                                           |

The `afora-mcp` tools return the same issues, and a write that would leave the spec invalid writes nothing. Everything it writes stays inside `--project`.

## Running on Node, and the build

**`ERR_MODULE_NOT_FOUND`, or `Cannot find package 'typebox'`.** TypeBox `^1` is a required peer dependency; install it next to `@afora/core` (`npm install @afora/core typebox`).

**`require("@afora/core")` fails.** The package is ESM only, with `"type": "module"` and an `exports` map that has `import` and `default` conditions. Use `import`, or `await import("@afora/core")` from CommonJS.

**TypeScript says it cannot find `@afora/core/adapters` or another subpath.** The subpaths are resolved through `exports`, so the project needs `"moduleResolution": "bundler"` or `"nodenext"` (TypeScript >= 5.5). The old `node10` resolution does not read `exports`.

**`SyntaxError: Invalid or unexpected token` on `@Route` or `@Access`.** Node has no decorator syntax yet. Compile with `tsx` or another compiler, or declare the same thing as `route:` and `access:` in the settings of `useCaseOf`, which needs no decorator. See [Use cases](use-cases.md#routes).

**`afora-codegen extract` fails on a `.ts` file on Node.** `extract` imports your file: use Bun, or Node >= 23.6 for TypeScript files. `check` and `generate` read JSON and run on Node >= 22.

**A table or collection stops matching after bundling.** A bundler that minifies renames classes, so a key made from `Entity.name` changes. Declare the name with `entityOf(blueprint, { name: "User" })` and key by `recordNameOf(entity)`. See [Records](records.md).

## Still stuck

Search the [Discussions](https://github.com/afora-framework/core/discussions) or open an issue with the exception printed by `error.toString()` and a short reproduction.
