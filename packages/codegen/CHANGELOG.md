# Changelog

## Unreleased

### Added

- `logout` takes `owner` and `token`, and `changePassword` takes `token`; the description of the `token` option covers `versionFrom` (a required, integer, sensitive key in the `change` list) and `rotate` (#193, #215).
- `register` takes `takesTokenKeys: true`, accepted only with an `access` that asks for `scopes` (#216).

## 27.0.0-rc.6 — 2026-11-24

### Security

- **Breaking.** `resolveExtended(..., { root })` looks up a package named by `extends` in the `node_modules` of `root` only (and of its directories, as Node would, but never above `root`, in a package cache or the registry), and its spec, with what that spec extends, must really be inside `<root>/node_modules`, or `SpecLoadError` is thrown. `loadSpec` resolves a package as before. (SEC-54)
- With a root, the messages of `resolveExtended` name a file from the root, never by an absolute path. (SEC-55)

### Fixed

- `generate` writes a key of a free-form JSON value (the options of a stage) as a shorthand property only when it is an identifier, so `{ "200": 200, "true": true }` prints as `{ "200": 200, true: true }` and the generated module parses. (SEC-56)

## 27.0.0-rc.5 — 2026-11-24

### Security

- `generate` trims the end of each printed line in linear time. (SEC-31)
- `output.dir` is relative on every platform: `validateSpec` gives `invalid_output` for one that starts with `/` or `\` (a root or UNC path) or with a drive (`D:`), `resolveExtended` refuses an extended spec with such an `output.dir`, and `confinePath` (so `writeGenerated`) holds a path on another Windows drive outside the project. (SEC-39)
- `loadSpec` and `resolveExtended` report a spec file that is not valid JSON by its path (with a line and column when the runtime gives the offset), never with the parser's message, which could quote the file. (SEC-33)

### Fixed

- The file name of a use case kept in its own file (`register-user.use-case.ts`) is made in linear time for a name with a long run of capitals; the names are the same as before.
- `projectBoundaryIssues`, `resolveExtended` and `confinePath` refuse `node_modules` and `.git` in the spellings Windows reads as them too: with trailing dots or spaces, with a stream suffix (`:...`) and as a short name (`NODE_M~1`, `GIT~1`), on every platform. (SEC-40)
- `extractSpec` no longer drops the hooks of a sink (#199): a stage whose description has `hooks: true` (as `hono(options, { authenticator })`) throws an `ExtractionError` naming `outputs.<Name>.pipe.<index>` until it is mapped in `imports` (`--import` in the CLI), and is then written as `{ "import": "..." }`. It was written as `{ "sink", "options" }` before, so the generated code had no authenticator and no middlewares, and the mapping was ignored.

## 27.0.0-rc.4 — 2026-11-16

### Security

- `generate` trims the trailing `/` of `output.dir` in linear time; the regular expression it went through took seconds on a long run of `/` not at the end. The trailing `/` of an `import` module is trimmed without a regular expression too (that one was not reachable: the module is normalized first).

## 27.0.0-rc.3 — 2026-11-16

### Security

- A relative `{ "import" }` or `extends` is refused (`outside_project`) when any file a runtime may load for it (`x`, `x.ts`…`x.json`, `x.ts` for `x.js`, `x/index.*`, the entry points of `x/package.json`, `x/afora.json` for an `extends`) is a symbolic link that leaves the project; `resolveExtended(..., { root })` also checks the real path of each spec file it reads. (SEC-05)
- `boundaryIssues` (run by `resolveExtended` on each spec it reaches by a path) refuses an `output.dir` that is absolute, has a `..` or leaves the project. (SEC-06)
- `output.dir` in a folded spelling of `node_modules` or `.git` (`node_moduleſ`, fullwidth letters, combining marks) is `outside_project`; `confinePath` refuses paths in `node_modules` or `.git`, so `writeGenerated` refuses the file. (SEC-17)

### Added

- The standard use cases of `@afora/core` take new options, and a spec can declare them: `changePassword` (`as`, `owner`, the hooks), `relations` on `create` and `register`, `maxLimit` on `list`, `owner` on `restore`, and `owner.key: "id"`.
- `validateSpec` refuses at declaration what the core refuses: `owner.key: "id"` on `create`/`register`, `restore` with `owner` without the `exists` action, a `maxLimit` that is not a whole number of at least 1, a malformed `relations` (`invalid_generic_option`); an `update` whose change keys are all sensitive, or whose owner key is one of its change keys (new code `generic_unavailable`).

## 27.0.0-rc.2 — 2026-11-16

A candidate of 27.0.0, with no changes since 27.0.0-rc.1. See the [root CHANGELOG](../../CHANGELOG.md).

## 27.0.0-rc.1 — 2026-11-16

The first release candidate of 27.0, with the API of 0.0.13; it needs `@afora/core >=27.0.0-rc.1`. See the [root CHANGELOG](../../CHANGELOG.md).

## 0.0.13 — 2026-11-16

### A status chosen at run time (#116)

- A use case route takes `"statuses": [503]`, the other statuses its `execute` may choose with `withStatus` (in hand-written code, or in the function of a `run` step): checked as `useCaseOf` checks it (`invalid_route` for a status that is not a 2xx with a body, a 4xx or a 5xx, for 204, 205, 400, 500, a duplicate or the route `status`), generated and extracted back. `afora.schema.json` has it.

### File fields (#118)

- A field or a property declaration `{ "file": { "types": ["image/png"], "maxBytes": 5000000 } }` (and the Std `"file"`), generated as `ctx.fileOf(...)` / `fileOf(...)`, extracted back and checked (`invalid_file`; not an environment variable); `afora.schema.json` has it. New types `FileField` and `FileOptionsSpec`. An entity holding a file is `entity_file`, a sensitive or unique file `invalid_file`.

### Serial ids (#122)

- An entity takes `"id": "serial"`, a positive integer the database assigns on `create`, generated as `{ id: Serial }` and extracted back; `afora.schema.json` has it.

### Security: the project boundary (#69)

- `projectBoundaryIssues` reports `outside_project` for the specifiers that escaped it: a package path with a `.` or `..` segment (`pkg/../../../x`, which resolves from `node_modules/pkg` to outside the project, for an `import` and for an `extends`), a backslash or a percent-encoded character in any module (Node and Bun resolve an import as a URL, so `./a\..\..\x` and `./%2e%2e/x` climb out although `path.resolve` keeps them inside on POSIX), control characters, a module built into the runtime (`child_process`, `fs`, `bun`: a `run` step could call `execSync`), a relative module or `extends` that goes through a symlink leaving the project, and an `output.dir` in `node_modules` or `.git`.
- A relative module is also resolved as the URL a runtime loads, and must land inside the project: a `?` or `#` in a module is refused (`../../../evil.ts?/../project/x.ts` is a folder to `path.resolve` and `../../../evil.ts` to Node and Bun). The `node_modules` and `.git` check of `output.dir` ignores case (`Node_Modules`, `.GIT`) and also applies to where a symlinked `output.dir` really is.
- `resolveExtended(spec, file, { root })`: with `root`, each spec reached by a path, at any depth, must pass the boundary check from its own directory (its `extends`, `import`s and `output.dir`), or `SpecLoadError` is thrown before what it extends is read. A spec reached as a package is not checked.
- `generate` writes a `__proto__` key of a JSON value (a provider's options, say) as the computed key `["__proto__"]`, so it stays an own property, as `JSON.parse` gave it, instead of setting the prototype of the object.

### A list as the response (#117)

- The `response` of a use case written in the spec can be a list field: `"Article[]"`, `{ "type": "Article", "list": { "maxItems": 50 } }`, `"string[]"` or `{ "fields": {...}, "list": true }`, generated as `listOf(...)` and extracted back from `describe()` (`responseList`). It must be a list, not optional, and not of variants (`invalid_blueprint`); a `route.setCookie` with it is `invalid_route`. `afora.schema.json` describes it.

### Services (#115)

- A top-level `"services": { "cache": { "import": "../services.ts#cache" } }` names the factory of each service of the application, generated as `applicationOf({ services })`. A use case names one in its `dependencies` (`{ "cache": "cache" }`), generated as `serviceOf<Awaited<ReturnType<typeof cache>>>("cache")`, with the factory imported by `import type`, so a hand-written `execute` reads it typed by what the factory returns. One inherited from a spec extended by a relative path, or whose factory comes from a package, is typed the same; one whose factory cannot be imported from the child (relative to a spec reached as a package, or of a nested extended spec) is `unknown`. Issues: `invalid_services`, `invalid_name` (also for a service named `Logger`), `duplicate_name` (a service named like a declaration) and `invalid_import`. `extractSpec` needs `imports["services.<name>"]`. `afora.schema.json` describes it.

### Imported use cases as dependencies (#64)

- **Breaking.** A use case implemented by `{ "import" }` can be a dependency of another use case, and a steps use case can `call` it; the `import_dependency` issue is gone. Each use case that hand-written code needs (the `<Name>Base` of every `import` use case, and every steps use case such a class depends on) is generated in its own `<kebab-name>.use-case.ts` in `output.dir`, which never imports `use-cases.ts`; `use-cases.ts` re-exports it. A handler imports its base from that file (`import { RegisterBase } from "../domain/register.use-case"`); importing it from `use-cases.ts` keeps working only as long as no other use case (steps or `import`) depends on that handler: the dependent's `<kebab-name>.use-case.ts` imports the handler, the handler imports `use-cases.ts`, and `use-cases.ts` re-exports the dependent's file, a loop of imports that can reach the handler before its class is defined. The validator does not read handler code, so it cannot report this.
- New issues: `import_cycle`, a hand-written module that would import itself back through the generated files, and `file_collision`, two use cases that would get the same file name (file names are lowercase kebab-case, so `GetURL` and `GetUrl` collide), and `generated_file`, an `{ "import" }` (or the `import` of an opaque property) whose module, resolved from `output.dir`, is a file the generator writes there (one of `GENERATED_FILES` or an emitted `*.use-case.ts`). `writeGenerated` removes stale `*.use-case.ts` files that carry the generated banner, and refuses a file without the banner whatever its name, with a reason that names it and says to rename it. `import_cycle` treats `../handlers/all`, `../handlers/all.js` and `../handlers/all/index.ts` as one module.

### Tracing (#65)

- `"trace": { "import": "./trace.ts#tracer" }` at the top level of a spec is the tracer of the application (`otelTracer()` of `@afora/otel`, say), generated as `applicationOf({ trace })`. Anything but an import is `invalid_trace`. `extractSpec` needs `imports.trace` for an application with a tracer, which `describe()` gives as opaque. `afora.schema.json` describes it.

### `params` on a `run` step

- A `run` step of `afora.json` may declare `"params"`, a blueprint by name or `{ "fields": {...} }` whose fields match its `args` by position, so the args are checked before the function runs (see `docs/use-cases.md#steps` of `@afora/core`). `validateSpec` and `afora-codegen check` resolve it like the `input` of a use case and report `invalid_args` when a list of args has another length; `generate` emits it as a blueprint; `extractSpec` gives it back by its fields, and `normalizeSpec` compacts them. `afora.schema.json` has it. Needs the `@afora/core` that reads `params`.

### Project boundary (#69)

- `projectBoundaryIssues(spec, root)`: the places where a spec reaches outside a project directory, as issues `outside_project`: an `{ "import": "<module>#<name>" }` whose module is a file outside it (resolved from `output.dir`), an absolute path or a URL, and an `extends` outside it. For tools that take a spec from someone they do not trust; `validateSpec` does not run it, since a spec has no directory of its own. `@afora/mcp` runs it on every spec.

### Routes and access (#75, #60)

- A use case takes `"route"` (`{ method, path?, status?, query?, headers?, cookie?, setCookie? }`) and `"access"` (`{ public: true }` or `{ scopes?, owner?, context? }`), in a written use case and beside `"generic"` in a standard one. They are generated as the `route` and `access` settings of `useCaseOf` (options of a standard use case; no decorators are written) and extracted back from `describe()`, whether the class used the settings or `@Route` and `@Access`. `afora.schema.json` describes both.
- Validation: `invalid_route` and `invalid_access` for a malformed declaration and, in a written use case, for a key that is not in the input, the response or the context, or that a route reads from two places.
- The catalog lists the standard `refresh` and `logout`, and `token` among the options of `login`.

### Schema evolution (#28)

- Fields take `"fill"` and `"renamedFrom"` in the object form of a type or enum field (not a list), generated as options of `with` (`ctx.enumOf([...]).with({ fill })`, `ctx.text({ renamedFrom })`) and extracted back to the field level from `describe()`; an enum refined only with them is no longer opaque. Entities take `"schemaVersion"`, `"upgrade"` (`{ "<n>": { "import": "./upgrades#toV2" } }`, generated as imported bindings; extraction needs `entities.<Name>.upgrade.<n>` in `imports`) and `"previousNames"`, in `afora.schema.json` too. Invalid values are `invalid_option`, `invalid_import`, `invalid_field` or `invalid_enum`. Generated code with them needs the `@afora/core` that has schema evolution.
- CLI: `afora-codegen schema lock <file.ts>#App [--out afora.lock.json] [--force]` writes the schema lock of the application, refusing a change that lacks its declaration or version bump unless `--force`; `afora-codegen schema check <file.ts>#App [--lock afora.lock.json]` fails when the lock is stale, a declared change is unsatisfied, an entity of the lock is gone without `previousNames`, or a `schemaVersion` went down, and prints an `upgrade` stub for each missing step.

### Optimistic concurrency and atomic increment (#44, #34)

- An entity takes `"versioned": true`, generated as `entityOf(..., { versioned: true })` and extracted back from `describe()`. Its identity has `version`, so a field `version` is `identity_key` and `change: ["version"]` is `change_identity`; on a record it is `unknown_key`, and a value that is not a boolean is `invalid_option`.
- `increment` is a repository action, listed in `catalog().repositoryActions` and `afora.schema.json`; it needs a number key in the entity's `change` (`increment_needs_number`), and a `find` step cannot call it (`write_in_find`). The generated code needs the `@afora/core` that has it.

### Added

- Records that expire (#35): `"expires": { "after": { "days": 400 } }` or `{ "at": "<a dateTime or date field>" }` on an entity, generated as the `expires` option of `entityOf` and extracted back from `describe()`. New issue `invalid_expires`; with `after`, a field named `expiresAt` is `identity_key`. New type `EntityExpiresSpec`. Generated code with `expires` needs the `@afora/core` that has records that expire.
- Entity events in the spec: `"events": { "onCreate"?, "onUpdate"?, "onDelete"? }` on an entity, each an event name or `{ name, handler: { import } }` (or a list), generated as `export const <Name>Events = { ... eventOf(...) }` with the lifecycle options of `entityOf`, and extracted back from `describe()` (`entities.<Name>.events.<event>` in `imports` for a handler). New issues `invalid_event` and `event_conflict`; `name_collision` when a declaration takes `<Name>Events`.
- Event policies in the spec: a command's `events` may be `{ "policy": name, "options"?: {...} }`, generated as the call of the factory (`publishEvents({...})` from `@afora/core`, or the export of a policy of the `policies` option) and extracted back from `describe()`. The top-level `publishers` (`{ key: { "import": "./realtime.ts#hub" } }`) becomes `applicationOf({ publishers })`, and extraction needs `publishers.<key>` in `imports`. New issues `unknown_event_policy`, `invalid_event_policy_options`, `unknown_publisher`, `invalid_publishers` and `invalid_policy_catalog`; `catalog().policies`; the `policies` option and the `--policies <module>` flag; the types `EventPolicySpec` and `EventPolicyCatalogEntry`. Generated code with a policy needs the `@afora/core` that has event policies.
- Standard use cases that write take `before` and `after` (`{ "import": "./file.ts#function" }`), `dependencies` (key -> a declared use case, repository or environment, or `"Logger"`) and `throws` (exception names, or `{ "core": "Name" }`) in their `options`: validated (`invalid_generic_option`, `invalid_import`, and the dependency issues of a written use case), generated into the options of the `StdUseCases` call with the functions imported, and extracted back (`useCases.<Name>.before` and `.after` in `imports`). `catalog().useCases` lists them; `catalog().factories` says how `jsonOf` is written, and `"json"` is a Std field type.

## 0.0.1 — unreleased (draft: dated when it is published)

### Changed

- `Spec.useCases` holds `UseCaseSpec | GenericUseCaseSpec`. Each has the keys of the other as optional `undefined`, so reading `spec.useCases.Register.input` still type-checks, now possibly `undefined`.
- `findCursor` is accepted in the `actions` of a repository and as the action of a `find` step, listed in `catalog().repositoryActions` and in `afora.schema.json`. The generated code needs `@afora/core` 0.0.6 or later.
- Records and entities are generated with their declared name, `recordOf(blueprint, { name: "User" })` and `entityOf(blueprint, { name: "User" })`, so the name a provider keys its storage by does not depend on the class name, which bundlers rename. The generated code needs `@afora/core` 0.0.6 or later.

- TypeBox (`^1`) is a required peer dependency, shared with `@afora/core` and the generated application's own schemas.
- Record and entity fields may now be named `blueprint` and `options`, following the core's move of instance metadata to `Meta`. Covered by generation, persistence and extraction round trips; the spec shape is unchanged.

### Added

- Standard use cases in `afora.json`: `{ "generic": "create", "repository": "Posts", "options": {...} }` declares a use case of `StdUseCases` made for a repository, generated as `export const CreatePost = StdUseCases.context.create(Posts, {...})` and extracted back as written, with no import to map. `catalog().useCases` lists them (`GenericUseCaseInfo`: `actions`, `plugins`, `options`), and the validator reports `unknown_generic`, `unknown_repository`, `generic_requires_action`, `generic_requires_plugin` and `invalid_generic_option`. Also exported: `GenericUseCaseSpec`. Requires `@afora/core` 0.0.7 or later.
- The `restore` repository action (`restore_needs_soft` without `"deletion": "soft"`) and the `restore` step; `ifPresent` on a `change` step; `args` as one `$reference` to a list.

- `commands.<Name>.environments`: the environments of a command, checked like those of a repository (`unknown_environment`, `duplicate_environment`, `invalid_option`), generated as `environmentDependencies`, dropped when empty by normalization, and extracted back from `describe().commands`.
- Round-trip suite of complete applications, `tests/roundtrip` (`bun run test:roundtrip`): three specs that use every feature (extending another spec included) go JSON -> app -> JSON and keep the same normalized spec after type-check, Biome and a behavioral run, and two hand-written applications go app -> JSON -> app with the same behavior functions passing on the original and on the generated code.
- `commands` and `outputs` in the spec. Commands `{ description?, tags?, context?, useCases, transaction?, events?, onEventError? }` and outputs `{ commands, statuses?, pipe }` are validated (stable codes such as `unknown_use_case`, `invalid_operation`, `invalid_events`, `event_error_requires_after_commit`, `unknown_command`, `unknown_stage`, `stage_kind_mismatch`, `sink_not_last`, `invalid_stage_options`, `invalid_status`; `transaction` is checked when the code runs), normalized (defaults dropped), generated as `commands.ts` (`commandOf`) and `outputs.ts` (`outputOf`) and registered in `application.ts`, and extracted from `describe().commands` / `describe().outputs` (`imports` keys `commands.<Name>.events`, `commands.<Name>.onEventError`, `outputs.<Name>.pipe.<index>`, else `ExtractionError`). New types `CommandSpec`, `OutputSpec`, `PipeEntrySpec`, `StageCatalogEntry`.
- Stage catalog: `stages` in the `validateSpec` / `generate` options (`{ name, module, export, kind? }`, like `providers`), `--stages <module>` in the CLI and `catalog().stages` for the built-in `select` and `openapi` of `StdStages`.
- Extraction names the registered blueprints a use case or command uses as `input`, `response` or `context` (`"input": "RegisterInput"`) from the new `refs` of `describe()`, and keeps inline `fields` for the ones that are not registered.
- `exceptions` and `useCases` in the spec (the v1 rejection of `useCases` is gone): exceptions `{ layer, message? }`, use cases with metadata, `input`/`response`/`context` (blueprint name or inline `fields`), `dependencies`, `errors` (declared or core exceptions, listed by `catalog().exceptionLayers` / `coreExceptions`) and an `implementation` that is `{ steps }` (the T15 DSL, validated with the core's codes plus `unknown_exception`, `unknown_blueprint`, `invalid_import`, `import_dependency`) or `{ import }` (generated `<Name>Base` that the hand-written class extends). Generated as `exceptions.ts` and `use-cases.ts` and registered in `application.ts`; extracted from `describe()` (`imports` keys `useCases.<Name>` and `useCases.<Name>.run.<name>`, else `ExtractionError`); normalized (default `tags`, `deprecated` and message dropped). An exception whose message is a function is extracted without `message`.
- `provider` in the spec, at the application and per repository: `"inMemory"`, `{ "use", "options" }` or `{ "import": "./file.ts#name" }`, with `{ "import" }` references nested in the options. Validated (`unknown_provider`, `invalid_provider`, `invalid_import`, `invalid_provider_catalog`), normalized (`"inMemory"` is `{ use: "inMemory", options: {} }`; an omitted provider is never a shared one), generated (`provider:` in `applicationOf` / `repositoryOf`, named imports) and extracted from `describe()`. External providers are a codegen option, `{ providers: [{ name, module, export }] }`, accepted by `validateSpec(spec, extended, options)` and `generate(spec, extended, options)`; the CLI takes `--providers <module>`. An opaque provider needs `imports` (`provider`, `repositories.<Name>.provider`; CLI `--import key=./file.ts#name`) or extraction throws `ExtractionError`.
- Repository actions `findMany`, `exists` and `findPage` in the spec, schema, validation, generation and extraction.
- Repository `deletion: "hard" | "soft"` in the spec, schema, validation (`invalid_deletion`), generation and extraction. Normalization omits the default `hard`; round trips preserve soft deletion behavior.
- First version. `afora.json` (version 1): `properties` (`base` + `with`, `enum`, `opaque` imports), `blueprints`, `records`, `entities`, `environments`, `repositories`, `extends` and `output.dir`; `useCases` is reserved. Fields in shorthand (`"Age?"`, `"string[]"`) or object form.
- `validateSpec(spec, extended?)`: issues with `path`, `code` and `message` for unknown references, name collisions, cycles, reserved and identity keys, `unique`/`sensitive`/`change`, plugins, repository actions and relations, and `with` options.
- `generate(spec, extended?)`: deterministic, Biome-clean files (`properties`, `blueprints`, `records`, `entities`, `environments`, `repositories`, `application`, `index`) using only the public API of `@afora/core`.
- `extractSpec(app)` and `normalizeSpec`: the inverse of `generate`, from `app.describe()`.
- `catalog()`, read from `@afora/core` at runtime; `specSchema` and `afora.schema.json`.
- `loadSpec`, `resolveExtended`, `writeGenerated` and `confinePath` (writes confined to the project, only files with the generated banner are overwritten or removed).
- `afora-codegen check | generate | extract`.
