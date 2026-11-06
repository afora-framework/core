# T22: Output: operation descriptors, pipes and stage catalogs

T23 implements the core of Output, T24 the OpenAPI sink, and T25 brings
outputs to `afora.json` and MCP. Adapters (T26 Hono, T28 MCP) are sinks. An
output turns commands into **operations** and runs them through a **pipe** of
stages: transforms change operations, and the last stage, a sink, builds
something concrete (an HTTP app, an OpenAPI document, MCP tools).

## 1. `OperationDescriptor` v1 (frozen in 1.0)

```ts
interface OperationDescriptor {
  readonly kind: "operation";
  readonly version: 1;
  readonly id: string;            // "Users.register"
  readonly command: string;       // "Users"
  readonly name: string;          // "register"
  readonly useCase: string;       // "Register" (useCaseName)
  readonly description?: string;  // use case description, else command description
  readonly tags: readonly string[];      // command tags, then use case tags, deduplicated
  readonly deprecated: boolean;          // use case deprecated
  readonly input: AnyBlueprint;
  readonly response: AnyBlueprint;
  readonly context?: AnyBlueprint;       // the command context, else the use case one
  readonly errors: readonly AnyExceptionClass[];   // use case `errors`
  readonly meta: Readonly<Record<string, unknown>>; // set by transforms, {} initially
  invoke(input: unknown, options?: { context?: unknown }): Promise<unknown>; // command.run
}
```

- Descriptors are frozen. `operationOf(op, patch)` returns a modified copy;
  transforms use it to change `meta`, `tags`, `description`, `deprecated` or
  to wrap `invoke`. `kind`, `version`, `id`, `command`, `name`, `useCase`,
  `input`, `response`, `context` and `errors` cannot be patched.
- New fields only arrive as optional ones; `version` stays 1 for them.

## 2. Declaring an output

```ts
const Api = outputOf({
  name: "Api",
  commands: [Users, Posts],                        // or an application: all its commands
  statuses: { UserAlreadyExists: 409 },            // optional, by exception name
  pipe: [select({ tags: ["public"] }), openapi({ info: { title: "Blog", version: "1.0.0" } })],
});

Api.operations; // OperationDescriptor[] after the transforms, in declaration order
Api.build();    // the sink's result (memoized); throws if the pipe has no sink
Api.pipe(t, s); // a new, unnamed output with more stages (ad hoc), or the sink's result when s is a sink
```

- Validation, which throws `InvalidOutputStage` (layer `Output`) when:
  - `name` is empty;
  - an entry is not a command or an application;
  - two operations share an `id` (`DuplicateOperation`);
  - the pipe holds something that is not a stage, or a sink that is not last;
  - `statuses` is not a map of exception names to integers between 400 and 599.
- The operations are computed once, at declaration. `build()` runs the sink
  lazily, the first time it is called.
- The object is frozen and has `[Kind]: "output"`, `outputName`,
  `operations`, `stages`, `statuses`, `build` and `pipe`. `isOutput(value)`
  tells whether a value is one.

## 3. Stages

Stages are made by **factories**, so that a stage is a name plus JSON options,
as in JSON:

```ts
export const select = transformOf({
  name: "select",
  apply: (operation, options: { tags?: string[]; operations?: string[]; exclude?: string[] }) =>
    keep(operation, options) ? operation : null,        // null removes it
});
export const openapi = sinkOf({
  name: "openapi",
  build: (operations, options: OpenAPISinkOptions, output) => document,
});

select({ tags: ["public"] });   // a TransformStage { kind: "transform", name: "select", options }
```

- `transformOf({ name, apply })` and `sinkOf({ name, build })` return
  factories `(options = {}) => Stage`. The options must be JSON, validated as
  in `providerOf` (no functions, cycles or non-finite numbers), and frozen.
  `apply(operation, options, context)` returns an operation or `null`.
  `build(operations, options, context)` returns anything. `context` is
  `{ output: { name, statuses } }`.
- A stage carries its descriptor out of band, in a WeakMap, as providers do:
  `stageDescriptionOf(stage)` returns `{ kind, name, options }` or
  `{ kind: "opaque" }`. A stage made with `transformOf`/`sinkOf` always has a
  name. A hand-written object of the stage shape is opaque: it is accepted
  at runtime, and extraction needs an import mapping.
- **Catalogs**: `stageCatalogOf(...factories)` resolves `name` → factory, as
  `recordPluginCatalogOf` does for plugins. `StdStages` holds the built-ins:
  `select` (T23) and `openapi` (T24). Adapters export their factories and,
  for codegen, catalog entries `{ name, module, export }`, as providers do.

## 4. Errors at the boundary

- `statusOf(error, operation?, statuses?)` returns an HTTP-style status:
  1. `statuses[error.name]`, when given;
  2. 400 for invalid input or context: `InvalidUseCaseInput`,
     `InvalidUseCaseContext`, `InvalidCommandContext`, and any exception
     whose `details.issues` is an array;
  3. 404 for `RepositoryEntityNotFound` and `UnknownCommandOperation`;
  4. 409 for `RepositoryUniqueViolation`;
  5. 422 for an exception class listed in `operation.errors`;
  6. 500 for anything else, non-`Exception` errors included.

  Exceptions are matched by class where one is exported, and by `name`
  otherwise. `CommandEventFailed` is 500: the call committed, but the
  response cannot claim success.
- `problemOf(error, { status, debug? })` returns an RFC 9457 object:

  ```json
  { "type": "urn:afora:exception:UserAlreadyExists", "title": "UserAlreadyExists",
    "status": 409, "detail": "A user with this email already exists.", "layer": "use-case",
    "issues": [{ "path": ["email"], "code": "invalid_value", "message": "..." }],
    "trace": "..." }
  ```

  - `issues` is present only for 400s, with `path`, `code` and `message`
    only (no `cause`, no values).
  - `trace` (`exception.toString()`) is present only with `debug: true`.
  - A 500 has the `detail` `"Internal error."` unless `debug` is set, so
    internal messages do not leak.
  - The media type is `application/problem+json`, exported as
    `PROBLEM_MEDIA_TYPE`.
- `outputValueOf(value)` is the JSON a sink sends: `JSON.parse(JSON.stringify(value))`.
  Every record goes through its `toJSON`, so **sensitive values are always
  masked**. Every sink must use it, and a test asserts it for each sink.

## 5. Applications

`applicationOf({ outputs: { Api } })`:
- the key must equal `outputName` (`InvalidApplicationDeclaration`);
- every command must be registered (`UnregisteredApplicationReference`).

With a provider, `app.outputs.Api` is rebuilt over the application-bound
commands, and memoized. `describe()` gains:

```ts
outputs: Record<string, {
  from: string; name: string;
  commands: readonly string[];
  statuses: Readonly<Record<string, number>>;
  pipe: readonly ({ kind: "transform" | "sink"; name: string; options: JsonObject } | { kind: "opaque" })[];
}>;
```

## 6. JSON (T25)

```json
"outputs": {
  "Api": {
    "commands": ["Users", "Posts"],
    "statuses": { "UserAlreadyExists": 409 },
    "pipe": [
      { "transform": "select", "options": { "tags": ["public"] } },
      { "sink": "hono", "options": { "basePath": "/api", "docs": { "path": "/openapi.json" } } }
    ]
  }
}
```

```ts
import { hono } from "@afora/hono";
export const Api = outputOf({
  name: "Api", commands: [Users, Posts], statuses: { UserAlreadyExists: 409 },
  pipe: [select({ tags: ["public"] }), hono({ basePath: "/api", docs: { path: "/openapi.json" } })],
});
```

- The stage catalog is a codegen option, like the provider catalog:
  `--stages <module>` on the CLI and `ServerOptions.stages` in MCP.
  `StdStages` is built in.
- An opaque stage is `{ "import": "./stages.ts#auth" }`. On extraction it
  maps through `imports` with the key `outputs.Api.pipe.<index>`.
- An empty `statuses` is the default, and normalization drops it.

## 7. Types and budget

- `outputOf` infers nothing deep: operations are runtime descriptors, so
  sinks are typed by their options and result only (`SinkStage<Result>`,
  with `build(): Result`).
- Add a sandbox case and measure with `bun run test:type-perf`. A snapshot
  change is a stop-and-report point.

## 8. Files and tests (T23)

Files: `src/core/output/output.ts`, `stage.ts`, `select.ts`, `status.ts`,
`problem.ts`, `exceptions.ts` (`InvalidOutputStage`, `DuplicateOperation`,
recognized by `isExportedException`), `types/output.interface.ts` and tests.

The tests cover:
- the descriptors built from commands and from an application;
- the patch rules;
- transforms that remove and patch operations;
- the sink being last;
- `build` memoization;
- `pipe`;
- the stage descriptions and catalogs;
- every branch of the `statusOf` table, including overrides;
- `problemOf` with and without debug, and the 500 detail hiding;
- `outputValueOf` masking a `Password` at depth;
- `applicationOf` validation, binding and `describe()`.
