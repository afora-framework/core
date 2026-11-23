# Changelog

## Unreleased


### Security

- `findBy<Key>` and `findManyBy<Key>` give no entity for a missing value: `undefined` or `null` gives `undefined` and `[]` without calling the provider, on every provider, including a declarative use case step given an optional input that is absent. See [Repositories](docs/repositories.md). (SEC-20)
- **Breaking.** A standard `register` whose input takes a key that a `login` or `refresh` of the same entity makes its tokens from (`token.scopesFrom`, the keys of `token.claims`) now throws `UseCaseUnavailable` at declaration, whichever is declared first and in whatever command; the key is given by `values` or left out with `omit`. The example of [Tokens and sessions](docs/auth.md#tokens-and-sessions) sets `roles` with `values`. (SEC-22)
- `@afora/codegen` prints a spec string holding a long run of spaces in linear time. (SEC-31)
- `@afora/mcp`: the diagnostics `afora_generate` returns carry the file, line, column, TS code and a message whose literal values and quoted types are redacted (`"…"`, `'…'`; a plain name such as `'ServiceFactory'` is kept), so a type of a project module never brings its values into the answer. (SEC-32)
- A spec file that is not valid JSON is reported by its path (and, where the runtime gives it, a line and column), never with the parser's message, which could quote the file; `@afora/mcp` gives the paths of what a spec extends from the project root. (SEC-33)
- The response of a use case declared by a blueprint or a list (`response: Account.blueprint`, `listOf(...)`, a blueprint holding a `Password`) is sent masked as a record's `toJSON` masks it: every property declared `sensitive` (a `Password` always) at any depth, through nested blueprints, lists and variants, and the keys a record or entity declares `sensitive` where the blueprint is the record's (its `.blueprint` or the blueprint it was declared from). This holds in `outputValueOf` and so in every sink of afora (`http`, `hono`, `express`, `fastify`, `elysia`, `websocket`, `mcpTools`), as [Outputs](docs/outputs.md) promised. A direct call (`execute()`, a dependency) still reads the real values, and a key a route sends with `setCookie` keeps its value. (SEC-19)

### Fixed

- `findBy<Key>` and `findManyBy<Key>` take one value: `{ in: [...] }` throws `InvalidRepositoryQuery` instead of being read as a membership, which only the queries (`findMany`, `exists`, `findPage`, `count`) take. (SEC-21)
- `PlainPassword` and `Password.hash` apply the same password rules to a value with line breaks: the schema pattern of `PlainPassword` looks for each required character across the whole value, as `Password.hash` does.
- `blueprint.safeParse`, `~standard.validate` and the records that parse through them never throw for a value too deep for the stack in a property with a recursive schema: they give an issue at the property's path. (SEC-27)
- `jsonOf` checks the depth of a value (1000 at most, `is nested too deeply`) before its schema walks it, for a recursive schema too, as [Properties](docs/properties.md#json) says. (SEC-28)
- `SchemaProperty` (`ctx.schema`) rejects a schema nested more than 128 JSON levels deep, with an `is nested too deeply` issue at its path, in `safeParse`, the constructor and `deserialize`, so a schema it holds can always be checked against quickly, on Bun, Node and browsers. See [Standard properties](docs/std-properties.md#json-and-schemas). (SEC-29)
- `@afora/ws`: a session holds at most 1000 topics. Past the limit a new subscription is a 403 `WsTopicForbidden`, the answer to a topic that is not allowed; a topic the session already holds does not count twice, and unsubscribing frees a place. See [the ws README](packages/ws/README.md#protocol). (SEC-30)
- `jwtOf`: a scope is a scope token (RFC 6749): `sign` rejects with `InvalidJwtOptions` a scope that is empty or holds a space or a control character, so the scopes a token is verified with are the ones it was signed with. The option `token` of `login` and `refresh` throws `UseCaseUnavailable` for such a fixed scope, and `login` gives no token to an entity that holds one. See [Access](docs/auth.md#tokens-and-sessions). (SEC-23)
- `jwtOf`: `sign` leaves out of the token a claim named like a registered one (`sub`, `scope`, `iat`, `exp`, `nbf`, `iss`, `aud`, `use`), so `issuer`, `audience` and `use` come only from the options; the option `token.claims` of `login` and `refresh` throws `UseCaseUnavailable` for such a name. (SEC-24)
- `jwtOf`: `verify` accepts a signature only in the base64url encoding `sign` gives (no padding, no other unused bits), so a token has one valid form. (SEC-25)

### Repository

- The Release workflow sets `coreVersion` in afora CMS's `site-values` entry after a release that npm serves as `latest` (once its tag and GitHub release exist), so getafora.com shows the new version without a hand edit. It uses the repository secret `CMS_TOKEN`, an afora CMS token limited to `site-values`, and the variable `CMS_API_URL`; without them it only warns. See [CONTRIBUTING.md](CONTRIBUTING.md).

### Documentation

- [Blueprints](docs/blueprints.md#the-type-of-a-value) shows how to get the type of a blueprint's value: `StandardSchemaV1.InferOutput<typeof Task>`, and `InferInput` for what it accepts. `BlueprintValue` takes a collection of properties, not a blueprint.

## 27.0.0-rc.4 — 2026-11-16

The fourth candidate of 27.0.0: the open code scanning alerts of the repository are closed (#170). Nothing in the public API changes.

### Security

- Every open code scanning alert is closed. Regular expressions that took quadratic time on crafted input now run in linear time: the route key of `openapi` on a path with many `{` (paths are validated before, so it was not reachable), the trailing `/` of `output.dir` in `@afora/codegen` (and of an import module, not reachable either), and the parser of `tsc` output in `@afora/mcp`, which took seconds on a long line repeating `(0,0): error TS0: `.
- Repository: Dependabot proposes a new version only once it is 7 days old (security updates are not delayed), so a compromised release is usually pulled before it reaches a pull request. `release.yml` calls `ci.yml` and `bench.yml` with GitHub's self-repository syntax (`uses: $/...`). The docs scripts escape `\` in Markdown table cells and every regular expression character in export names. The pull request of the benchmark results now carries `docs/performance.md`, which it left out (#171).

## 27.0.0-rc.3 — 2026-11-16

The third candidate of 27.0.0: security fixes from an audit of 27.0.0-rc.1 (#165). Every finding has a regression test named `SEC-<n>`. The breaking ones change the standard use cases, `Url` and the reserved keys of a blueprint before the contract freezes, as blocking issues of the 27.0 milestone (see [Release candidates](VERSIONING.md#release-candidates)).

### Security

- **Breaking.** `update` (and so the `update` of `resourceOf`) no longer takes sensitive keys as input, such as the `password` of `authenticatable`: any caller who could reach it could set another user's password. Use the new `changePassword`. An `update` whose change keys are all sensitive throws `UseCaseUnavailable`, so `resourceOf` on such an entity needs `update` left out of its `actions`. See Migration below. (SEC-01)
- **Breaking.** With `owner`, `create` and `register` load an entity the input names (`<key>Id`) only if it is the caller's, when it has the same owner key; another owner's gives `notFound`. `relations: { <key>: { shared: true } }` opts a key out. See Migration below. (SEC-03)
- **Breaking.** With `owner`, `update` throws `UseCaseUnavailable` when a change key it would take holds the owner (the caller could give the entity away). See Migration below. (SEC-09)
- **Breaking.** `list` caps `limit` at `maxLimit`, 100 by default: a larger `limit` is `InvalidUseCaseInput` (400, issue `invalid_value`), and the input schema says `maximum`. See Migration below. (SEC-10)
- The `owner` of an `access` is compared on the value the use case acts on: the input key goes through its property (`preHandle`, validation, `afterHandle`) first, so an `Email` is trimmed and lowercased and a `Slug` slugified. Before, the raw input was compared, so a token whose claim was ` Victim@Example.com` passed the check and the use case acted on `victim@example.com`. The subject or claim is compared as it was issued: it must already be canonical (an authenticator that gets `Ana@Example.com` from its identity provider issues `ana@example.com`). An owner value the property rejects, or a claim that is not a string, number or boolean, is a `Forbidden` (`details.reason: "owner"`). This is what [Access](docs/auth.md) already said. (SEC-02)
- `InvalidUseCaseResponse` and `InvalidUseCaseStep` are answered as a 500 whose `detail` is `"Internal error."` with no `issues`, instead of a 400 that listed the paths of the server's own response. Every internal exception is a 500 from `statusOf`, and `problemOf` masks its `detail` and drops its `issues` at any status, even one chosen by `statuses`, unless `debug` is set. Client errors (`InvalidUseCaseInput`, `InvalidUseCaseContext`, `InvalidRecordValue`…) are still a 400 with their issues. (SEC-12)
- `login` takes as long for an unknown email as for a known one: it verifies the password against a dummy hash, made once by the configured hasher on first use, so the time no longer tells which emails are registered. (SEC-11)
- `restore` takes `owner`: a caller no longer brings back another owner's deleted entity. The docs said a deleted entity could not be read to check its owner; it can, with `withDeleted`. (SEC-08)
- **Breaking.** `Url` (`ctx.url`) rejects the protocols `javascript:`, `data:`, `vbscript:` and `file:`, which run script or read local files in a link, however they are written (any case, after leading spaces and control characters, with tabs or newlines inside: the check matches the protocol the URL parser reads). Every other URL that parses is still accepted (`https:`, `postgres:`, `redis:`, `memory:`, `mailto:`…). `Url.with({ protocols: ["https:"] })` accepts only the protocols it lists; protocols that are not schemes throw the new `InvalidUrlOptions` when the class is declared. The check is a `pattern` in the schema, so OpenAPI documents it. `Url` is now a class, and `UrlOptions` is exported. See Migration below. (SEC-13)
- **Breaking.** A blueprint cannot declare `__proto__`, `constructor` or `prototype`: `blueprintOf` and `join` throw `ReservedBlueprintKey`. A blueprint declaring `__proto__` let the input set the prototype of the value `safeParse` gave. See Migration below. (SEC-16)
- `ctx.json`, `jsonOf`, `jsonSchemaIssues` and `checkJsonSchema` reject a value nested more than 1000 deep (`invalid_value`, `is nested too deeply`), before a schema walks it. The check copied its ancestors at every level, so a 31 KB body nested 15000 deep took over a second; it now runs in linear time. Cycles are still `is circular`. (SEC-04)
- A record keeps a frozen copy of the plain objects and arrays a property gives it (`ctx.json`, `jsonOf`, a property with an object schema), as [Records](docs/records.md) already promised: changing the object passed in no longer changes the record. Other objects (a `File`) are kept as they are; `blueprint.safeParse` still hands back the caller's value, unfrozen. (SEC-14)
- Parsing no longer reads a value only `Object.prototype` gives: after `Object.prototype.role = "admin"`, a key `role` the input lacks stays absent, as does a hole of a list that `Array.prototype` would fill, and the tag of a variant; a record's getter does the same. Values from a class's own prototype, such as getters, are still read, so class instances stay valid input. (SEC-15)
- `@afora/codegen` / `@afora/mcp`: a relative module or `extends` is checked against every file a runtime may load for it (an added extension, the `.ts` of a `.js`, a directory's `index.*` or `package.json` entry, the `afora.json` of an extended directory), not only the path as written; any of them that is a symbolic link out of the project is `outside_project`. (SEC-05)
- `@afora/codegen` / `@afora/mcp`: the `output.dir` of a spec extended by a path, at any depth, is held to the rules of `output.dir` from its own directory; the generated code imported the extended application from wherever it pointed. (SEC-06)
- `@afora/codegen` / `@afora/mcp`: `output.dir` is refused in `node_modules` or `.git` however a file system may fold its name (`node_moduleſ`, fullwidth letters, combining marks), and `confinePath` / `writeGenerated` refuse to write there. (SEC-17)
- `@afora/mcp`: the `app` of `afora_project` and `afora_extract` must be a `.ts`, `.tsx`, `.mts`, `.js` or `.mjs` module outside `node_modules` and `.git`, and only the `--app` module when the server was started with one. A failed import is reported by a code (`import_failed`, `not_an_application`, `extract_failed`), never with what the runtime printed. (SEC-18)
- Release: the npm publish runs in a job that only holds the OIDC token, checks out nothing and runs `npm publish <tarball> --provenance --ignore-scripts`; install, build, checks and `npm pack` run in a job with a read-only token, and the tag and GitHub release in a job of their own. Every GitHub Action is pinned to a commit SHA, no checkout keeps git credentials, and benchmarks of pull requests run with a read-only token. CodeQL and zizmor run on `main`, `dev` and weekly, and `.github/CODEOWNERS` covers CI, releases and the code in the scope of `SECURITY.md`. (SEC-07, SEC-19)

### Added

- `ctx.changePassword(Users, options?)`: `{ id, currentPassword, password }`, for an `authenticatable` entity with `findById` and `update`; checks the current password with `verifyPassword` (`UseCaseInvalidCredentials`, as `login`) before storing the hash of the new one. Takes `as`, `owner`, `errors` and the hooks. See [Changing a password](docs/auth.md#changing-a-password).
- `owner: { key: "id", context }` for an entity that is the caller (a user): its own id is compared with the context. Refused by `create` and `register`.
- `restore` takes `owner` (the repository then needs the `exists` action, except for `key: "id"`), `list` takes `maxLimit`, and `create` takes `relations`.
- `@afora/codegen` describes and generates these options.

### Changed

- Every `@afora/*` package ships its `LICENSE` file.
- `SECURITY.md` lists the supported versions of the channels of `VERSIONING.md` instead of the `0.x` policy, and states the boundary rules of `@afora/mcp` and `@afora/codegen` in full.

### Migration

**`update` does not take the password.** Before:

```ts
useCases: (ctx) => ({ update: ctx.update(Users) }),
	await Accounts.run("update", { id, password: "New@1234" });
```

After:

```ts
useCases: (ctx) => ({
	update: ctx.update(Users, { owner: { key: "id", context: "userId" } }),
	changePassword: ctx.changePassword(Users, {
		owner: { key: "id", context: "userId" },
	}),
}),
	await Accounts.run(
		"changePassword",
		{ id, currentPassword: "Old@1234", password: "New@1234" },
		{ context: { userId: id } },
	);
```

An entity whose only change key is the password drops `update`, or `resourceOf`'s `update` with `actions: ["create", "get", "list", "delete"]`.

**`create` with `owner` checks the owner of what the input names.** Before:

```ts
create: ctx.create(Notes, { owner: { context: "userId" } }),
// any folderId was accepted, whoever owned the folder
```

After:

```ts
create: ctx.create(Notes, {
	owner: { context: "userId" },
	relations: { folder: { shared: true } }, // only if folders are meant to be shared
}),
```

**`update` with `owner` and the owner key in `change`.** Before:

```ts
class Note extends entityOf(
	blueprintOf((ctx) => ({ text: ctx.text, ownerId: ctx.id })),
	{
		change: ["text", "ownerId"],
	},
) {}
```

After:

```ts
class Note extends entityOf(
	blueprintOf((ctx) => ({ text: ctx.text, ownerId: ctx.id })),
	{
		change: ["text"], // a transfer is a use case written by hand
	},
) {}
```

**`list` caps `limit`.** Before:

```ts
list: ctx.list(Posts), await Blog.run("list", { limit: 500 });
```

After:

```ts
list: ctx.list(Posts, { maxLimit: 500 }),
	await Blog.run("list", { limit: 500 });
```
**`Url` and the four protocols.** A `Url` that held a `data:`, `file:`, `javascript:` or `vbscript:` URL lists the protocols it accepts. Before:

```ts
const Image = blueprintOf((ctx) => ({ src: ctx.url })); // "data:image/png;base64,..." was accepted
```

After:

```ts
const ImageUrl = Url.with({ protocols: ["https:", "data:"] });
const Image = blueprintOf(() => ({ src: ImageUrl }));
```

**Reserved blueprint keys.** A key named `__proto__`, `constructor` or `prototype` is renamed. Before:

```ts
const Doc = blueprintOf((ctx) => ({ prototype: ctx.string }));
```

After:

```ts
const Doc = blueprintOf((ctx) => ({ prototypeName: ctx.string }));
```

## 27.0.0-rc.2 — 2026-11-16

The second candidate of 27.0.0: faster parsing of entities and of blueprints without handlers, with no change to the API, the values or the issues (#161).

### Changed

- **Performance.** A `date-time` or `date` string in the form `toISOString` writes (and `YYYY-MM-DD`) is checked by comparing its characters, without TypeBox's regular expressions; any other string is left to TypeBox, so exactly the same strings are accepted, and an application that replaces the format with `Format.Set` keeps its own check. `CreatedAt.safeParse` goes from 266 to 44 ns on Bun, and an entity read back from a stored row (its `id` and `createdAt` given) takes about 40% less time. An entity that makes both its `createdAt` and its id reads the clock once, and with the default generator its UUID v7 holds the millisecond of its `createdAt`. A blueprint whose fields only check their value against a schema, with no handler, is checked by one compiled check of the whole value once it has parsed 8 values; a value it rejects takes the usual path, so the issues are the same. Against 0.0.13, `blueprint.safeParse` on valid input is 1.9x faster on the small object without transforms and 2.7x (Bun) / 1.5x (Node) on a list of 1,000 objects, and `Entity.safeParse` on that small object goes from 604 to 369 ns on Bun.

## 27.0.0-rc.1 — 2026-11-16

The first release candidate of 27.0, the first stable release. It has the API of 0.0.13 with one breaking change, taken before the contract freezes: the value `safeParse` gives is no longer frozen (records and entities still are; see [Behavior changes](#behavior-changes) and [Migration](#migration)). It is published under the `rc` dist-tag (`npm i @afora/core@rc`). From here until 27.0.0, only fixes go in: the contract described in [VERSIONING.md](VERSIONING.md) (the stable entry, `/adapters`, `/testing`, the Standard Schema behavior and the issue codes) is frozen, and anything that would change it waits for 28.0.

### Behavior changes

- **Breaking.** `blueprint.safeParse`, `listOf(...).safeParse`, `~standard.validate` of a blueprint, list or variant, and the `input` of a use case give a new object or array made for that call that is **not frozen**: it is typed read-only as before, belongs to the caller, and changing it changes neither the input nor any other result. Records and entities still freeze every object and array they keep, at any depth (so `record.tags.push(x)` still throws), as do their `toJSON()`, the value of an environment, the context of a use case and its response. It is made before the contract freezes: on JavaScriptCore (Bun), freezing an array costs about 75 ns per item (76 µs for 1,000 items, where copying them takes 1 µs; `Object.seal` and `Object.preventExtensions` are as costly), which was about 45% of `blueprint.safeParse` on a list of 1,000 objects, while on V8 it costs nothing. A value handed to the caller is a copy of its own, so freezing it guarded nothing; what is shared stays frozen. See Migration below.

### Added

- **Release channels.** Besides `latest` (stable), each version goes to the npm dist-tag of its channel: `-rc.<n>` to `rc`, `-beta.<n>` to `beta`, and the Next, `<base>-alpha.<n>`, to `next`, published on its own on every push to `dev` that changes the code (`npm install @afora/core@next`). Patches of an older line are published from `release/<YY>.<minor>` branches, to `latest` when they are the newest version and to the `release-<YY>.<minor>` dist-tag otherwise. No dist-tag moves backwards. `bun run release:version <v>` sets the version of every package and the peer ranges on `@afora/core`: `>=<v>` for a prerelease, `^<v>` for a stable version. See [Channels](VERSIONING.md#channels).
- **Prepare release.** `gh workflow run prepare-release.yml -f channel=rc` (or `beta`, `stable`, `patch`) prepares a release up to the pull request that publishes it: it computes the version of the channel (the next candidate, the stable of a candidate, the next patch of a `release/<YY>.<minor>` branch, or a version given, checked against the scheme, the tags and the dist-tags; a version bumped but never published is refused, so none is skipped), writes it in every package, dates the `## Unreleased` sections of the changelogs (a stable after candidates links to their sections since the previous stable), and opens the bump pull request, with auto-merge once CI passes, and the pull request `dev` → `main` titled `Release <version>`, whose merge publishes and stays with a human unless `auto_merge_release` is checked. Locally, `bun scripts/release-channel.ts prepare --channel <channel>` does the same writes. It needs a GitHub App (Contents, Pull requests and Workflows: Read and write; or a fine-grained token) set up once; see [CONTRIBUTING.md](CONTRIBUTING.md#prepare-a-release-in-one-command).

### Changed

- Every package is versioned `27.0.0-rc.1`, and needs `@afora/core >=27.0.0-rc.1`: a prerelease does not satisfy a plain range such as `>=0.0.13`, so the packages of the candidate name it.
- **Performance.** A collection whose fields are all properties parsing through their definition (no nested blueprint, list, record or variant) is parsed by one loop over their parsers, the path of an issue made only when there is one; the values and issues are the same, which a differential test checks against the general path on generated inputs. With the change above, `blueprint.safeParse` on valid input takes, on Bun, 62% less time on a list of 1,000 objects (183 → 69 µs), 51% less on the nested user, 63% less on the union of 12 events and 16–26% less on a flat object; on Node, 20% less on the list and 20–31% less on a flat object. `bench:guard` no longer needs its own limit for `large-list valid` (0.44x of Zod 4, was 1.0x).

### Migration

Code that relied on the result of a blueprint being frozen (an `Object.isFrozen` check, or a `TypeError` expected when it is changed) freezes it itself, or makes a record of it, which keeps its values frozen.

```ts
// before
const result = Order.safeParse(body);
if (!result.issues) Object.isFrozen(result.value); // true

// after
const result = Order.safeParse(body);
if (!result.issues) Object.freeze(result.value); // when a frozen value is needed
// or keep it in a record: new OrderRecord(result.value) freezes what it keeps, at any depth
```

## 0.0.13 — 2026-11-16

This release adds per-entity ids (integers and natural keys included), services as dependencies, file uploads, list responses, a status chosen at run time, a body on `DELETE`, the JSON Schema of any field, and a provider wrapper with a spy for tests. Read the behavior changes first: one is a security fix that changes what a request may set.

### Behavior changes

- **Security fix.** A key a use case route reads from a header, a cookie or its `query` keys is read only from there; a value sent for it in the body is dropped (#119). See [A body on DELETE routes](#a-body-on-delete-routes-119).
- **Problem details.** An exception the output declares (in `statuses` or the operation's `errors`) keeps its `detail` at a 5xx, where it read `"Internal error."` (#120). See [Problem details](#problem-details-declared-exceptions-keep-their-detail-120).
- **Issue messages.** The issue of an error thrown by a `preHandle`, `handle` or `afterHandle` that is not an `Exception` no longer starts with `Invalid value for property "<key>": ` (#123). See [JSON Schema and issue messages](#json-schema-and-issue-messages-123).
- **The provider contract.** `IRepositoryProvider.insert` may give `{ id }`, `remove` and `increment` take an `IdValue` (a string or a number), and the `id` in the details of the repository exceptions is an `IdValue` (#122). A provider of your own keeps working with string ids. See [Ids](#ids-per-entity-and-ids-the-database-assigns-122).
- **Types.** `RouteDeclaration` and `RouteSettings` are type aliases that take `body` only with a `delete` method (#119).
- **`OwnerId`** of the `ownable` plugin holds the id of an entity of any strategy, not only a UUID v7 (#122).

### Security (#69)

- `@afora/codegen` and `@afora/mcp` (#69): `projectBoundaryIssues`, which `@afora/mcp` runs on every spec an agent sends, refuses (`outside_project`) the imports and `extends` that left the project or ran the runtime's own modules: `pkg/../../../x`, a backslash or percent-encoded `..` in a relative module, a `?` that a URL reads as a query, a built-in module such as `child_process`, a symlink out of the project, an `output.dir` in `node_modules` or `.git` (any case), and the same in a spec extended inside the project, at any depth (`resolveExtended(spec, file, { root })`). `generate` keeps a `__proto__` key of a JSON value an own property. `afora_generate` runs `bunx --no-install tsc`. See `SECURITY.md`.

### Ids per entity, and ids the database assigns (#122)

- **Per-entity id strategies** (#122). UUID v7 stays the default of `entityOf`; the new `id` option replaces it for one entity. `Uuid` accepts a UUID of any version (lower-cased) and still generates v7; `Key` is a natural key (1 to 256 characters) that the input must hold, required by the constructor type too; `idOf(property, generate?)` takes any required property and an optional generator, so ids can be integers. The type of `entity.id`, `findById`, `delete`/`restore`/`increment` by id, query values and the `{id}` of the standard use cases follow the property; the standard `create` takes the id when the entity makes none, and an integer `{id}` in an HTTP path is read as a number. Only the default generator (and `Uuid` with it) skips the check of the id it made. New exports: `idOf`, `isIdStrategy`, `isIdValue`, `Uuid`, `Key` (and their properties `UuidKey`, `TextKey`), `InvalidIdStrategy`, `EntityIdStrategy`, and the types `IdStrategy`, `IdValue`, `IdValueOf`, `IdentityWithId`, `RequiredIdInput`, `EntityIdOptions`, `EntityConstructorWithId`, `EntityIdOf`. `app.describe().entities.<Name>.id` gives `{ property, generated }` for an entity with the option. See `docs/entities.md#ids`.
- `@afora/codegen`: an entity of `afora.json` takes `"id": "uuid7" | "uuid" | "key"`, generated as `{ id: Uuid }` / `{ id: Key }` and extracted back (by the strategy itself: any other `idOf` throws `ExtractionError`). `afora.schema.json` has it.
- **Ids the database assigns** (#122). `entityOf(blueprint, { id: Serial })` gives an entity a positive integer id that the database assigns as it stores it (an auto-increment, `serial` or identity column). Built without an id, the entity is valid and has none (`id` reads `undefined`, typed `number`, and `toJSON()` leaves it out; it equals only itself) until `repository.create` inserts the row without `id` and sets the one the provider gives back. Its `onCreate` events wait for the id: `create` queues them, before any event emitted since the entity was built. `IRepositoryProvider.insert` now gives `Promise<void | { readonly id: IdValue }>` (`ProviderResults["insert"]` follows), and `ProviderCapabilities.generatedIds?: true` advertises a provider that assigns ids: the in-memory provider (a counter per entity that never gives an id twice, a rolled back transaction included) and `@afora/drizzle` (SQLite and Postgres, through `RETURNING`). A repository with `create` over a provider without it throws the new `UnsupportedIdentity` when declared, when an application binds it, or on `app.start()` for a provider made on start; `@afora/dynamodb` has no such capability. The standard `create` use case and `resourceOf` do not take the id; `{id}` in a path is read as a number. `app.describe().entities.<Name>.id.generated` is `"database"` for it. `providerContract` runs the cases of assigned ids with `capabilities.generatedIds` (or `{ generatedIds: true }`) on an entity named `Serials`. New exports: `Serial`, `SerialKey`, `UnsupportedIdentity`, `UnstoredEntity`; `IdStrategy` takes `"database"` as its second parameter and has `generatedBy`. A new Serial entity given an id of its own is refused by `create` and by `increment` with `create` (`UnsupportedIdentity`), as it would leave the database sequence behind; an id from the provider is validated by `SerialKey` (a positive integer up to `Number.MAX_SAFE_INTEGER`). An entity not created yet is refused with the new `UnstoredEntity` by `update`, `delete` (before `destroy()`), `restore`, `increment`, and when another entity holds it. See `docs/entities.md#ids-the-database-assigns`.
- `@afora/codegen`: `"id": "serial"` is accepted, generated as `{ id: Serial }` and extracted back; `afora.schema.json` has it. `@afora/mcp`: the guide names it.
- Integer ids work with auth: the standard `refresh` finds an entity whose id is an integer from the text subject of its token, and an `access.context` key that is an integer (or a number, or a boolean) gets the subject or claim as one, instead of failing with `InvalidUseCaseContext`. The JWT subject stays a string.
- `OwnerId`: the `ownerId` of the `ownable` plugin now holds the id of an entity of any strategy (text of 1 to 256 characters, a UUID kept in lower case, or a positive integer), not only a UUID v7. `isOwnedBy` and `transferTo` take a string or a number; `isOwnedBy` compares a UUID in any case and a number by value. A UUID v7 owner behaves as before.
- Repositories handle ids as strings or numbers (`IdValue`): the in-memory provider, references between entities (loaded in batches by id), `delete`/`restore`/`increment` by id. `IRepositoryProvider.remove` and `increment` take an `IdValue`; the `id` in the details of `DeletedEntity`, `RepositoryEntityNotFound`, `RepositoryConcurrencyConflict`, `InvalidStoredSchemaVersion` and `SchemaMigrationInvalidRow` is an `IdValue`. The DynamoDB provider still needs a non-empty string id (`Uuid` and `Key` qualify).

### Services as dependencies (#115)

- **Services as dependencies** (#115). `serviceOf<T>(name)` declares a service, a dependency of use cases next to use cases, repositories, environments and `Logger`: a cache, a storage, a client of another API. `applicationOf({ services: { cache: (scope) => value } })` gives its value by name, made once per call (the use cases a call runs share it) from a `ServiceScope`: the `context` of the call, the `principal` an output authenticated, its `logger`, `environment(Env)`, and `native`, the request of the sink (the Hono context, for `waitUntil` on Workers). A factory may be async: the services a use case declares are made when its `execute` starts, so `this.dependencies.cache` is the value, read without `await`. `execute({ cache })` replaces it, like any dependency. Reading a service nothing gives throws the new `ServiceNotBound`, and reading one before or after `execute` the new `ServiceOutsideExecution`; an application with a use case that declares a service it does not give throws `UnregisteredUseCaseDependency`; `describe()` reports `{ kind: "service", ref }` for the dependency and `services` for the application. `OperationCallOptions` takes `native`, which the HTTP sinks give. New exports: `serviceOf`, `isService`, `ServiceNotBound`, `ServiceOutsideExecution` and the types `ServiceDeclaration`, `AnyService`, `ServiceScope`, `ServiceFactory`, `ServiceValueOf`. See `docs/use-cases.md#services`.
- `@afora/codegen`: a top-level `services` (`{ "cache": { "import": "../services.ts#cache" } }`) and a use case dependency that names one, generated as `serviceOf<Awaited<ReturnType<typeof cache>>>("cache")` (the factory imported with `import type`) and `applicationOf({ services })`, extracted back with `imports["services.<name>"]`. New issues `invalid_services` and `duplicate_name` (a service named like a declaration); a service named `Logger` is `invalid_name`. `afora.schema.json` describes it.

### File uploads with multipart/form-data (#118)

- `ctx.file` (`FileProperty`) holds any file and `ctx.fileOf({ types?, maxBytes?, name?, optional? })` (`fileOf`) a file of the media types given (`"image/*"` takes any image) of at most `maxBytes`. The value is a `File` (any `Blob`), checked and kept as it is, never copied; a value it rejects throws `InvalidFile`, an issue at its key (a 400), and invalid options throw `InvalidFileOptions`. Its schema is `format: "binary"`, which OpenAPI and JSON Schema write as `type: "string", format: "binary"` (`contentMediaType` for one exact type). New types `FileClass`, `FileOptions`, `TFile`. See [`docs/std-properties.md#files`](docs/std-properties.md#files).
- `compileRoutes` reads the input of an operation that holds a file from a `multipart/form-data` body when the request sends one, through the new optional `HttpRequest.form()` (type `FormParts`): files as they are, text coerced to numbers and booleans, objects as JSON text, repeated keys as a list; the path, route query, headers and cookies are placed over it as over JSON (#119 hardening kept). A server without `form` answers 415 `UnsupportedMediaType`, an unreadable body 400 `InvalidRequestBody`. A JSON body still reads the other keys. A file on a `get`, a `delete` without a body, or as a path, query, header or cookie key throws `InvalidOutputStage`. The body size is for the server or proxy to limit; `maxBytes` checks each file. See [`docs/outputs.md`](docs/outputs.md).
- The `openapi` sink gives such an operation a `multipart/form-data` `requestBody`.
- `@afora/hono`, `@afora/express`, `@afora/fastify` and `@afora/elysia` read multipart bodies with the platform `Request.formData()`, no new dependency (Fastify registers a `multipart/form-data` parser that keeps the bytes; Elysia reads `FormData` only for multipart requests). `httpProviderContract` checks uploads: the file the handler sees, a wrong type and a large file as 400 issues at the key, text parts coerced, repeated keys as a list.
- **Hardening.** A multipart body is walked once and capped at `maxParts` parts (a new `HttpOptions` key, 1000 by default; more is a 413 `TooManyParts`); of the undeclared keys only the first is kept. A file declared as a PNG, JPEG, GIF, WebP or AVIF must start with the bytes of that format (400 `InvalidFileContent`), and `image/*` does not take `image/svg+xml`, which only its own name does. An `Exception` thrown by `form()` keeps its status (500 by default). A file cannot be `sensitive` or `unique` (`InvalidRecordDeclaration`), and an entity cannot hold one (new `EntityHoldsFile`). `@afora/express` answers a body another parser read with a 500 `MultipartBodyAlreadyRead`; `@afora/elysia` reads a multipart body only when the route asks, so a malformed one is a 400; on Elysia and Fastify a multipart body to a route without a file is read as text, a 400 as on Hono and Express. `httpProviderContract` checks malformed bodies, a missing boundary, a disguised image and multipart on a JSON route.
- `@afora/codegen`: a field (and a property declaration) `{ "file": { "types": [...], "maxBytes": n } }`, and the Std `"file"`, generated as `ctx.fileOf(...)` / `fileOf(...)`, extracted back and checked (`invalid_file`; not an environment variable). `afora.schema.json` has it. `@afora/mcp`: the guide shows it.

### A list as the response (#117)

- The `response` of `useCaseOf` can be a list made by `listOf` (`response: listOf(ArticleSummary)`), not only an object blueprint: `execute` resolves with the frozen array of the items, typed as a read-only array of their value (`readonly { slug: string; title: string }[]`; `UseCaseResponse`, a dependency function and `strictSteps` follow it). The array and each item are validated (an invalid item is an `InvalidUseCaseResponse` whose issue paths start with the index), the events of the entities in it are collected, and a child use case may answer one. An optional list, or a `route.setCookie` with a list response, throws `InvalidUseCaseDeclaration`. The HTTP sinks send the array as the JSON body, OpenAPI documents it as `type: array` with `items` (its records become components), and the MCP and WebSocket sinks send it as is. `OperationDescriptor.response` and the `response` static are `AnyUseCaseResponse` (an object blueprint or a list); `app.describe()` gives a list response as `responseList` (with `response: {}`). New types `AnyUseCaseResponse`, `UseCaseOutput`, `ResponseOf`, `ResponseValue`, `ResponseBlueprint`, `ResponseSetting` and `BlueprintListValue`; the `Output` parameter of `UseCaseSettings`, `UseCaseConstructor` and the other use case types extends `UseCaseOutput`, and an object response keeps its types as they were. See [`docs/use-cases.md#a-list-as-the-response`](docs/use-cases.md#a-list-as-the-response).

### A status chosen at run time (#116)

- `withStatus(status, body)`: the `execute` of a use case may return the body of its response with another HTTP status, e.g. a health check that answers `200` or `503` with the same body (`return ok ? body : withStatus(503, body)`). The body is validated against the `response` and its events are collected as for any return. The route declares each status other than its own in `route.statuses` (`{ method: "get", path: "/health", statuses: [503] }`): each a 2xx with a body (not 204 or 205), a 4xx or a 5xx, but not 400 or 500 (kept for the problems every operation documents), nor the route `status`, each once, else `InvalidUseCaseDeclaration`; the `route` option of the sinks takes `statuses` too, over the use case route (`InvalidOutputStage` for the same mistakes). The HTTP sinks (`hono`, `express`, `fastify`, `elysia`, through `compileRoutes`) send the body as JSON with that status, and answer a status the route does not declare with the new `UndeclaredStatus` (`Output` layer), a 500 whose detail is always masked. A 5xx chosen this way is a success-shaped body, not a problem. The `openapi` document has one response per status, with the same content (a status that is also an error status gets both media types), and descriptions such as `Service unavailable.` for 503. `httpProviderContract` checks it.
- The status only travels to the sinks: `execute()`, `command.run` and a use case called as a dependency resolve with the body, and the `mcpTools` and `websocket` sinks send the body. `withStatus` gives a view of the body made for the call, typed as the body and reading as it (fields, record getters and methods, `Array.isArray`), so the return type of `execute` and of a direct call stays the response; the status belongs to the view, never to the body, so a shared or frozen body cannot carry it to another call, concurrent or after a throw. `operation.invoke` resolves with such a view, and `chosenStatusOf(value)` in `@afora/core/adapters` gives its status, for the HTTP sinks; a transform that wraps `invoke` must resolve with the same value for the status to survive. In steps, a `run` step may return it and `return` give its result. `operationRoutes` gives each route its `statuses`. See [`docs/use-cases.md#a-status-chosen-at-run-time`](docs/use-cases.md#a-status-chosen-at-run-time).
- `@afora/codegen`: a use case route in `afora.json` takes `"statuses": [503]`, checked (`invalid_route`), generated and extracted back; `afora.schema.json` has it. `withStatus` itself is written in a hand-written `execute` or in the function of a `run` step.

### A body on DELETE routes (#119)

- **Security fix, behavior change** (`@afora/core` and every HTTP sink). An input key the use case route reads from a header, a cookie or its `query` keys is now read only from there: a value the client sends for it in the body (or, on a `get` or `delete`, in the query string) is dropped. Before, a request without the header kept the body's value, so `{ "tenant": "evil" }` without `x-tenant` gave the tenant `"evil"`. A missing header or cookie now leaves the key absent, and the blueprint decides (a required key is a 400). `httpProviderContract` checks it.
- `route: { method: "delete", body: true }` reads the input keys with no other place from a JSON body instead of the query, merged as for the other methods (the path, the route query keys, headers and cookies win); an empty body is `{}`. It is an opt-in, so existing `delete` routes, their clients and their documents do not change. It is taken by the use case route (`route` setting and `@Route`) and by the `route` option of the sinks (`openapi`, `hono`, `express`, `fastify`, `elysia`), which wins; `body` on a `get`, `post`, `put` or `patch` is rejected (`InvalidUseCaseDeclaration`, `InvalidOutputStage`). The `openapi` document gives such a route a JSON `requestBody`, `required` only when a field left in it is, and `operationRoutes` reports it as `body: true`. `httpProviderContract` checks that every HTTP sink delivers the body of a `DELETE`. See [`docs/use-cases.md#routes`](docs/use-cases.md#routes).
- **Types.** `RouteDeclaration` and `RouteSettings` are now type aliases that take `body` only with a `delete` method, as do `@Route` (generic over its method) and the `route` option of the sinks; `body` on another method is a type error. New types `RouteFields` (what a route says besides its method and `body`) and `RouteBody<Method>`.
- `@afora/hono`: a `delete` route with `body: true` can be a webhook.
- `@afora/codegen`: a use case route in `afora.json` takes `"body": true`, checked (`invalid_route` off a `delete`), generated and extracted back. `afora.schema.json` has it.

### Problem details: declared exceptions keep their detail (#120)

- **Problem details** (`@afora/core`, `@afora/hono`, `@afora/express`, `@afora/fastify`, `@afora/elysia`, `@afora/ws`, `@afora/mcp`). An exception the output declares keeps its `detail` at a 5xx (#120): `statuses: { PublishFailed: 502 }` answers with the message of `PublishFailed` instead of `"Internal error."`. Declared means its name is in the output `statuses` or it matches a class of `operation.errors`: listing an exception there exposes its message at a 5xx, afora's own exceptions included when you list them on purpose. Exceptions the output does not list stay masked unless `debug` is on, and `UnexpectedError` (an error that is not an exception, with its raw message, or any exception carrying that message), `InvalidCommandEnvironment`, `InvalidEnvironment`, `InvalidApplicationEnvironment` and `InvalidUseCaseResponse` are never exposed, even when listed. `problemOf` takes `statuses` and `operation` to decide it, and every sink passes them. In `@afora/ws`, an error outside an operation call (a message the endpoint fails to handle) now also gets the status the output `statuses` give it.

### Wrapping and spying on a provider (#124, #121)

- `wrapProvider(provider, { around })` runs `around({ operation, context, args }, next)` around each operation of a repository provider that takes a context, for logs, traces and spies. The result is typed as the provider it wraps, with no cast, and has the same shape: a plain frozen object with the same operations (`increment`, `migrate`, `transaction` and `close` stay absent when the provider has none), `capabilities` read live, and the other members bound at wrap time. `args` is typed by operation, and `around` must give the result of the operation, which `next()` gives (a missing `return` is a type error). The provider a `transaction` gives is wrapped with the same interceptor, and wraps compose. A provider of `providersOf` is rejected with `InvalidRepositoryDeclaration`: wrap the provider before giving it to `providersOf`. New types `ProviderOperation` (the union of the operations taking a context), `ProviderCall`, `ProviderResults` and `ProviderInterceptor`. See `docs/repositories.md#wrapping-a-provider`.
- `spyProvider(provider)` in `@afora/core/testing`: a provider for tests that forwards to `provider` (through `wrapProvider`) and records each call as `{ operation, entity, args }` (`entity` is `recordNameOf` the entity), transactions included. `calls(entity?, operation?)` reads them (by entity name or class), `fail(entity, operation, error, { times })` makes an operation reject the next `times` calls (or until `reset()`), and `reset()` forgets both. The spy is the provider, typed as it, so it goes to `applicationOf({ provider })` and lets a test count reads or inject a failure behind an HTTP sink, where repositories, being frozen, cannot be spied on. `docs/testing.md` explains why repositories are frozen and shows both ways: `spyProvider` behind a sink, overrides in `execute()` for a direct call.

### JSON Schema and issue messages (#123)

- `jsonSchemaOf(field)` (#123): the JSON Schema (draft 2020-12) of a property, blueprint, list, variant, record or entity, as a standalone document with `$schema`, each record held inside defined once under `$defs` by its name and referenced as `#/$defs/<Name>`, variants as `oneOf` without the OpenAPI `discriminator`, the read-only identity of an entity left out of `required`, and the schema of a property with an `$id` defined once under `$defs`, without it, so the document is self-contained. It shares the walker of `toOpenAPI`, whose output does not change, and keeps its `writeOnly` sensitive keys and `readOnly` entity identity. For whatever reads JSON Schema rather than OpenAPI, such as an MCP `describe_schema` tool. Type `JSONSchema`. See [`docs/openapi.md#json-schema`](docs/openapi.md#json-schema).
- **Behavior change.** When a `preHandle`, `handle` or `afterHandle` throws an error that is not an `Exception`, the issue `safeParse`, `~standard.validate` and problem+json `issues[]` give has the error's message as it is (`"Use lowercase letters, numbers and hyphens."`), no longer prefixed with `Invalid value for property "slug": `, since the issue `path` already names the property (#123). An error with an empty message gives `"is invalid"`. The `InvalidPropertyValue` a property's constructor throws and its `cause` keep the prefix. The message of the exception a record throws for that key (built from its first issue, as `InvalidRecordValue` is) loses the inner prefix: `Invalid value for "slug" of record "Post": Use lowercase letters, numbers and hyphens.`, where it read `...: Invalid value for property "slug": Use lowercase...`. A client that stripped the prefix can stop. See [`docs/properties.md`](docs/properties.md).

### Documentation (#93, #67)

- The [exceptions reference](docs/reference/exceptions.md) lists the problems the HTTP layer answers by itself (`InvalidRequestBody`, `UnsupportedMediaType`, `TooManyParts`, `InvalidFileContent`) and the exceptions a sink package throws (`MultipartBodyAlreadyRead` in `@afora/express`). The `@afora/mcp` README and the CLI page give the type check as `bunx --no-install tsc`, with `npx --no-install tsc` as the fallback.
- New guides: [Building with an agent](docs/building-with-an-agent.md) (`@afora/mcp`, what to review, the CI checks), [Storing data](docs/storing-data.md) (from memory to Drizzle or DynamoDB, what each provider can do) and [Real time](docs/real-time.md) (`@afora/ws`, from the command to the socket). [Schema evolution](docs/schema-evolution.md#from-commit-to-production) gains the steps of a change from commit to production.
- A tested recipe, [Uploading a file to a storage](docs/recipes/file-upload.md) (`fileOf` and a service), run by `bun run test:interop`.
- The features of this release are in the tutorial, the Hono + Zod guide, the FAQ, the glossary and troubleshooting.

### The agent-built evaluation, ready for N runs per model (#58)

- `examples/agent-built`: `bun run eval:agent-built -- --runs 20 --models <a>,<b> --briefs 2,3 [--db sqlite]` makes N runs per side, model, brief and database with the Claude API (`scripts/eval.ts`), retries a run that hits an API error, then evaluates every run; `--dry-run` prints the plan and a rough token estimate without a key. Without a key it still exits before any run. A third brief (`BRIEF.v3.md`) describes the same product and contract without listing the guarantees, and is checked with the same invariants, ownership included. A sixth invariant checks that the capacity holds when the last seats are bought at once. `--db sqlite` runs both sides on SQLite: the baseline on `bun:sqlite`, the afora run on the `drizzle` provider of `@afora/drizzle`, offered through the providers catalog of the MCP server. Both sides run the same tool loop with the same model, effort and turns: the baseline gets tools to write and read its files, type-check them and send requests to its app, in place of the MCP tools, and for brief 3 neither side's instructions say which guarantees hold. Only API errors are retried; any other failure, or an evaluation past its timeout, counts as a run failing every invariant. `eval/RESULTS.md` now reports the pass rate of each invariant per model, effort, brief, database and side with a 95% Wilson interval, and labels the committed Claude Code runs as not scripted; they pass the new check too. No scripted run has been made yet.

## 0.0.12 — 2026-11-11

### Changed

- **Docs.** A new line, "Simple to write. Built to hold.", and a shorter README: why afora, what it gives developers and agents, the quick start (its `afora.json` version folded), the packages and the chart. The benchmark tables, their analysis and the comparison with other validators moved to `docs/performance.md`, generated from the same `bench/results/latest.json`; `docs/brand.md` holds the line, the descriptions, the voice and the palette. The benchmark chart uses the colors of the brand, in light and dark.
- **Breaking** (`@afora/codegen`, `@afora/mcp`). In an `afora.json`, a `run` step with `args` must declare `params` (#98): `check`, `generate` and the validation of the MCP tools (`afora_spec_validate`, `afora_spec_upsert`, `afora_spec_write`) report the new error `run_without_params` at the `args` of the step. A `run` without `args` needs no `params`. An agent writing the spec has no compile step that knows the parameters of the function, so without `params` the function ran on whatever the args resolved to. In TypeScript `useCaseOf` does not require it (`strictSteps` checks the parameters of `fn` at compile time); a hand-written use case without `params` still extracts, but the spec fails validation until it is declared. The README quick start, the MCP guide and `docs/use-cases.md` and `docs/afora-json.md` declare it. See Migration below.

### Docs

- `examples/agent-built` checks ownership (#60). Its brief is now version 2 (`BRIEF.md`): logging in gives a JWT, and only its organizer can read or change an event (`PATCH /api/events/{id}` is new). The evaluation gains a fifth invariant, "only its organizer reads or changes an event": 401 without a token or with a malformed or forged one, 404 or 403 for another organizer, and an event cannot be created for someone else. A new afora run, `runs/claude-code-2`, declares it with `access` and the `owner` option of the standard use cases, without code, and a new Hono + Zod baseline writes it by hand. Both pass all five. Each run names in `run.json` the version of the brief it is evaluated against, so the brief 1 runs (`BRIEF.v1.md`) keep their results.
- `docs/use-cases.md#strict-steps` says how the `"$..."` references of steps behave under an editor rename (#97): with `strictSteps: true` every stale reference is a compile error offering the names in scope; without it the dependency and action names are checked by TypeScript and a stale `$input.<key>` throws `InvalidUseCaseStep` at declaration. It recommends `strictSteps: true` for hand-written steps; no language service plugin or typed references are planned.

### Migration

`@afora/codegen`: give each `run` step with `args` a `params` whose fields match the args by position, as a blueprint by name or inline.

```jsonc
// before
{ "run": "hashPassword", "fn": { "import": "../hash#hashPassword" }, "args": ["$input.plainPassword"], "as": "hash" }
// after
{ "run": "hashPassword", "fn": { "import": "../hash#hashPassword" }, "args": ["$input.plainPassword"], "params": { "fields": { "plain": "string" } }, "as": "hash" }
```

In TypeScript, for a use case you extract with `extractSpec`, declare `params: blueprintOf((ctx) => ({ plain: ctx.string }))` on the step.

## 0.0.11 — 2026-11-11

The `@afora/core` 0.0.10 was not released: these changes ship in 0.0.11. `@afora/otel` 0.0.10, published by hand to create the package on npm, requires `@afora/core` >= 0.0.11; use `@afora/otel` 0.0.11.

### Changed

- This release republishes every `@afora` package through npm trusted publishing (OIDC): `@afora/fastify`, `@afora/express`, `@afora/elysia` and `@afora/dynamodb` 0.0.9 went out through a token, without provenance, and their trusted publisher stayed pending validation. The Release workflow no longer passes a token, so every package is published with provenance or the release fails.
- **Messages.** A property exception raised through a record names the key and the record: `Property "password" of record "User" is required.` and `Invalid value for "email" of record "User": ...`, instead of `Property "string" is required.` (the name of the property, which says nothing of where it failed). The name, class, `details` (`{ key }`) and `trace` are the same, and the exception of the property in the trace keeps its own message. Code that matches the whole message of a record rejection must follow; see `docs/records.md`.
- **Messages.** `InvalidUseCaseInput`, `InvalidUseCaseContext` and `InvalidUseCaseResponse` name their first issue: `Invalid UseCase response: "user" is required.`, with `(and N more)` when there are others, instead of `Invalid UseCase response.`. `details.issues` is the same. For a 400 this message is the `detail` of the problem+json; the `detail` of a 5xx stays `"Internal error."`.
- With `strictSteps`, TypeScript checks the `return` step against what the response blueprint takes, as it checks the `values` of a `build`: a missing key, a value of another type or a result that may be `undefined` is an error (it was checked as references only, and a wrong response failed when the use case ran). A wrong value now names the type that is taken instead of `never` (`Type 'string' is not assignable to type 'number'`), and a reference that only fails because it may be `undefined` is offered the hint `"<ref> may be undefined: ensure it exists first"`. It costs about 3% more per edit on a strict steps use case; without `strictSteps` nothing changes. See `docs/use-cases.md#strict-steps`.
- The quick start of the README declares `strictSteps: true`.

- **Breaking.** The stable surface is cut before the 27.0 freeze (#59). These moved from `@afora/core` to `@afora/core/experimental`, outside the contract (15), all types: `AbstractPropertyConstructor`, `IPropertyCollection`, `EntityStorageSettings`, `RepositoryCount`, `RepositoryCreate`, `RepositoryDelete`, `RepositoryIncrement`, `RepositoryRestore`, `RepositoryUpdate`, `RepositoryExists`, `RepositoryExplain`, `RepositoryFindCursor`, `RepositoryFindMany`, `RepositoryFindPage` and `RepositoryForEachPage` (name a repository with `RepositoryOf`). Nothing changes at run time. Twenty-six other unused exports were weighed and stay stable; `docs/api-tiers.md` ("Moved before 27.0") gives the reason for each, moved or kept, and what would promote a moved one back. See Migration below.
- The version scheme is year-based, `YY.minor.patch` (#62): the first stable release is 27.0.0, the major is the year of the cycle and only a major may break the contract. `VERSIONING.md` describes it, drops "A major is not planned", says that a breaking change ships only in the next year's major after a deprecation, and has the changelog template at `27.1.0`. `docs/api-tiers.md` and `docs/README.md` say 27.0 where they said 1.0.
- `VERSIONING.md` has the rules of release candidates (#63): `27.0.0-rc.1` goes to `next` once the blocking issues of the 27.0 milestone are closed, only fixes land during the rc, it stays open at least two weeks after the last candidate, and `27.0.0` ships when no blocking issue is open.
- The Release workflow fails on a version that is neither `0.0.<n>` nor `<YY>.<minor>.<patch>[-rc.<n>]` with `YY` at 27 or more, or whose numbers have leading zeros.
- `CONTRIBUTING.md` describes how a change is reviewed and how any maintainer makes a release (#70), and lists every package.
- **Breaking** (`@afora/codegen`). A use case implemented by `{ "import" }` can be a dependency of another use case and be `call`ed by its steps (#64); the `import_dependency` issue is gone. To make this possible, each use case that hand-written code needs (the `<Name>Base` of every `import` use case, and every steps use case such a class depends on) is generated in its own `<kebab-name>.use-case.ts` in `output.dir`, and `use-cases.ts` re-exports it. New issues: `import_cycle` (a hand-written module that would import itself back through the generated files), `file_collision` (two use cases that would get the same file name) and `generated_file` (an `{ "import" }` of a file the generator writes in `output.dir`, such as `./greet.use-case`). `writeGenerated` removes stale generated `*.use-case.ts` files. See Migration below.
- Every export of `@afora/core`, `/adapters`, `/experimental` and `/testing` has JSDoc (#92). The main builders (`propertyOf`, `blueprintOf`, `recordOf`, `entityOf`, `eventOf`, `repositoryOf`, `useCaseOf`, `environmentOf`, `exceptionOf`, `guard`, `applicationOf`) have an `@example` that is type-checked; functions that throw name the exception with `@throws`, and settings with a default carry `@default`. The block of `IRepositoryProvider` was attached to the wrong declaration.
- `@afora/core` is smaller in a bundle and loads faster (#86), with no change to its API. Measured on an Apple M2 with Bun 1.4.4 and Node 22, on the cold start entry of `bench/` (`blueprintOf` with three properties and one `safeParse`, bundled with `Bun.build` minified): 418 kB minified / 110 kB gzip before, 190 kB / 53 kB after, from `src/index.ts` or from the built `dist/index.js` (422 / 111 kB before); 24 TypeBox compiles at import before, 3 after (the entry's own); a new process imports that bundle in about 17 ms on Node and on Bun, from 60 to 68 ms on Node and 44 to 47 ms on Bun measured side by side on the same loaded machine (38 and 26 ms on a quieter run). What changed:
  - Reading the TypeBox schema of a property, a blueprint or a record no longer compiles it. Twelve places only read it back through `schema.type.Type()`, which compiled first; the JSON Schema meta-schema of `ctx.schema` alone took 10 to 50 ms to compile at import.
  - `ctx.optional.*`, `ctx.list.*` and `ctx.list.optional.*` are made when they are first read, and kept. They were made for every field of every source on each `blueprintOf` (95 objects per blueprint with Std). They are still frozen, with the same keys, and `ctx.list.optional.x` is still `optionalOf(ctx.list.x)`; they are getters now, not data properties.
  - The TypeBox locales are no longer all kept by a bundler: `Locale` and `Settings` are imported by name (about 100 kB minified with Bun; esbuild still keeps them as soon as `Locale` is referenced).
  - `package.json` declares `"sideEffects": false`, so a bundler drops the modules an application does not import. No module of the package is imported for what it does at import.
  - `dist/` has one module per module of `src/`, transpiled and not bundled (`scripts/build.ts`), instead of four entries bundled with code splitting into shared chunks, which left a bundler no whole module to drop. The `exports` are the same, and the entries still share one copy of each class, symbol and registry. Imported without a bundler, the package has 133 files instead of 9: on Node that load takes about as long as before (the changes above pay for the extra files; about 20% longer than the same code in chunks would), and on Bun less.
- `bench/` bundles every entry with the TypeBox copy afora uses, the TypeBox entry included; it used the version `bench/package.json` pins.
- `Entity.safeParse` and `new Entity(value)` make the id, `createdAt` and `expiresAt` that the defaults of `entityOf` vouch for (#66) only once the rest of the value is known to be valid, so invalid input no longer pays for a UUID v7 and a time stamp, and the issues are the same, in the same order. A key that a configured `idGenerator`, an `entityBuilderOf` maker or the value brings is still checked first, as before. The default time stamp keeps its last formatted millisecond, and the record loop compares the few vouched keys as locals. On Bun, in the `bench:guard` cases, as a multiple of Zod 4 `safeParse` in the same process (it moves 10% to 20% with the load of the machine): flat valid 2.49x to 1.5x-1.8x (889 ns to about 550-850), flat invalid 2.24x to 1.4x-1.8x (1403 ns to about 875-1300), no-transform valid 3.43x to 2.0x-2.2x, no-transform invalid 2.48x to 1.4x-1.8x; `bench:guard` now holds `Entity.safeParse` to 2x Zod 4 (`ENTITY_LIMITS` in `bench/guard.limits.ts`). An entity built from plain objects that nest entities gets its id after theirs (UUID v7 ids sort the same way). When the entity makes `createdAt`, a `RangeError` from a lifetime too large for `expires: { after }` is raised for valid input only. `bench/RESULTS.md` is regenerated by the runner after the merge.

### Added

- `params` on a `run` step: a blueprint whose keys match the `args` by position. The args are parsed before `fn` is called, `fn` gets the values as the keys handled them, and a rejected arg throws `InvalidUseCaseStep` (`code: "invalid_args"`, the issues in `details.issues`) without running `fn`. Without `params` the args are still not checked at run time, as before. `useCaseOf` checks that it is a blueprint and that a list of args has as many items as it has keys; `describe()` gives it by its fields. `@afora/codegen` reads `"params"` (a blueprint by name or `{ "fields": {...} }`) in `afora.json`, checks it (`invalid_args`), generates it and extracts it back; `afora.schema.json` has it, and the `@afora/mcp` guide recommends it. See `docs/use-cases.md#steps`.

- Tracing (#65). `applicationOf({ trace })` takes an `ITracer`, a small structural interface of the core (`startSpan(name, attributes, parent)`, optional `withSpan(span, run)`; spans have `end(status, attributes)`), and makes a span per command operation (`command Posts.publish`), use case (`use-case Publish`) and repository call made through a use case (`repository Post.create`), at the points that log, nested as the calls are: a use case run by another nests in it, a repository method called through `this` nests in the call that made it, and the parent is passed explicitly, so nesting holds without a context manager. A span starts before the checks of its call (context, environment, dependency overrides), and the span of `command.run` covers its event policy, failing when a handler or publisher fails. Attributes are names and outcomes only (`afora.command`, `afora.operation`, `afora.use_case`, `afora.repository`, `afora.method`, `afora.outcome`); a failed span has `afora.exception.layer`, `afora.exception.name` and `afora.exception.unexpected` of the exception where it was first raised, never its message or details, and no span holds an input, argument, response or sensitive value. Without a `trace` the execution path is unchanged (no allocation or closure added). A tracer that throws (in `startSpan`, `end` or `withSpan`) breaks no call. The `trace` is inherited by `extends` and kept by `app.extend()`; `describe()` gives it as `{ kind: "opaque" }` (`ApplicationDescription.trace`). New exports: `memoryTracer` (keeps the spans with their parent, for tests), `InvalidTraceDeclaration`, and the types `ITracer`, `ITraceSpan`, `TraceAttributes`, `TraceStatus`, `MemoryTracer`, `MemorySpan`. See `docs/tracing.md`.
- New package `@afora/otel`: `otelTracer(tracer?)` adapts an OpenTelemetry `Tracer` (by default `trace.getTracer("@afora/otel")`) to `ITracer`. A command span is a child of the active span; failures set the status to `ERROR`. `@opentelemetry/api` is a peer dependency.
- `@afora/codegen`: `"trace": { "import": "./trace.ts#tracer" }` in `afora.json` generates `applicationOf({ trace })`; extraction needs `imports.trace`.
- `bun run stable:usage` (`scripts/stable-usage.ts`, after `bun run build`) writes `docs/plans/stable-usage.md`: each stable export of `@afora/core`, the examples, packages and docs that name it, and the used exports whose declarations name it (#59).

### Docs

- `docs/use-cases.md` states what steps are for and what they will never have (branching, loops, expressions), and `docs/afora-json.md` shows a use case that outgrows its steps and moves to `import` (#64).
- The content of the documentation site (#93, #67): `docs/nav.json` and `docs/site.md` give its sections, order and page types; new pages `std-properties.md`, `runtime.md`, `testing.md`, `cli.md`, `performance.md`, `faq.md`, `troubleshooting.md`, `glossary.md`, eight recipes in `docs/recipes/` (their code is run by `examples/interop/recipes.test.ts`), and the references `reference/api.md` (from the JSDoc), `reference/exceptions.md` (every exception, its layer, status and handling) and `reference/issue-codes.md`. Code examples that no longer matched the API were fixed.
- New checks, run in CI: `tests/api-surface/jsdoc.test.ts` (in `test:api`) fails on an export without JSDoc or an `@example` that does not compile; `docs:code` type-checks every ts block of `README.md`, `docs/` and the package READMEs (`<!-- docs:code skip: reason -->` and `<!-- docs:code continue -->` markers); `docs:coverage` fails when a stable, adapters or testing export is on no page; `docs:api:check` keeps the generated references up to date; `docs:links` checks that `docs/nav.json` lists every page.

### Migration

`@afora/codegen`: a handler of an `import` use case imports its base from the new file. Importing it from `use-cases.ts` keeps working only as long as no other use case (steps or `import`) depends on that handler: the dependent's `<kebab-name>.use-case.ts` imports the handler, the handler imports `use-cases.ts`, and `use-cases.ts` re-exports the dependent's file, a loop of imports that can reach the handler before its class is defined. The validator does not read handler code, so it cannot report this.

```ts
// before
import { RegisterBase } from "../domain/use-cases";
// after
import { RegisterBase } from "../domain/register.use-case";
```

**Types moved to `@afora/core/experimental` (#59).** Before:

```ts
import type { EntityStorageSettings, RepositoryCreate } from "@afora/core";
```

After: the same names, from the experimental entry; a repository method type can also be taken from `RepositoryOf`, which stays stable:

```ts
import type {
	EntityStorageSettings,
	RepositoryCreate,
} from "@afora/core/experimental";

// or, staying on the stable entry
import type { RepositoryOf } from "@afora/core";
type Create = RepositoryOf<typeof Post, ["create"]>["create"];
```

## 0.0.9 — 2026-11-11

### Changed

- Every `@afora` package (`codegen`, `mcp`, `hono`, `fastify`, `express`, `elysia`, `ws`, `drizzle`, `dynamodb`) requires `@afora/core` 0.0.9 or later: they import exports added or moved in this release (`@afora/core/adapters`, routes and access of a use case, the variant field).
- **Breaking.** The exports of `@afora/core` are split into tiers (#42); see `docs/api-tiers.md` for the tier of each one, with the reason. Application code keeps importing from `@afora/core`: everything the README and the docs show for declaring, running and serving a domain stays there (468 of 557 exports). See Migration below.
- **Breaking.** New stable subpath `@afora/core/adapters`, for authors of sinks, providers and code generators. These moved there from `@afora/core` (49): `coerceTextValues`, `outputValueOf`, `problemOf`, `PROBLEM_MEDIA_TYPE`, `statusOf`, `sinkOf`, `stageCatalogOf`, `stageKindOf`, `operationRoutes`, `routeOptionsIssue`, `requestIdHeaderOf`, `ROUTE_OPTION_KEYS`, `ENTITY_IDENTITY_KEYS`, `RESERVED_ENTITY_KEYS`, `RESERVED_RECORD_KEYS`, the symbols `Kind` and `Demo`; the provider types `IRepositoryProvider`, `RepositoryContext`, `RepositoryData`, `ProviderQuery`, `ProviderCapabilities`, `ProviderIncrementOptions`, `ProviderKeyset`, `ProviderUpdateOptions`; the sink types `OperationDescriptor`, `OperationRoute`, `Problem`, `ProblemOptions`, `SinkFactory`, `SinkSettings`, `SinkStage`; and the `app.describe()` types `ApplicationDescription`, `CommandDescription`, `ExceptionDescription`, `FieldDescription`, `FieldsDescription`, `LogDescription`, `OutputDescription`, `PropertyDescription`, `PropertyLineageDescription`, `PropertyReference`, `ProviderReference`, `RecordDescription`, `UseCaseDependencyDescription`, `UseCaseDescription`, `ProviderDescription`, `EventPolicyDescription`, `StageDescription`. Like the main entry and `@afora/core/testing`, it is part of the contract of `VERSIONING.md`.
- **Breaking.** Moved to `@afora/core/experimental`, outside the contract (9): `providerDescriptionOf`, `eventPolicyCatalogOf`, `eventPolicyDescriptionOf`, `stageDescriptionOf`, `propertyLineageOf`, `useCaseOriginOf`, `useCaseTargetOf` and the types `PropertyLineage` and `UseCaseOriginInfo`. `app.describe()` gives the same descriptions.
- **Breaking.** No longer exported (31): the base classes `AbstractProperty`, `AbstractDefineProperty`, `AbstractRecord`, `AbstractEntity`, `AbstractRepository` and `AbstractUseCase` (extend what `propertyOf`, `recordOf`, `entityOf`, `repositoryOf` and `useCaseOf` return); the guards `isApplication`, `isProviderSlot`, `isProviderStorage`, `isLogFactory`, `isBlueprint`, `isBlueprintList`, `isOptionalRecord`, `isRecordClass`, `isEnvironment`, `isProperty`, `isRecordPlugin`, `isRepository` and `isPasswordHash`; `recordFieldOf`, `schemaOf` and its type `SchemaClass`; `PropertyStates` and `UNEXPECTED_ERROR`; `PASSWORD_MIN_LENGTH`, `PASSWORD_MAX_LENGTH`, `PASSWORD_SPECIAL_CHARACTERS` and `passwordIssues`; and the `@internal` types `UseCaseContextOf`, `UseCasePluginContext` and `UseCasePluginsByName`.
- `@afora/hono`, `@afora/mcp`, `@afora/ws`, `@afora/drizzle` and `@afora/codegen` import their plumbing from `@afora/core/adapters` (and their tests `stageDescriptionOf` from `@afora/core/experimental`), so they need a `@afora/core` with that subpath. Code generated from an `afora.json` imports only from `@afora/core`, unchanged; the names it reserves for declarations (`afora_catalog` `reservedDeclarationNames`) are those of `@afora/core` only, so the names that moved can now be declared.
- `VERSIONING.md` lists `@afora/core/adapters` and `@afora/core/testing` as contract and `@afora/core/experimental` as not, uses the `**Breaking.**` marker of this file, and has the CHANGELOG template: from now on every breaking change has a Migration block, before and after. `docs/README.md` explains the tiers.
- **Breaking.** A value rejected by a property whose schema is a discriminated union (every variant an object that requires one same key with a literal, a different one in each) is told by the variant its key names, and by that one alone (#77); see `docs/properties.md`. It was told with the errors of every variant, as TypeBox `Errors` gives them: fifteen issues and more for one value, most of them about variants it was never meant to be. An object whose key names no variant, or has none, gets one issue at the key (`must be equal to one of the allowed values`, `invalid_value`). Unions that are not discriminated, and values that are not objects, are told as before. Code that counts or matches the issues of such a union gets fewer.
- A value rejected by a property whose schema is an object, an array or a union is told why without TypeBox `Errors`, as a string or a number already was: the schema is read once into its own explanation, which gives the same errors, in the same order, with the same paths, messages, locale and `maxErrors` (each variant of an `anyOf` with the limit to itself, as in TypeBox). It covers schemas made of the keywords of a leaf, `required`, `properties`, `additionalProperties: false`, `items` with one schema, `minItems`, `maxItems` and `anyOf`, at every depth; a schema with any other keyword (`allOf`, `not`, references, refinements) still goes to `Errors`. With the change above, an invalid value of the `union` case of `bench/` takes about 0.5x the time of Zod 4 `safeParse`, from 9.4x, and that case is back under the default guard limit of 1.15x.
- An entity does not check again the id and the `createdAt` it has just made with the defaults of `entityOf` (the built-in UUID v7 generator and `new Date().toISOString()`), which `Id` and `CreatedAt` keep as they are: `Entity.safeParse` takes about a quarter less time on a small object. Nothing else is trusted: the id of a generator set with `configure({ idGenerator })`, what a builder made with `entityBuilderOf` generates, and any `id` or `createdAt` the value brings are checked and handled as before.
- Creating an entity is faster (measured with `bun run bench -- --compare`, on Bun): `Entity.safeParse` takes 0.44x to 0.72x the time it took on an object of up to twenty values, about half on a small one. The default id generator builds a UUID v7 from a table of hexadecimal digits and takes its random bytes from a pool filled by `crypto.getRandomValues` every 64 ids, instead of one call and about 45 allocations per id; the ids are the same (RFC 9562, time-ordered, counting up within a millisecond). An entity also hands its `id` and `createdAt` to its record in the order of its blueprint.
- `blueprint.safeParse`, `blueprint["~standard"].validate` and the constructor of a record look up what they need of the blueprint and of the class on the first value and keep it, instead of on every value: about 5% less time on a small object for `blueprint.safeParse` and up to 12% for `Record.safeParse`. A class reads its record name (the `name` option or a `static recordName`) when its first record is built; changing a `static recordName` after that no longer changes the `source` of its issues.
- `inMemoryProvider` keys the table of an entity that declares a name (`entityOf(blueprint, { name })` or a `static recordName`) by that name instead of by its class, so a context made for a previous name of an entity reads its rows: two entity classes declaring the same name and sharing one provider now share a table. An entity without a name keeps a table of its own class.
- `useCaseOf` validates the paths of `$input` and `$context` at any depth when a steps use case is declared (through nested blueprints, list indices and `length`, and record fields; below a primitive there is no key; `$input.tags.length` is typed `number` with `strictSteps`), and `afora-codegen check` does the same; only the first key was checked.
- `useCaseOf` has one signature (it had one with `steps` and one without, so a wrong step was reported as "No overload matches this call" on the call): a type error in the settings or the steps is reported where it is. The returned class is the same; the settings type is the new `UseCaseDeclaration`. `UseCaseStepsSettings` takes `strictSteps?: boolean`.
- Validation is faster, with the same values and the same issues (#41). On the four cases of `bench/` (flat and nested, valid and invalid), `blueprint.safeParse` went from between 1.1x and 3.4x the time of Zod 4 `safeParse` to between 0.65x and 0.9x on Bun (and on Node), and `Record.safeParse` from between 1.4x and 6.4x to between 0.75x and 1.25x on Bun; see `bench/RESULTS.md`. What changed underneath:
  - A property that declares no `preHandle` skips the shape check that protects it, so its value goes through TypeBox once, not twice; `propertyOf` no longer gives every property a `preHandle` and an `afterHandle` that do nothing. A definition written on `AbstractDefineProperty` with a `handle` of its own keeps the shape check.
  - A rejected string, number, boolean, literal or enum is told why by each keyword of its schema, compiled once, instead of TypeBox `Errors`, which walks the schema on every call. The errors, their order and their messages are the same, and follow TypeBox's locale and `maxErrors`; object, array and union schemas got the same treatment later (see above), and refined schemas still go to `Errors`.
  - The path of a value is made only for an issue, and a field gives its value back without a result object.
  - `Record.safeParse` still builds the record through its constructor, for every class (a subclass with a constructor of its own and an entity included), but the record it is building no longer builds the exception of a value it rejects, with its stack and its trace: it hands its issues over. A constructor that wraps `super(...)` in `try`/`catch` catches, during a `safeParse`, a stand-in that answers as that exception (`instanceof`, `name`, `details`, `trace`...) and builds it only when it is read; see `docs/standard-schema.md`. `new Record(value)` is unchanged, inside a constructor too.
  - The `cause` of an issue raised by a property is a getter of the issue's class instead of a non-enumerable property of its own: `issue.cause`, `Object.keys(issue)`, spreading and `JSON.stringify` give what they gave; `Object.getOwnPropertyDescriptor(issue, "cause")` is now `undefined`. The issues of a rejected `Record.safeParse` are no longer a frozen array.

### Added

- `resourceOf(repository, { path, actions?, access? })` (#68): the standard `create`, `get`, `list`, `update` and `delete` for the `useCases` of `commandOf`, each with the route of a REST resource. Only a shortcut: the command is an ordinary one, typed by the repository and described by `describe()` as if written with `ctx`. With the types `ResourceAction`, `ResourceOptions` and `ResourceUseCases`. See `docs/std-use-cases.md#a-resource-in-one-line`.
- Docs (#67, #68): `docs/README.md` opens with a CRUD API that fits on one screen; `docs/tutorial.md` builds an API step by step, with Node commands beside the Bun ones and what a record is; `docs/coming-from-hono-zod.md` shows one endpoint both ways. Their listings are `examples/interop/crud.ts` and `tutorial.ts`, run by `bun run test:interop`. The quick start of the README declares the route of its use case (`POST /api/users`, 201).
- `@afora/mcp` (#75, #64, #69): the tool `afora_project` maps a project (operations, routes, access, entities), reading a TypeScript application with no `afora.json`; the guide says when a use case is steps and when it is code; the `mcpTools` sink enforces access; and what a spec names (`import`, `extends`) may not leave the project. `@afora/ws` enforces access too, from the principal of a session or an authenticator hook. `SECURITY.md` states the trust model of `@afora/mcp` and `@afora/codegen`.
- `@afora/codegen`: `route` and `access` in the `useCases` of `afora.json`, generated as settings and kept by the round trip (#75, #60); see `docs/afora-json.md#routes-and-access`.
- `@Route` and `@Access` accept the declaration the class already has, so a hand-written class may repeat what its generated base carries; a different one still throws `InvalidUseCaseDeclaration`.
- Three new packages, sinks that serve an output on other servers (#75): `@afora/fastify`, `@afora/express` and `@afora/elysia`. Each takes the options of `@afora/hono` (the `HttpOptions`) and the hooks `authenticator`, `middlewares` (of its server) and `app`, and is built on `compileRoutes`. See `docs/providers.md`.
- `httpProviderContract(name, { sink, fetch, close? }, runner)` in `@afora/core/testing`: the cases every sink that serves HTTP must pass, on real requests (declared routes, input from each place, context, problems, statuses, masking, access, cookies, request id, the document), with the type `HttpProviderContractSettings`. The four HTTP packages run it.
- Tokens and sessions, **experimental** (#60, #75), see `docs/auth.md#tokens-and-sessions`:
  - `jwtOf(options)` in `@afora/core/experimental`: JSON Web Tokens signed with a shared secret (HS256, HS384, HS512) on Web Crypto, with `sign`, `verify` (a `Principal`, or `Unauthenticated`) and `authenticator({ header?, cookie? })`; `InvalidJwtOptions` and the types `Jwt`, `JwtOptions`, `DescribedJwtOptions`, `JwtAlgorithm`, `JwtSubject`, `JwtTokenOptions` and `StdTokenOptions`.
  - The option `auth: { jwt: { secret: { env }, issuer?, audience?, algorithm?, header?, cookie? } }` of the sinks that serve HTTP (`HttpOptions`) authenticates callers from such a token and gives the OpenAPI document its security scheme.
  - The standard `login` takes `token: { secret: { env }, issuer?, audience?, expiresIn?, algorithm?, refresh?, scopes?, scopesFrom?, claims? }` and then answers a `token` (and a `refreshToken`) with the entity; new standard use cases `refresh` (a refresh token for new tokens) and `logout` (empty tokens, which remove cookies). Without the option `login` is as before.
  - Where these options are described (`describe()`, `afora.json`), the secret is named by its environment variable and a written secret is rejected.
- Every standard use case takes `route` and `access`, passed to `useCaseOf`.
- A route can send keys of the response as cookies: `setCookie: { [responseKey]: { name, httpOnly?, secure?, sameSite?, path?, domain?, maxAge? } }` (by default `HttpOnly; Secure; SameSite=Lax; Path=/`). The key leaves the body, an empty text removes the cookie, and the `openapi` sink leaves the key out of the response schema and documents `set-cookie`. An `OperationRoute` gains `setCookies`.
- `compileRoutes(operations, options, context, { source, authenticator?, document? })` in `@afora/core/adapters` (#75): the route table of an output for a sink that serves HTTP on any server. Reading the body, query, path, headers and cookies, coercion, the context, the caller, statuses, problems, the request id and the docs route are decided once, and a sink only routes each `{ method, path }` to `handle(request)` and sends its `{ status, headers, cookies, body }`. With it: `HTTP_OPTION_KEYS`, `httpOptionsIssue` and the types `HttpOptions`, `HttpRequest`, `HttpResult`, `CompiledRoute`, `RouteTable`, `CompileRoutesSettings`, `Authenticator` and `AuthRequest`.
- `sinkOf` factories take a second argument, the hooks (`sink(options, hooks)`), for what JSON cannot hold; `build` receives it as its fourth argument and the description of the stage leaves it out. `SinkSettings` and `SinkFactory` have a third type parameter for it.
- Authorization declared and enforced (#60, #75): the `access` setting of `useCaseOf` or the decorator `@Access(...)` says who may call a use case: `{ public: true }`, or an authenticated caller with all the `scopes`, that is the `owner` named by an input key (its subject, or a `claim`), with keys of the `context` filled from the caller over what the request sent. The check is made once per operation and runs in `invoke(input, { context, principal })`, before the input is validated, so every sink enforces it, and one that passes no principal fails closed. New exports of `@afora/core`: `Access`, the exceptions `Unauthenticated` (401) and `Forbidden` (403, `details.reason` `"scope"` or `"owner"`), both of the `Output` layer and known to `statusOf`, and the types `AccessDeclaration` and `Principal`. See `docs/auth.md`.
  - An `OperationDescriptor` has an optional `access`, and `OperationCallOptions` an optional `principal`.
  - The `openapi` sink derives the `security` of an operation from its access (the `default` scheme, else the only one, with the declared scopes; `security: []` for a public one under a `default`) and documents its `401` and `403`. `security.operations[id]: false` on an operation with an access throws `InvalidOutputStage`.
  - `app.describe().useCases.<name>.access` carries the declaration.
  - A call in process (`execute`, `app.run`, `command.run`) is not checked.
- A use case can declare its HTTP route (#75, #68): the `route` setting of `useCaseOf` (`{ method, path?, status?, query?, headers?, cookie? }`) or the class decorator `@Route(method, path?, options?)`, which record the same frozen data in the static `route`. The blueprint stays the only description of the input; the route says which keys are read from the path, the query, a header or a cookie, and those must be scalar keys with one place each (`InvalidUseCaseDeclaration` otherwise). `@Route` is a standard decorator (no `experimentalDecorators`, no `Symbol.metadata`) that also runs as a legacy one. New exports of `@afora/core`: `Route` and the types `RouteDeclaration` and `RouteSettings`. See `docs/use-cases.md#routes`.
  - An `OperationDescriptor` has an optional `route`, and `operationRoutes` resolves method, path and status from the `route` option of the sink, then the route of the use case, then the default. An `OperationRoute` gains `body`, `query`, `requestHeaders` and `cookies`.
  - The `openapi` sink documents the keys a route reads elsewhere as `in: query`, `in: header` and `in: cookie` parameters and leaves them out of the request body.
  - `app.describe().useCases.<name>.route` carries the declaration.
  - The error for two operations on one method and path names both operation ids.
- `variantOf(key, variants)` and `ctx.variantOf` (#80): a field that holds one of several blueprints, told apart by the value of `key`, which is the name of the variant; see `docs/blueprints.md`. The blueprints do not declare the key, the field adds it, first. A value is handled by the blueprint its key names as a nested blueprint handles it (handlers, issues with their codes and paths, frozen result), and its type is the union of the variants, narrowed by the key. `optionalOf` and `listOf` take it; it has a `~standard`; `toJSON` masks the sensitive properties of a variant; `stripUndeclared`, `describe()` (a new `kind: "variant"` of `FieldDescription`), the schema lock and `diffSchemas` (each variant by its name) and `toOpenAPI` (`oneOf` with a `discriminator`) handle it. `variantOf` is a reserved key of the blueprint context, so a plugin that declared a property or a factory with that name now throws `ReservedBlueprintKey`. New types: `IBlueprintVariant`, `AnyBlueprintVariant`, `OptionalBlueprintVariant`, `BlueprintVariants`; new exception: `InvalidBlueprintVariant`. A variant can also be a record class or an entity: the value is then an instance, told apart by its class, and the key is only in the plain value given, in `toJSON` and in what is stored; an entity is stored by reference as `{ [key]: name, id }` and read back through the relations of the repository. Not yet: `sliceOf` by the keys of a variant, and the schema evolution options of the properties inside a variant on read. A union that needs no properties of its own is still faster as the schema of one property (about half the time on valid values), which is what the `union` case of `bench/` measures.
- `afora.json` has a variant field (#80): `{ "variant": { "key": "type", "of": { "click": "Click", "visit": { "fields": { "path": "string" } } } } }`, where each variant is a declared blueprint, record or entity, or a blueprint declared in place, and `optional` and `list` apply as to the other forms; see `docs/afora-json.md`. `@afora/codegen` validates it (new issue code `invalid_variant`: an empty key, no variant, a variant that declares the key, a record or an entity named by two variants; `unknown_type`, `wrong_kind`, `missing_relation` for an entity among the variants, `invalid_environment_field`, and `invalid_index` for an `orderBy` on it), follows `$input` paths into it, generates it as `ctx.variantOf(...)`, and extracts it back from `describe()`, where it threw an `ExtractionError`. `afora.schema.json` and the field schema of the `@afora/mcp` tools have the new form, and the `@afora/mcp` guide teaches it. New types `VariantField` and `VariantSpec` in `@afora/codegen`. The generated code hugs a last object argument of `listOf` as Biome prints it (`listOf(X, {` on the first line) when the call does not fit on one line; such a call was broken argument by argument, which Biome reformats.
- A new kind of field costs the editor about 3% more type work per edit in every case of `tests/type-perf`; its ceilings were raised by that, and the largest case is at 98% of the target.
- `examples/agent-built`: a ticketing backend built only through the `@afora/mcp` tools from a written brief (`BRIEF.md`), with the tool calls committed and replayed byte for byte (`scripts/replay.ts`), and an invariant evaluation on the running API (`eval/`): no sensitive value in any response, undeclared keys rejected, business errors as problem+json with the right status and never a 5xx, unique keys enforced, checked on every afora run and on a hand-rolled Hono + Zod baseline from the same brief. `scripts/build-with-agent.ts` and `scripts/build-baseline.ts` make N runs with the Claude API (`bun run eval:agent-built`, needs `ANTHROPIC_API_KEY`); the committed runs are one Claude Code session and its baseline, see `examples/agent-built/README.md`. Its tests run in CI (`bun run test:agent-built`).
- The README leads with the application as data and agent-written backends (#40): a 30-second path from an `afora.json` to a running API, and a "Why afora" section mapping the guarantees an agent-written backend usually breaks to the mechanism that keeps each one.
- The Strata Matéria brand (#46): README banners for the light and dark themes in `.github/assets/`, and the fluid, mono and app icon symbols in `.github/assets/brand/`.
- Schema evolution (#28), see `docs/schema-evolution.md`:
  - Property options `fill` (the value a stored row lacking the key gets, on read and in a backfill; unlike `default`, the demo value) and `renamedFrom` (the key that held the value before), in `.with()`; both kept in the lineage `describe()` gives.
  - Entity options `schemaVersion`, `upgrade: { [version]: (data) => data }` and `previousNames`. Every write of an entity with `schemaVersion` stores it in the row under `SCHEMA_VERSION_KEY` (`"$v"`), which such an entity cannot declare (`ReservedEntityKey`); a row without it is version 1. Invalid options throw the new `InvalidEntitySchemaVersion` (layer `entity`); a previous name equal to the record name of an entity without `name` (its class name) throws it when its repository is declared, and `app.migrate` skips a previous name equal to the entity's own, which a destructive run would otherwise empty. `describe().entities.<Name>` has `schemaVersion`, `upgrade` (the versions with a step) and `previousNames` when declared.
  - Upcast on read: for an entity declaring any of them, each row read (and each row of a related entity) runs its `upgrade` steps from the stored version, then the automatic steps of the current blueprint (renames, fills, keys no longer declared left out), at any depth, before it is parsed. Other entities are read as before. A stored version that is not a positive integer or is above `schemaVersion` throws `InvalidRepositoryData` caused by the new `InvalidStoredSchemaVersion` (layer `repository`). `increment` of a key with `renamedFrom` first writes the row brought up when it still holds the old key, so the delta adds to the stored value.
  - `app.migrate({ entities?, mode: "check" | "apply", destructive?, pageSize?, lock? })` walks each provider and gives, per entity, `{ scanned, upToDate, upgraded, removalPending, invalid, movedFromPreviousNames, removedKeys, deferred }`: in `apply` it calls `provider.migrate(context, plan)` (which gives `{ deferred: true }`, `ProviderMigrationResult`, when it only wrote the plan for later: the backfill of that entity is then skipped and reported `deferred`), rewrites the rows below the version or with a fill or rename pending, and moves the rows of previous names; keys and old rows are removed only with `destructive: true`. Idempotent and resumable. Invalid options throw the new `InvalidSchemaMigration` (layer `application`). New types `SchemaMigrationOptions`, `SchemaMigrationReport`, `EntityMigrationReport`, `SchemaMigrationInvalidRow`.
  - `schemaLockOf(app.describe())` (the normalized lock, `afora.lock.json`; `SchemaLockEntity.upgrade` lists the versions with a step), `diffSchemas(lock, current)` (each change classed `automatic`, `declared` or `check`, with `satisfied` and `destructive`) and `schemaLockProblemsOf(lock, current)`. `app.start({ lock })` throws the new `SchemaLockMismatch` (layer `application`) when an entity of the lock is gone without a `previousNames` naming it, or when a `schemaVersion` is lower than the lock's.
  - `providerContract` has schema evolution cases (`{ schemaEvolution }`, default `true`), and `{ schemaVersionKey }` (default `true`) for those storing `$v`. Providers made with `providersOf` and `providerFrom` forward `migrate`.
- `@afora/dynamodb`, a new package (#33): `dynamoDbProvider({ table, client })`, a repository provider on one DynamoDB table (`pk` / `sk`; entities at `E#<repository name>`, unique keys enforced by marker items written in the same transaction), with `keyset`, `versioning`, `atomic` and `expiry`, verified by `providerContract` on DynamoDB Local in CI. `migrate` is a no-op: the schema version key and any other key stay in the item data. See `packages/dynamodb/README.md`.
- `@afora/drizzle`: opt-in `migrations: "apply" | { file }` gives the provider a `migrate(context, plan)` that turns a `SchemaPlan` into DDL for SQLite and Postgres (added, renamed and, when destructive, removed columns, unique indexes, the schema version column), run on the database or written as a drizzle-kit compatible SQL file (then `migrate` returns `{ deferred: true }` and the backfill waits for the next `app.migrate`); `$v` maps to a `schema_version` column. See `packages/drizzle/README.md#schema-evolution`.
- `strictSteps: true` in `useCaseOf` checks the steps written inline at compile time (#43): every `$` reference must name a value in scope at any depth (the input, the context, an environment or the result of an earlier step, typed from what it calls or builds), the `args` of `find`, `invoke` and `run` must fit the parameters of the repository method, record method or function, the `values` of `build` the input of the record class (unknown and missing keys included), the `value` of `change` and of the repository writes and the `input` of `call` what they take, `invoke.method` a public method and `change.key` a change key of the record. A wrong reference is reported with the references that fit, which the editor completes inside a `"$"` string. Opt-in, as it costs about 17% more per edit on a five-step use case; no effect at run time. New types `CheckedSteps`, `StepReferenceType`, `StepReferencesOf`, `StepValueCheck`, `StepsInitialScope` and `UseCaseDeclaration`. See `docs/use-cases.md#strict-steps`.
- `@afora/codegen` generates steps use cases with `strictSteps: true`, so type-checking the generated code checks their steps.
- `bun run bench:guard` (and the `bench` job in CI) fails when `blueprint.safeParse` takes more than 1.15x the time of Zod 4 `safeParse` in any of the four cases.
- The benchmark (`bench/`) has seven scenarios instead of two (`flat`, `nested`, `api-payload`, `large-list`, `union`, `deep`, `no-transform`) and five more libraries (Ajv, Typia, Effect Schema, Yup and Joi, next to TypeBox, Zod 4, Valibot and ArkType). Every contender is checked before it is timed (it accepts the valid input, rejects the invalid one and rejects an undeclared key), each row is timed by a process of its own, after a warm-up and in three rounds taking turns with the others (in one process a row depended on the rows before it), the tables give p75, p99 and the margin of the mean, and rows whose intervals overlap are reported as tied. It also measures the bundle size and the cold start of each library. The report is `bench/results/latest.json` (with the version of every library), from which `bench/RESULTS.md` is generated; `bench/README.md` tells how it is measured and how to contest a row. `bun run bench -- --only <ids>` runs some scenarios, `--rounds <n>` sets the rounds and `--jobs <n>` runs rows side by side to iterate (its times are not published).
- The Performance section of the README has a table and a chart generated from `bench/results/latest.json` (`bun run bench -- --render`), and `bun run bench:check`, in CI, fails when they, `bench/RESULTS.md` or the chart were edited by hand.
- A pull request is timed against its base (`bun run bench -- --compare <checkout>`, the `Benchmark against the base` workflow): it fails when `blueprint.safeParse` takes more than 1.1x its base on a case, and the table is posted on the pull request. The same workflow runs the cases on CodSpeed once the repository variable `CODSPEED_ENABLED` is `true`.
- The cold start of `bench/` is timed by a file that imports the bundle, not by an inline script (`-e`), which Bun runs 1.5x to 4x slower: afora was reported at 62 ms on Bun where it takes 23 ms (Apple M2), and ArkType, Ajv and Joi were overstated the same way. The entry of afora is bundled with one copy of TypeBox instead of two. The numbers published so far for cold start on Bun are from before this (#86).
- `bench/RESULTS.md`, the table and the chart of the README are those of a GitHub runner (AMD EPYC, Linux, Bun 1.4.4 and Node 24), measured by the `Benchmark results` workflow instead of on a laptop, and kept as `bench/results/history/0.0.8.json`.
- The `Benchmark results` workflow, run by hand or after a release, measures everything on a GitHub runner and opens a pull request with the results, kept per version in `bench/results/history/`.
- `bun run bench:guard` covers the fourteen cases of the seven scenarios, each with its limit against Zod 4 in `bench/guard.limits.ts` (1.15x unless stated, with the reason).
- The benchmark runs on several versions of Node: `BENCH_NODE_BINS` lists the Node binaries (paths separated by `:`, or `;` on Windows), one run per binary, and the `Benchmark results` workflow measures Node 22 and Node 24. `bench/RESULTS.md` names each run by its version, the cold start has a column per version, and the block of the README leads with the newest Node. `bench/results/latest.json` is now `schema: 2` (a run per Node version; the cold start keyed by the version of the runtime instead of `bun` and `node`); `bench/render.ts` still reads schema 1.
- `bun run bench:guard` and `bun run bench -- --compare` warm each contender up for 400 ms before its first round, as a row of the benchmark is, so that no ratio is taken on code the engine has not optimized yet.

### Fixed

- The README's steps to generate and serve the quick start's `afora.json` passed `--stages @afora/hono`, which `afora-codegen` resolves as a path and fails on; they now use a `stages.ts` that re-exports `stages` from `@afora/hono`. The three files are `examples/interop/from-json`, generated and served by `bun run test:interop`.

### Migration

**Sinks and providers import their plumbing from `@afora/core/adapters`.** Before:

```ts
import {
	exceptionOf,
	type IRepositoryProvider,
	type OperationDescriptor,
	outputValueOf,
	problemOf,
	type RepositoryData,
	RepositoryUniqueViolation,
	sinkOf,
	statusOf,
} from "@afora/core";
```

After: the exceptions and the declaration API stay in `@afora/core`, the rest comes from the adapters entry. Both entries share one module state, so classes and symbols are the same objects.

```ts
import { exceptionOf, RepositoryUniqueViolation } from "@afora/core";
import {
	type IRepositoryProvider,
	type OperationDescriptor,
	outputValueOf,
	problemOf,
	type RepositoryData,
	sinkOf,
	statusOf,
} from "@afora/core/adapters";
```

**Description helpers come from `@afora/core/experimental`.** Before:

```ts
import {
	providerDescriptionOf,
	stageDescriptionOf,
	useCaseTargetOf,
} from "@afora/core";
```

After (or read the same data from `app.describe()`, typed `ApplicationDescription` from `@afora/core/adapters`):

```ts
import {
	providerDescriptionOf,
	stageDescriptionOf,
	useCaseTargetOf,
} from "@afora/core/experimental";
```

**Base classes and guards are gone.** Before:

```ts
import { AbstractEntity, isRepository } from "@afora/core";

if (value instanceof AbstractEntity) save(value);
if (isRepository(dependency)) register(dependency);
```

After: test against your own declarations, or the guards that stay (`isEntity`, `isEntityClass`, `isUseCase`, `isUseCaseClass`, `isCommand`, `isOutput`, `isUseCasePlugin`, `isUseCaseCatalog`, `isProviderFactory`):

```ts
import { isEntity } from "@afora/core";

if (isEntity(value)) save(value);
if (dependency === Posts) register(dependency);
```

**Password rules.** Before, `PASSWORD_MIN_LENGTH` and `passwordIssues(plain)` were exported. After, check a plain password with `PlainPassword`, which holds the same rules, or let `Password.hash` reject it:

```ts
import { InvalidPropertyValue, Password, PlainPassword } from "@afora/core";

const result = PlainPassword.safeParse(plain); // { success: false, issues } when a rule is broken
try {
	await Password.hash(plain);
} catch (error) {
	if (error instanceof InvalidPropertyValue) error.details; // { errors: [...] }, what passwordIssues gave
}
```

## 0.0.8 — 2026-11-10

### Changed

- Every `@afora` package (`codegen`, `mcp`, `hono`, `drizzle`, `ws`) requires `@afora/core` 0.0.8 or later: they import exports added in this release, and specs with indexes, records that expire, versioned entities or use case hooks generate code that uses them.
- `CommandEventInfo` has `publisher(name)`, and a handler policy that throws a `CommandEventFailed` itself has it passed up as it is instead of wrapped.
- An application with `publishers` rebinds its use cases and commands, as one with a `provider` or a `log` does, so `app.commands.X` is not the declared command.
- **Breaking.** A repository declared at module level throws the new `RepositoryUsedOutsideApplication` (layer `repository`) once an application with a provider binds it, instead of reading and writing its own store; the message points to `app.repositories.X`, `app.run` and `execute`. Repositories no application binds work as before. See Migration below and `docs/repositories.md`.
- **Breaking (types).** `findCursor` is left out of the repository type when the declared `provider` cannot read by cursor (the type of its `capabilities` has a `keyset` that cannot be `true`; a provider with no `capabilities` keeps it in the type and is rejected at declaration); `inMemoryProvider()` (now typed `InMemoryProvider`), `providerOf` and `drizzleProvider` (`DrizzleProvider`) keep literal capabilities. Declaring `findCursor` with such a provider throws `InvalidRepositoryDeclaration`, and `app.start()` throws `InvalidApplicationDeclaration` when the provider it makes lacks `keyset` and a repository declares `findCursor`. `RepositoryOf` (type) takes a fourth parameter, `Keyset`, and `RepositorySettings` a fourth, `Provider`.
- `app.describe().repositories.<Name>` has `indexes` and `scans`.
- The function of a `run` step gets `{ context, dependencies }` after its args: the dependencies as the call resolved them, overrides included (it got `{ context }`).
- `routeOptionsIssue` rejects a `route[id].path` with `:` or `*`, which used to pass and was ignored by the document; a parameter is written `{name}`.

### Added

- `stripUndeclared(shape, value)`: a copy of `value` with only the keys `shape` declares, at any depth (nested blueprints, list items, `optionalOf`, records and entities held as fields), for payloads that carry more than an operation reads, before parsing. It does not validate, never throws and does not change `value`. See `docs/standard-schema.md`.
- Event policies: `eventPolicyOf({ name, validate?, handle, publishers? })` makes a factory of `events` handlers with JSON options, which an application describes as `{ kind: "policy", name, options }` instead of `{ kind: "opaque" }`; `eventPolicyDescriptionOf`, `eventPolicyCatalogOf` and `StdEventPolicies` go with it. The built-in `publishEvents({ publisher, topic, events?, handle?, onPublishError? })` runs each event's handler, then publishes `{ name, command, operation, entity }` (the entity masked by `toJSON`) to a publisher of the application, with topic placeholders `{event}`, `{command}`, `{operation}` and `{id}`; a failed publish is logged (`event-publish-failed`) or thrown. `applicationOf({ publishers })` declares publishers by key (inherited, checked against the policies of its commands, `describe().publishers`), and `CommandEventInfo.publisher(name)` resolves one for a handler. New exceptions `InvalidEventPolicy` and `PublisherNotBound`; new types `IEventPublisher`, `PublishedEvent`, `PublishEventsOptions`, `EventPolicySettings`, `EventPolicyFactory`, `EventPolicyDescription`, `EventPolicyOptions`, `IEventPolicyCatalog`. `memoryPublisher()` in `@afora/core/testing`. See `docs/commands.md#event-policies`.
- `eventOf(name, Entity)` takes no handler: such an event only carries the entity, for a policy such as `publishEvents`. `describe()` gives the lifecycle events of an entity (`entities.<Name>.events`, by cycle, `{ name, handler }`).
- `afora.json`: an entity declares its lifecycle events, `"events": { "onCreate": "created", "onUpdate": [{ "name": "audited", "handler": { "import": ... } }] }`, generated as `<Name>Events` with `eventOf` and the entity's `onCreate`/`onUpdate`/`onDelete`, extracted back (`entities.<Name>.events.<event>` in `imports` for a handler); new issues `invalid_event` and `event_conflict`.
- `afora.json`: `"events": { "policy": "publishEvents", "options": {...} }` on a command and the top-level `"publishers": { key: { "import": ... } }`, validated (`unknown_event_policy`, `invalid_event_policy_options`, `unknown_publisher`, `invalid_publishers`), generated and extracted (`publishers.<key>` in `imports`); `--policies <module>` (codegen and `afora-mcp`) adds event policies of other catalogs.
- `@afora/ws`, a new package: the `websocket` sink serves the operations of an output over JSON messages (`{ id?, op, input? }`), on any runtime, with topic subscriptions (`{ subscribe }`) that `publishEvents` fills through `wsHub()`. See `packages/ws/README.md`.
- `coerceTextValues(blueprint, texts)`: text values as the scalar fields of a blueprint take them (numbers, booleans), for sinks that read text; `@afora/hono` and `@afora/mcp` now use it instead of their own copies.
- `@afora/hono`: the `webhooks` option verifies the signatures of incoming webhooks (Stripe, GitHub, Standard Webhooks, plain HMAC-SHA256) and can strip undeclared keys. See `packages/hono/README.md#webhooks`.
- Repositories declare indexes: `repositoryOf({ indexes: { byTypeStatus: { where: ["type", "status"], orderBy: "publishedAt" } } })`, typed by the entity keys and checked at declaration (unknown, sensitive or repeated keys, a non-scalar `orderBy`, duplicate indexes throw `InvalidRepositoryDeclaration`). The provider gets them as `context.indexes` and the one that serves a query as `ProviderQuery.index`; `ProviderCapabilities.indexes` says a provider serves them from storage. See `docs/repositories.md#indexes`.
- Query cost: each read is planned as `id`, `unique`, `index` or `scan`; the new `explain(query)` action gives the plan without reading, and `scans: "allow" | "warn" | "reject"` runs a scan, logs `repository-scan` and runs it, or throws `InvalidRepositoryQuery` (`details.scan: true`) before the provider is called. New types `RepositoryIndex`, `RepositoryPlan`, `RepositoryScans`, `RepositoryExplain`, `ProviderKeyset`, `InMemoryProvider`. See `docs/repositories.md#query-cost`.
- `providerContract` takes `{ indexes }` (default `capabilities.indexes`) and checks that a query given `index` answers as the scan does; `inMemoryProvider` and `@afora/drizzle` pass it.
- `afora.json`: repositories take `indexes` and `scans` and the action `explain`, validated (new issues `unknown_index_key` and `invalid_index`), generated, normalized and extracted. See `docs/afora-json.md#indexes-and-query-cost`.
- `@afora/drizzle`: accepts `ProviderQuery.index` with the same rows, and its README tells how to declare the matching SQL index.
- Standard use cases that write (`create`, `update`, `delete`, `restore`, `publish`, `unpublish`, `archive`, `unarchive`, `tag`, `untag`, `register`) take `before`, `after`, `dependencies` and `throws`: `before({ input, entity?, dependencies, context })` runs before the write and may give back the input to go on with; `after({ entity, input, dependencies, context })` runs after it, within the transaction of the command; `dependencies` (repositories, use cases, environments, `Logger`) join those the use case makes; `throws` adds exception classes to its `errors`, so `describe()` and the statuses of outputs know them. Typed from the repository and the options; `get`, `list` and `login` reject them (a type error, and `UseCaseUnavailable`). `describe()` names the dependencies among the options of a standard use case by their registered names. New types `StdHookArgs`, `StdHookOptions` and `StdNoHookOptions`. See `docs/std-use-cases.md#before-and-after`.
- JSON properties: `ctx.json` (`JsonProperty`) holds any JSON value (typed `JsonValue`), rejecting `undefined`, functions, `NaN`, class instances and cycles; `jsonOf({ schema })` (`ctx.jsonOf`) holds JSON checked by a JSON Schema known at declaration, typed by it; `checkJsonSchema(schema, value, { source })` checks data against a schema loaded at runtime with TypeBox `Value` (no compiling, so it runs on Workers) and throws the new `InvalidJsonData`, whose `details.issues` are afora issues (a 400), and `jsonSchemaIssues` gives those issues without throwing. A schema that is not a JSON Schema throws the new `InvalidJsonSchema`. Also exported: `JsonClass`. See `docs/properties.md#json`.
- `afora.json`: the standard use cases that write take `before` and `after` (`{ "import": ... }`), `dependencies` and `throws` in their `options`, validated, generated and extracted (`useCases.<Name>.before` and `.after` in `imports`); `"json"` is a field type.
- `openapi` sink and `RouteOptions`: path parameters (`route[id].path: "/entries/{slug}"`, each `{name}` a whole segment naming a scalar input key, documented as a required `in: path` parameter and left out of the body or query), `route[id].status` (`200 | 201 | 202 | 204`; `204` without content), `responses: { [operationId]: { headers } }` (static headers of successes), `requestId: true | "<header>"` (documented on every response) and `security: { schemes, operations?, default? }` (`components.securitySchemes`, the document `security` and each operation's; `false` marks an operation public). `OperationRoute` gains `parameters`, `status` and `headers`; new exports `ROUTE_OPTION_KEYS`, `requestIdHeaderOf` and the types `RouteStatus`, `OpenAPISecurityScheme`, `SecurityRequirement`. See `docs/outputs.md`.
- `@afora/hono`: serves the path parameters (the path wins over the body or query), the success `status` (`204` without a body), the `responses` headers and `requestId` (propagated or generated with `crypto.randomUUID`, on successes and problems), and takes context from middleware with `context.variables: { [contextKey]: variableName }` (`c.get`, not coerced). `security` reaches the document only. See `packages/hono/README.md`.

### Migration

**Module-level repositories after binding.** Before, the module-level repository silently read another store once an application bound it:

```ts
const app = applicationOf({ name: "blog", repositories: { Users }, provider });
await Users.findById(id); // read the in-memory store of the declaration, not `provider`
```

After, it throws `RepositoryUsedOutsideApplication`; go through the application:

```ts
await app.repositories.Users.findById(id);
await app.run(Register, input); // or new app.useCases.Register(input).execute()
await new Register(input).execute({ users: app.repositories.Users });
```

**`findCursor` and providers without keyset.** Before, the type offered `findCursor` on any provider, and the call threw at run time:

```ts
const Posts = repositoryOf({
	entity: Post,
	actions: ["findCursor"],
	provider: kv,
});
await Posts.findCursor(); // InvalidRepositoryQuery: the provider does not read by cursor
```

After, `repositoryOf` throws `InvalidRepositoryDeclaration` and the type has no `findCursor`. Page with `findPage`, or give the provider `capabilities: { keyset: true }` and honor `after` in its `findMany`. A provider typed as the wide `IRepositoryProvider` keeps `findCursor` in the type; `const kv = { ..., capabilities: { keyset: true } } as const` (or `providerOf`) keeps the literal.

### Page walker (#37)

- The repository action `forEachPage(query, fn, { until? })` walks the pages of a `findCursor` query and awaits `fn(items, { index, next })` on each, for bulk work (deleting entries, rewriting rows, migrations), and gives `{ done, next?, pages, items }`. `until`, a deadline (`Date` or epoch milliseconds) or a function, is checked before each page; when it stops the walk, `done` is `false` and `next` is the `after` to resume from (the `after` given when no page ran). Rows added or removed between pages or calls, by `fn` too, are neither repeated nor skipped. An error of `fn` rejects through the repository; it needs `findMany` and a provider with `capabilities.keyset`. In a use case, the repository `fn` calls has the overrides of `execute`. New types `RepositoryForEachPage`, `RepositoryWalkOptions`, `RepositoryWalkPage` and `RepositoryWalkResult`. See `docs/repositories.md`.
- `@afora/codegen` and `@afora/mcp` accept `forEachPage` in the `actions` of a repository; a `find` step that names it is rejected with a clear reason, in `afora.json` and in core steps, as it takes a function.

### Records that expire (#35)

- `entityOf(blueprint, { expires })`: `{ after: { days?, hours?, minutes?, seconds? } }` keeps `createdAt` plus the duration in a read-only `expiresAt` identity key (the new std property `ExpiresAt`), and `{ at: key }` expires on the date held by a key of the blueprint (typed as one of its keys); a record without a date never expires. An invalid option throws the new `InvalidEntityExpiry` when the entity is declared. `entityBuilderOf` takes an `expiresAt` field for it. New types `ExpiresAtField` and `ExpiringIdentity`; `EntityExpires`, `EntityStorageOptions` and `EntityOptions` take the key of `at` as a parameter. See `docs/entities.md#records-that-expire`.
- Repositories leave expired records out of every read (`findOne`, `findMany`, `count`, `exists`, `findPage`, `findCursor`, `findBy<Key>`, `findManyBy<Key>`) unless the query has `withExpired: true`, a new option of `RepositoryQuery` and `RepositoryCursorQuery`. Unique keys still count expired records, relations still load them (`loadByIds` reads with `withExpired: true`), and `update` / `delete` of an expired entity you hold are unchanged. See `docs/repositories.md#records-that-expire`.
- Providers: `RepositoryContext.expiry` (`{ key }`) for an entity that expires, `ProviderQuery.now` (ISO 8601, from the clock of the entity) and `withExpired`, given only for such an entity; `findOne` and `count` of `IRepositoryProvider` take a `ProviderQuery`. A provider leaves expired rows out when it sets `capabilities.expiry`, which an entity that expires needs (otherwise its reads throw `InvalidRepositoryQuery`). `inMemoryProvider()` and `@afora/drizzle` have it, and `providerContract` checks it in its `expiry` cases (the table needs an `expiresAt` column).
- `describe()` gives `entities.<Name>.expires` as declared (an `expiresAt` of `after` is left out of `fields`, as the identity is), and `afora.json` takes `"expires"` on an entity: validated (`invalid_expires`, `identity_key` for a field named `expiresAt` with `after`), generated as the option of `entityOf` and extracted back. `@afora/mcp` teaches it in its guide.

### Optimistic concurrency and atomic increment (#44, #34)

- Versioned entities: `entityOf(blueprint, { versioned: true })` adds a `version` identity key (`EntityVersion`, a positive integer, 1 when built), read-only and present on the instance type only for a versioned entity (`VersionedIdentity`, `IEntityVersion`). The repository's `update` writes only when the stored version is still the one the entity was read with, and bumps it (also the entity's); otherwise it throws the new `RepositoryConcurrencyConflict` (Repository layer, `details: { id, expected, actual? }`), which `statusOf` maps to 409. A soft `delete` and `restore` check and bump it too. A provider without `capabilities.versioning` makes the first write of a versioned entity throw `InvalidRepositoryDeclaration`. The standard use cases leave `version` out of their inputs, `app.describe()` marks the entity `versioned: true`, and OpenAPI schemas give `version` as read-only. See `docs/entities.md#versioned-entities` and `docs/repositories.md`.
- `IRepositoryProvider.update(context, data, options?: { expectedVersion? })` (`ProviderUpdateOptions`): with `expectedVersion`, a provider with `capabilities.versioning` compares the stored `version` in the same atomic step as the write. `inMemoryProvider()` advertises `versioning: true`.
- The `increment` repository action: `increment(idOrEntity, deltas, { create? })` adds numbers to keys of the entity in one atomic write and gives the entity as stored; only number keys of its `change` list, checked by type (`EntityIncrementKeyOf`, `RepositoryIncrementDeltas`) and at runtime (the new `InvalidRepositoryIncrement`, with issues, a 400). It stamps `updatedAt`, bumps the version of a versioned entity and queues `onUpdate`; without `create` a missing id throws `RepositoryEntityNotFound`, with it the entity is built from `create` and the id (deltas added, validated, `onCreate`) and inserted, and a concurrent create loses nothing. Also exported: `RepositoryIncrement`, `RepositoryIncrementOptions`.
- `IRepositoryProvider.increment?(context, id, deltas, { set?, create? })` (`ProviderIncrementOptions`), advertised with `capabilities.atomic`, and needed by the action. `inMemoryProvider()` implements it (`atomic: true`), as does a provider of `providersOf` or `providerFrom` that forwards to one.
- `providerContract` runs the cases of `versioning` (a stale version, two updates with the same one, no expected version) and `atomic` (concurrent increments, a missing id with and without `create`, concurrent creates, soft-deleted rows, an increment then a stale update), gated by the capabilities or the options of the same names. Their rows use the `version` and `visits` columns.
- Steps: a `find` step naming `increment` is `write_in_find`.
- `increment` with `create` on an entity that expires treats an expired record as absent: it replaces it with a fresh one (new `createdAt` and `expiresAt`, `version: 1`, the deltas applied), the window of a rate limiter; without `create` it is `RepositoryEntityNotFound`. The provider gets `now` in `ProviderIncrementOptions`.

## 0.0.7 — 2026-11-10

### Changed

- `@afora/codegen` requires `@afora/core` 0.0.7 or later: a spec with standard use cases generates code that uses `StdUseCases`.
- `commandOf` is now the standard one, `commandBuilderOf(StdUseCases)`: its declared type is `CommandBuilder<StdUseCaseContext>` and `useCases` also accepts a function of the standard use cases. Calls with an object are unchanged; `commandBuilderOf()` gives the one without them.
- `statusOf` gives 404 for `UseCaseEntityNotFound`, 409 for `UseCaseEntityConflict` and 401 for `UseCaseInvalidCredentials`.

### Added

- `afora.json` declares standard use cases, `{ "generic": "create", "repository": "Posts", "options": {...} }`, generated as `StdUseCases.context.create(Posts, {...})` and extracted back as written (`@afora/codegen`, see `docs/afora-json.md#standard-use-cases`); `examples/blog` now uses them for all its use cases, so its inputs take `id` and `password`, and its password hashing function is gone.

- Standard use cases: `commandOf({ useCases: (ctx) => ({ create: ctx.create(Posts), publish: ctx.publish(Posts) }) })` picks ready-made use cases, each made for a repository. `create`, `get`, `list`, `update`, `delete` and `restore` exist for the actions the repository declares; `publish`, `unpublish`, `archive`, `unarchive`, `tag` and `untag` for entities with those record plugins; `register` and `login` for authenticatable ones. Inputs follow the entity: no identity keys, an entity it holds by `<key>Id`, a plain password for a `Password` key (stored as its hash), only the change keys in `update`. Options: `name`, `as`, `errors`, `owner` (the caller owns the entity: filled on create, checked on the others, filtered in `list`), `omit`, `values`, `set`, `orderBy`. A use case the repository or the entity cannot support is a type error and throws `UseCaseUnavailable`. Exported: `StdUseCases`, `StdUseCaseContext`, `StdUseCasePlugins`, the option types `StdUseCaseOptions`, `StdEntityOptions`, `StdCreateOptions`, `StdLifecycleOptions`, `StdListOptions`, `StdOwnerOption`, `StdUseCaseErrors`, and the maker types (`CreateMaker`...). See `docs/std-use-cases.md`.
- Properties: a property class declares the input it accepts under the `PropertyInput` symbol (`{ accepts, convert }`), read by `propertyInputOf(field)`; `Password` accepts the new `PlainPassword` (the password rules as a property) and converts it to its hash. Also exported: `IPropertyInput`. The field plans of `useCaseTargetOf` carry it as `input` and `convert`.

- Use case plugins: `useCasePluginOf(name, { requires, compile })` declares a use case that is made for a repository, its blueprints, dependencies and steps following the entity, the actions and the record plugins; `plugin.make(repository, options)` gives the class (a steps use case), one per repository and options, and throws the new `UseCaseUnavailable` when the repository lacks an action or the entity a record plugin. `UseCaseTarget` states that precondition in the type of the repository argument, with errors that name what is missing (`MissingRepositoryAction`, `MissingRecordPlugin`). `useCaseTargetOf(repository)` is what `compile` reads (a plan of each key, relations), `useCaseOriginOf(UseCase)` says which plugin made a class, and `useCaseCatalogOf(...plugins)` groups plugins by name. Also exported: `isUseCasePlugin`, `isUseCaseCatalog`, `InvalidUseCasePlugin`, `UnknownUseCasePlugin`, `IncompatibleUseCasePlugin`, the default errors `UseCaseEntityNotFound`, `UseCaseEntityConflict` and `UseCaseInvalidCredentials`, and the types `IUseCasePlugin`, `IUseCaseCatalog`, `UseCasePluginSettings`, `UseCaseCompilation`, `UseCaseTargetInfo`, `UseCaseFieldPlan`, `UseCaseOriginInfo` and `EntityOfRepository`. See `docs/use-cases.md#plugins`.
- `commandBuilderOf(...catalogs)` gives a `commandOf` whose `useCases` may be a function of the use case plugins of the catalogs: `useCases: (ctx) => ({ create: ctx.create(Posts), custom: MyUseCase })`. Also exported: `CommandBuilder`, `CommandBuilderSettings` and `CommandUseCasesOption`.
- Applications register the use cases a plugin made by the commands that hold them, under their `useCaseName`, and `describe()` gives them `generic: { name, version, repository, options }`.
- Repositories: the `restore` action brings a soft-deleted entity back, by entity or id, clearing `deletedAt` and stamping `updatedAt`; it needs `deletion: "soft"` (`InvalidRepositoryDeclaration` otherwise) and a provider whose `update` clears a value that is left out, which `providerContract` now checks. Steps have `{ restore: "<repo>", value, as? }`, and `afora.json` takes the action (`restore_needs_soft` without soft deletion) and the step. Also exported: `RepositoryRestore`.
- Steps: a `change` step takes `ifPresent: true`, which skips it when its value resolves to `undefined` (a partial update), and the `args` of `find`, `invoke` and `run` may be one reference to a list, which is spread (`args: "$input.tags"`). Both are in `afora.json` too. Also exported: `StepArgs`.

## 0.0.6 — 2026-11-10

### Changed

- Breaking (types only): `toJSON()` of a record or entity returns the exact value, `RecordJson<Properties, Sensitive>`, instead of `Readonly<Partial<BlueprintData<Properties>>>`. No key is optional unless the blueprint makes it so, which removes the `string | undefined` typed clients saw on every key (issue #16), and a sensitive value is typed as it is returned, `Masked`: each leaf a `string`, lists and objects keeping their shape. What needs changing: code that read a sensitive non-string key of `toJSON()` as its original type (it was already the mask at runtime), and a subclass that overrides `toJSON` with another return type. To carry the keys, `recordOf` and `entityOf` capture `options.sensitive` as a literal, `propertyOf` captures `sensitive` (`SensitiveMark`, as `UniqueMark`), and `AbstractRecord`, `AbstractEntity`, `IRecord`, `RecordOptions`, `EntityOptions`, `RecordConstructor`, `EntityConstructor`, `DeclaredRecordInstance` and `DeclaredEntityInstance` take the sensitive keys as a last, defaulted type parameter. Runtime behavior is unchanged. Also exported: `RecordJson`, `Masked` and `SensitiveMark`.
- `@afora/codegen` generates each record and entity with its declared `name`, so `@afora/codegen` requires `@afora/core` 0.0.6 or later (generated `findCursor` actions need it too).
- `docs/applications.md` and `docs/use-cases.md` say how a use case runs through an application (`new app.useCases.Register(input).execute()`), and that use cases, commands and outputs are bound with a `provider`, `providers` or `log`, not only a `provider`.
- `inMemoryProvider()` is a plain object since 0.0.3 (it was frozen in 0.0.2, which made a `Proxy` over it throw); only its `capabilities` are frozen.

### Added

- Pagination by cursor: the repository action `findCursor({ where?, orderBy?, limit?, withDeleted?, after? })` gives `{ items, limit, next }`, and the `next` of a page is the `after` of the following one (`undefined` on the last). It reads each page with one provider call and no count, and rows added or removed between pages never repeat or skip another. The `id` is added as the last order to break ties; `offset` is rejected, `limit` is 20 by default and at least 1, and a sensitive key cannot order a cursor, since the cursor (opaque base64url, not encrypted or signed) carries the values of its order keys. An `after` that is not a cursor of `findCursor`, or one made for another `orderBy`, throws the new `InvalidRepositoryCursor` (a 400 in an output). Use case steps take it as a read action (`{ find: "users.findCursor" }`). See `docs/repositories.md`.
- Providers: `capabilities.keyset` says that `findMany` honors `after` (`ProviderQuery`, one value for each order, giving the rows strictly after that position). `inMemoryProvider` has it; a provider without it is unchanged and never given `after`, and `findCursor` over it throws `InvalidRepositoryQuery`. `providerContract` runs the keyset cases for a provider that sets the capability (`options.keyset` overrides it). Also exported: `RepositoryCursorQuery`, `RepositoryCursorPage`, `RepositoryFindCursor` and `ProviderQuery`.
- `@afora/drizzle` reads by cursor on SQLite and Postgres, and `@afora/codegen` and `@afora/mcp` accept `findCursor` in the `actions` of a repository and in `find` steps.
- A declared name for records and entities: `recordOf(blueprint, { name: "User" })` and `entityOf(blueprint, { name: "User" })`. Until now the name was the one of the class, which a bundler that minifies changes, so a provider keyed by `context.entity.name` or `context.name` lost its tables. The declared name is kept by the class and its subclasses, and `recordNameOf(Class)` (or the static `Class.recordName`) reads it, falling back to the name of the class; a subclass overrides it with `static override readonly recordName`. The library now uses it wherever it used the class name: the `source` of record and entity exceptions, `context.name` of a repository (`<name>Repository`), relation messages, and OpenAPI component names. A name that is not an identifier throws the new `InvalidRecordDeclaration`. `applicationOf` requires a record or entity that declares a name to be registered under it (`entities: { User }`), as use cases already are, and throws `InvalidApplicationDeclaration` for another key. Nothing changes for a record without the option, whose key stays free. See `docs/records.md`.
- `app.run(UseCase, input, options?)` runs a use case registered in the application over its bound repositories, in one call: it is `new (app.useCase(UseCase))(input, { context }).execute(dependencies)`, with `options.context` required when the use case declares a context and the input optional when none of its keys is required. It rejects (never throws) with `InvalidApplicationDeclaration` for a use case that is not registered. Also exported: `ApplicationRunArgs` and `ApplicationRunOptions`. See `docs/applications.md`.

### Fixed

- An exception of a class declared with `exceptionOf` stays an instance of that class when it crosses a layer: `error instanceof RepositoryUniqueViolation` is now true for what a repository, use case or command rejects with, as `error.is(RepositoryUniqueViolation)` already was, and the `details` are kept and typed. `propagate` (which `guard` calls) keeps the class and the `details` when it is given neither another `name` nor new `details`; with either, the result is a plain `Exception` as before (so an invalid record value, which carries the record's own `details`, is matched with `is(InvalidPropertyValue)`). Two things follow: `exception.find(Class)` gives the outermost exception of the class, in the layer it reached (`exception.origin` is still the first one raised), and each frame of `trace` repeats the `details`. A hand-written `class X extends Exception` is unchanged.

## 0.0.5 — 2026-11-10

### Changed

- Breaking: `ApplicationDescription.provider` and the `provider` of each repository description are `ProviderDescription | ProviderReference`; code that switches over `kind` needs the `"ref"` case.
- `@afora/codegen` requires `@afora/core` 0.0.5 or later, since a spec with `providers` generates code that uses `providersOf`.

### Added

- Named providers: `providersOf({ main, audit })` declares providers (objects or `providerFrom` factories) by key in a module of their own, and a repository names one before any application exists, `repositoryOf({ provider: Providers.audit })`, completed by the editor. `applicationOf({ providers: Providers, provider: Providers.main })` registers the storage: each application makes its own instance of each factory on `start()` and closes them on `stop()`, an application that extends it shares them, and `app.get(Providers.audit)` gives the instance. A provider of a storage that is not registered throws `UnregisteredApplicationReference`, one key from two storages `ApplicationConflict`, and a factory used outside an application the new `ProviderNotBound`. `describe().providers` gives each key, and a repository on one has `provider: { kind: "ref", key }` (`ProviderReference`). Also exported: `ProviderSlot`, `ProviderStorage`, `isProviderSlot` and `isProviderStorage`. See `docs/applications.md#named-providers`.
- `@afora/codegen`: the top-level `"providers": { "<key>": <provider> }` of an `afora.json`, generated as `providers.ts` (`Providers`), and `"provider": "<key>"` on a repository or at the top level, generated as `Providers.<key>`; keys of a spec extended directly can be named. New issues: `invalid_provider_key`, `provider_conflict`, and `unknown_provider` lists the keys. Extraction gives them back, with the import key `providers.<key>`. `Providers` is a reserved declaration name. The MCP server writes `providers` and `log` after `provider`.

## 0.0.4 — 2026-11-10

### Changed

- Breaking: `UseCaseDependency` and `UseCaseDependencyDescription.kind` gain the logger (`"logger"`, with `ref: "Logger"`); code that switches over every kind needs the new case.
- Breaking: `CommandEventInfo` gains `logger`, and `ProviderFactory` gains `withContext`; code that builds either by hand must give them.
- `eventOf` handlers get a second argument, `{ logger }`, and `EntityEvent.handle` takes an optional one; existing handlers and calls are unaffected.
- `@afora/codegen` requires `@afora/core` 0.0.4 or later, since a spec with `log` or `"Logger"` generates code that uses them.

### Added

- Logging, as data access is: `applicationOf({ log: { level?, providers } })` builds an `ILogger` (`debug`, `info`, `warn`, `error`, each `(event, fields?)`) from log providers (`ILogProvider`: `write(entry)`, optional `flush()`; `LogEntry` with `at`, `level`, `event`, `fields`, `application`). Built in: `jsonLogProvider()`, `consoleLogProvider()` and `memoryLogProvider()` (for tests); `logProviderOf({ name?, write, flush? })` checks your own (`InvalidLogDeclaration`). The application logs `use-case`, `repository` and `command` at `debug` with their time, and a failure once however many layers it crosses (`use-case-failed`, `command-failed`: `warn` for a declared exception, `error` for an unexpected one, with `exception.toJSON()`), never inputs, arguments or responses. `app.logger` writes your own lines; `stop()` flushes the providers; `extends` inherits the `log`; `describe().log` gives the level and the named providers. A provider that throws never breaks the call. A use case gets the logger by declaring `Logger` as a dependency (an `ILogger`, replaceable in `execute`; `UseCaseDependencyDescription.kind` gains `"logger"`); an `eventOf` handler gets `{ logger }` next to the entity (`EventHandlerContext`, and `event.handle({ logger })`), and `CommandEventInfo` gains `logger`. Outside a bound use case or command, the started application's logger is used. See `docs/logging.md`.
- The context of an application: `app.context` (`ApplicationContext`: `name`, `env(Environment)` with typed variables, `logger`), also through `useApplication().context`. `providerFrom((ctx) => provider)` makes the provider from it on start, and `logFrom((ctx) => log)` (with `isLogFactory` and `LogFactory`) the log, before the provider.
- `@afora/codegen`: `"log": { "level"?, "providers": ["json" | "console" | { "import" }] }` (or `{ "import" }` for a whole log) at the top of an `afora.json`, and `"Logger"` as a use case dependency, generated, validated and extracted (imports `log` and `log.providers.<index>`).

## 0.0.3 — 2026-11-09

### Changed

- Releases are automatic: merging a new version to `main` runs CI, publishes every `@afora/*` package to npm and creates the tag and the GitHub release (see `VERSIONING.md`). The packages now share one version.
- Docs: the README is now the entry point (intro, install, a quick start that runs the full flow from an entity to an HTTP API with `Bun.serve`, then the same app as an `afora.json` generated with `afora-codegen`), and the concept reference moved to `docs/`, one page per concept (`docs/README.md` is the index), plus `docs/afora-json.md`, a guide to generating, extracting and round-tripping a spec, with its catalogs and limitations. The quick start is tested by `bun run test:interop` (TypeScript and JSON), and `bun run docs:links` checks the relative links of the README, the docs and the package READMEs.
- `commandOf({ transaction: true })` checks at declaration only the providers the repositories declared; the rest are checked when an application binds the command (with its provider) or on the first call, so a transactional command over repositories that an application provider binds can be declared at module level.
- A relation to a soft-deleted entity loads it (deleted, read-only) instead of failing the read with `InvalidRepositoryData`: a reference is data, so an order keeps its deleted product.
- Breaking: TypeBox is now a required peer dependency (`typebox: ^1`) instead of a runtime dependency. Install it alongside `@afora/core`; companion packages and generated applications share the application's TypeBox installation.
- Breaking: record and entity instance metadata moved from `.blueprint` and `.options` to `[Meta].blueprint` and `[Meta].options`. Class statics keep their names. `blueprint` and `options` are now legal domain fields, including plugin fields, and metadata no longer appears in spread or `Object.keys`. Reserved record and entity names are covered by fixed contract tests.
- Breaking: `CallableProperties`, `StoredField`, `StoredFields`, `BlueprintPropertySchema`, `JoinedProperties`, `ListProperties`, `OptionalProperties`, `PluginMembers`, `WithPluginProperties`, `RecordPluginsByName`, `RecordPluginContext`, `BlueprintFactoryContext`, `MergedCollections`, `ApplicationCollectionKey`, `MergedEnvironment` and `RepositoryMethods` were removed from the exports (internal helpers, now marked `@internal`). They still appear inside the declarations of the exported types.
- Breaking: `sliceOf`, `sliceValue` and the `SliceMask`, `ValueMask`, `SlicedBlueprint` and `SlicedValue` types moved to the new subpath `@afora/core/experimental`, which is not covered by the compatibility policy.
- Releases now publish `@afora/codegen`, `@afora/mcp`, `@afora/hono` and `@afora/drizzle` after `@afora/core`, skipping versions already on npm. The package manifests point to `afora-framework/core`, which npm provenance requires. Dependabot ignores `monaco-editor`.
- Breaking: the `change<Key>` methods are now a `change` namespace, `user.change.name(value)` instead of `user.changeName(value)`, with the same validation, `updatedAt` and effects. `change.<key>` is bound to its record, so `const { change } = user` works, and it returns the record. `change` only exists when `options.change` (or a plugin) lists keys, and then a blueprint key named `change` throws `ReservedRecordKey` (a plugin member named `change` throws `RecordPluginConflict`). The standard `authenticatable` plugin now has `change.password(hash)`.
- `recordOf` is now the `std` one, `recordBuilderOf(StdRecordPlugins)`, so that `options.plugins` can pick standard plugins; its classes have a static `plugins`. `change` keys are resolved in the order of the blueprint, as `sensitive` and `unique` are.

- Editor and type-check performance: an edit in a file using afora costs about 30–55k type instantiations (~0.1 s) instead of ~1.33M (~1.2 s), in source and package mode. TypeScript no longer has to measure TypeBox's `Static` on a generic schema (about a second on every check): the property layer carries the value of its schema as a type parameter, computed where the schema is known, and blueprint values (`BlueprintValue`, `BlueprintInput`, `BlueprintData`, list values) are built from the values of their fields, with the same keys, modifiers and order as before. Value types and error messages are unchanged. `PropertyClass`, `IPropertyType`, `ISchema`, `ISchemaType`, `PropertyOptions`, `PropertyValue`, `AbstractProperty`, `DeclaredProperty`, `AbstractDefineProperty`, `IDefineProperty`, `IProperty` and `AbstractPropertyConstructor` gain a second type parameter, `Value`, defaulting to `Static<SchemaType>`, so existing spellings keep working; hovers now show it, e.g. `PropertyClass<TString, string>`. `propertyOf` infers the schema from `schema` alone (`default`, `preHandle` and `afterHandle` are `NoInfer`), as it effectively did.
- `repositoryOf`: `findManyBy<Key>` is only an action for keys that are not unique; a unique key (`id`, `options.unique`, a `unique` property) has `findBy<Key>` instead. `findManyBy<UniqueKey>` is rejected by type and throws `InvalidRepositoryDeclaration` at declaration, pointing to `findBy<Key>`.

- Breaking: provider v2. `IRepositoryProvider.findOne`, `findMany` and `count` take a `RepositoryQuery` (`where`, `orderBy`, `limit`, `offset`, `withDeleted`) instead of `(key, value)`; `findIn` was removed (relations call `findMany` with `where: { id: { in: ids } }`); a provider excludes `deletedAt` rows unless `withDeleted` is true, and soft `count` now calls the provider's `count`. `app.describe()` repositories no longer have the `provider: boolean` field: `provider` is a `ProviderDescription` present only for an explicit provider.

### Added

- One started application per process. `app.start()` registers the application (on `globalThis`, under `Symbol.for("afora.application")`, shared by copies of the package), `useApplication()` gives it from anywhere and throws `ApplicationNotStarted` when none is, typed by augmenting the new `Register` interface (`RegisteredApplication`). Starting another one throws the new `ApplicationAlreadyStarted`, unless `start({ replace: true })`, which stops it; `start({ register: false })` does not register, `stop()` unregisters and `resetApplication()` forgets it (`ApplicationStartOptions` type). `app.get(declaration)` gives the bound repository, use case, command or output, or the variables of a registered environment.
- `app.start()`, `app.stop()` and `app.started`. `start()` validates every environment of the application at once (the new `InvalidApplicationEnvironment`, `details.environments` by name), makes the provider of `providerFrom` and checks the transactions of the commands against it; it is idempotent and can be retried after a failure. `providerFrom(environmentDependencies, create)` (with `isProviderFactory` and the type `ProviderFactory`) is a `provider` for `applicationOf` made on start from the typed variables of registered environments; calls before that throw the new `ApplicationNotStarted`. `stop()` calls the new optional `IRepositoryProvider.close()` and, with `providerFrom`, forgets the provider until the next start.
- `commandOf({ environmentDependencies })`: one environment or a list, merged in order. `command.env` gives their variables (typed, read on first use) and `command.environments` the list; the event handler policy gets `env` in its info, and `onEventError` a third argument, `info`, with `command`, `operation`, `context` and `env`. `run` and `execute` take `env`, typed, some variables in place of the loaded ones for that call: the use cases (and their children) that declare the same environment get them, in `this.dependencies` and in `$env` steps. An invalid `env` throws the new `InvalidCommandEnvironment` (`Command` layer, `details: { keys, issues }`), a 500 for `statusOf`. In an application the environments of a command must be registered (`UnregisteredApplicationReference`), and `app.describe().commands` gives `environments` by name when there are any. `@afora/codegen`: `commands.<Name>.environments` in the `afora.json` (generated as `environmentDependencies`, extracted back). New types `CommandEnvOption`; `CommandOf`, `CommandSettings` and `CommandOptions` gain a third type parameter, `Environment`, defaulting to `undefined`.
- `examples/blog`: a blog generated entirely from an `afora.json` (steps use cases, commands with transactions, a Hono API with OpenAPI on Drizzle and SQLite), tested for drift, end to end and by extracting the spec back; `bun run test:blog`, also run by CI.
- `operationRoutes(operations, { basePath?, route? })`, `routeOptionsIssue` and the types `OperationRoute` and `RouteOptions`: the routing of the `openapi` sink (`POST {basePath}/{command}/{operation}`, `route` overrides), shared with the sinks that serve HTTP such as `@afora/hono`. The `openapi` sink behaves as before.
- `app.describe()` use cases gain `refs?: { input?, response?, context? }` and commands `refs?: { context? }`: the names of the registered blueprints that are the `input`, `response` or `context` (the fields stay described), so codegen can extract `"input": "RegisterInput"` instead of inline fields. They are absent for blueprints that are not registered.
- `stageKindOf(factory)`: whether a factory made by `transformOf` or `sinkOf` builds a transform or a sink, without calling it.
- `@afora/drizzle` (`packages/drizzle`, 0.0.1): a repository provider v2 on Drizzle ORM for SQLite and Postgres, `drizzleProvider({ db, tables })`, that passes `providerContract` on `bun:sqlite` and PGlite. Core is unchanged.
- `openapi`, a sink for `outputOf` (in `StdStages`) that builds an OpenAPI 3.1 document from the operations: `openapi({ info, servers?, basePath?, route? })` with `OpenAPISinkOptions` and `OpenAPIDocument`. Routes are `POST {basePath}/{command}/{operation}` in kebab case, `operationId` is the id with `_` for the dot, responses are `200`, `400`, `500` and the status of each declared error, problems are `application/problem+json` and records and entities become `components.schemas`.
- `applicationOf({ outputs })`: outputs are registered by `outputName` (`InvalidApplicationDeclaration` otherwise, unnamed outputs from `.pipe` included), every command of each must be in `commands` (`UnregisteredApplicationReference`, `details: { output, command }`), and `extends` merges and conflicts them like other collections. With a provider, `app.outputs.Api` and `app.output(Api)` give the output rebuilt over the app-bound commands (same name, statuses and stages, memoized). `app.describe().outputs` lists `commands`, `statuses` and `pipe` (`{ kind: "opaque" }` for hand-written stages). `outputOf({ commands })` also takes an application (all its commands) or a mixed list; the same command twice counts once. New types `OutputDescription`, `OutputApplication` and `OutputSource`.
- `outputOf({ name, commands, statuses?, pipe? })`, `isOutput`, `operationOf` and the `OperationDescriptor` v1: an output turns commands into frozen operation descriptors (`id`, `input`, `response`, `context`, `errors`, `tags`, `meta`, `invoke`) and runs them through a pipe of stages, transforms first and a sink last; `build()` runs the sink lazily (memoized) and `pipe(...)` adds stages ad hoc. Stages are made by `transformOf` and `sinkOf` factories from JSON options, described by `stageDescriptionOf` and resolved by `stageCatalogOf`; `select` (`tags`, `operations`, `exclude`) is built in, in `StdStages`. `statusOf(error, operation?, statuses?)` maps errors to HTTP-style statuses, `problemOf(error, { status, debug? })` builds RFC 9457 problems (`PROBLEM_MEDIA_TYPE`), and `outputValueOf` gives the masked JSON a sink sends. New exceptions in the `Output` layer: `InvalidOutputStage` and `DuplicateOperation`. Outputs from an application come with `applicationOf` support.
- `applicationOf({ commands })`: commands are registered by `commandName` (`InvalidApplicationDeclaration` otherwise), every use case of every command must be in `useCases` (`UnregisteredApplicationReference`, `details: { command, useCase }`), and `extends` merges and conflicts them like other collections. With a provider, `app.commands.X` and `app.command(X)` give the command rebuilt over the app-bound use cases (memoized, same settings; the transaction check re-runs and throws `InvalidCommandDeclaration`). `app.describe().commands` lists operations, `transaction`, `events` and `onEventError`. New type `CommandDescription`.
- `commandOf({ name, context?, useCases, transaction?, events?, onEventError? })`, `isCommand` and the types `CommandOf`, `CommandSettings`, `CommandOperation`, `CommandInput`, `CommandResponse`, `CommandOptions`, `CommandEvents` and `AnyCommand`: a command groups use cases under operation names and is the execution boundary of a call. `run(op, input, { context })` validates the context once (narrowed per use case), runs the use case inside a transaction of the repositories' provider when `transaction: true` (checked at declaration), then applies the event policy after the commit (`"after-commit"`, `"manual"` or a handler, with `onEventError`); `execute` returns `{ value, events }` without the policy. New exceptions in the `Command` layer: `InvalidCommandDeclaration`, `UnknownCommandOperation`, `InvalidCommandContext` and `CommandEventFailed`.
- `useCaseOf({ steps })`: a use case declared as data instead of a hand-written `execute`. The returned class is concrete and its `execute` interprets the steps (`find`, `ensure`, `build`, `change`, `invoke`, `create`/`update`/`delete`, `call`, `run`, `return`) over values that are references (`$input.email`, `$context.userId`, `$env.mail.FROM`, `$saved.tags.0`), literals (`{ literal: "$5" }`) or mappings, through the same wrapper and dependency functions as a hand-written `execute` (validation, events, execution scope, guard frames, `UseCaseAlreadyExecuted`). Steps are validated at declaration (`InvalidUseCaseStep`, `UseCase` layer, `details: { index, reason, code }`), and TypeScript checks dependency and action names. New exports: `InvalidUseCaseStep`, `UseCaseStep`, `UseCaseStepDescription`, `StepValue`, `StepReference`, `StepEnsureKind`, `StepErrorDescription`, `StepFindTarget`, `StepReadAction`, `StepRepositoryWith`, `StepsUseCaseConstructor`, `UseCaseStepsSettings`. `app.describe()` use cases report `implementation: { kind: "steps", steps }` (classes by registered name, core exceptions as `{ core }`, `run.fn` as `{ kind: "opaque" }`) when `execute` is the interpreter, and `{ kind: "opaque" }` otherwise; `build` classes and `ensure.error` of steps must be registered in the application (`UnregisteredApplicationReference`).
- `useCaseOf` takes `context` (a blueprint), `description`, `tags`, `deprecated` and `errors` (classes made by `exceptionOf`), exposed as frozen statics and validated (`InvalidUseCaseDeclaration`). With a context, `new UseCase(input, { context })` requires and validates it (`InvalidUseCaseContext`) and `this.context` is parsed and frozen; children called through dependencies inherit it narrowed to their own context keys. New types `UseCaseContext` and `UseCaseOptions`; `UseCaseConstructor` and `AbstractUseCase` gain a `Context` parameter that defaults to no context, and `AnyExceptionClass` is exported.
- `applicationOf({ useCases, exceptions })`, keyed by `useCaseName` and exception `name`, with `UnregisteredUseCaseDependency` (Application layer) and checks for the records held by use cases and for `errors`; with a `provider`, `app.useCases` are subclasses bound to it (recursive, memoized) and `app.useCase(UseCase)` returns them. `app.describe()` gains `useCases` and `exceptions` (`UseCaseDescription`, `ExceptionDescription`).
- Internally, use cases carry an execution scope that swaps repository providers for a call (repository methods, `RepositoryOf` subclass methods, relation loading and child use cases), the base for transactions in commands. It is not exported.
- `@afora/core/testing`: `providerContract({ describe, it, expect }, makeProvider, { transactions? })`, a runner-agnostic contract test kit any provider v2 implementation must pass (reads, writes, unique violations, `where`/`in`, `orderBy`, `limit`/`offset`, `withDeleted`, copies and transactions). Works with `bun:test`, vitest and jest. Part of the contract, unlike `experimental`.
- `findMany(query)`, `exists(query)` and `findPage(query)` repository actions (`findPage` gives `{ items, total, limit, offset }`, defaults 20 and 0), typed queries on `count`, `findBy<Key>` and `findManyBy<Key>`, validated before the provider is called: `InvalidRepositoryQuery` (Repository layer). Records become plain data and entities ids in query values, also inside `in`.
- `providerOf` and `providerDescriptionOf`; `app.describe().provider`; optional `transaction(run)` and `capabilities` on providers. `inMemoryProvider()` supports where, `in`, `orderBy`, `limit`/`offset`, `withDeleted` and transactions (isolated snapshots, serialized, savepoints) and clones data on write and read.
- Provider v2 design types: `RepositoryQuery`, `RepositoryWhere`, `RepositoryOrder`, `RepositoryPage`, `RepositoryFindMany`, `RepositoryExists`, `RepositoryFindPage`, and JSON provider descriptor/settings types. Runtime integration and JSON codegen follow in T10–T12; the design and typed sandbox are checked in.
- `afora.json` accepts `exceptions` and `useCases` (metadata, context, dependencies, errors, steps DSL or a hand-written class extending a generated `<Name>Base`); generated, extracted and validated by `@afora/codegen`, authored through `@afora/mcp`.
- `afora.json` repositories support `deletion: "hard" | "soft"`, including generation and extraction; explicit hard deletion normalizes to the default. MCP authoring tools accept and validate the setting.
- `repositoryOf({ deletion: "hard" | "soft" })`, defaulting to hard deletion. Soft deletion persists `deletedAt`, hides deleted rows from finds, counts and relations, and appears in `app.describe()`. Unique values of retained rows remain occupied.
- `VERSIONING.md`: the semver policy, what is and is not the contract, what counts as additive or breaking, the deprecation process, supported ranges and how they are enforced.
- `bun run test:api` (`tests/api-surface`): a snapshot of every export of the built package with its declaration, and of `packages/codegen/afora.schema.json`, so a change to the public surface (or to the `afora.json` spec) is a reviewed, intended one (`-u`). Run in CI.
- `applicationOf({ name, extends, properties, blueprints, records, entities, environments, repositories, provider })`: a named, immutable manifest of an app's declarations, with the names typed (`app.repositories.Users`). It validates the set as a whole at declaration (`DuplicateApplicationDeclaration`, `UnregisteredApplicationReference`, `UnregisteredRepositoryDependency`, `InvalidApplicationDeclaration`, in the new `Application` exception layer). `extends` and `app.extend(...others)` compose applications (same object and name deduplicated, `ApplicationConflict` otherwise, extended ones untouched). `app.describe()` gives a JSON-serializable graph of every declaration with its origin (`from`). With a `provider`, `app.repositories` are bound to it (the originals are not mutated; a repository with its own provider keeps it), so two applications do not share data. `isApplication` and the `IApplication`, `ApplicationDescription` and related types.
- `propertyLineageOf(Property)`: how a property was made, `{ kind: "refined", base, options }` for `Property.with`, `{ kind: "optional", base }` for `optionalOf` and `{ kind: "factory", factory: "enumOf", args }` for `enumOf`; `undefined` for a property declared with `propertyOf`. `PropertyLineage` type.
- `sliceOf(blueprint, selector)`: a new blueprint with only the fields the selector names, recursively into nested blueprints, records and lists (optionality kept). The selector is a key mask (`{ name: true, address: { city: true } }`) or a blueprint or record class; keys the blueprint lacks are a type error and throw `UndeclaredBlueprintProperty`. A nested record named whole keeps its class; one sliced to some keys becomes a plain record that keeps its `sensitive`, `unique` and `change` keys among them (identity keys of an entity only if named) and accepts instances of the original. `sliceValue(value, selector)` strips an object, record instance (by `toJSON`, sensitive stays masked) or list to the same keys without validating; on records, the keys the blueprint requires stay required. `SliceMask`, `ValueMask`, `SlicedBlueprint` and `SlicedValue` types. Experimental: exported from `@afora/core/experimental`.
- Record plugins. `recordPluginOf(name, RecordClass, { version, description })` turns a record class into a plugin: its keys, its `sensitive`/`unique`/`change` keys, its methods and getters, and its `onSet`/`onSetAll` effects. Records and entities take plugins in `options.plugins`, a list or `(ctx) => [...]`, with types for the added keys and methods and for the unique keys a repository's `findBy<Key>` accepts. A plugin's own plugins are applied with it (`requires`). `hasPlugin`, `plugin.is` and `pluginsOf` track them. `RecordPluginConflict` is thrown for clashing keys or members, and `InvalidRecordPlugin` for classes that cannot be plugins (entities included).
- `recordPluginCatalogOf(...plugins)`: plugins by name, as the `ctx` of `options.plugins` (`recordBuilderOf(...catalogs)`, `entityBuilderOf({ plugins })`), resolving descriptors (`plugin.toJSON()`, `JSON.stringify(Post.plugins)`), names and `name@version` back to plugins. `UnknownRecordPlugin` and `IncompatibleRecordPlugin` exceptions.
- Standard plugins in `StdRecordPlugins`: `Publishable`, `Archivable`, `Taggable`, `Ownable` and `Authenticatable`.

- `toOpenAPI(field)`: the OpenAPI 3.1 schema (JSON Schema) of a property, blueprint, list, record or entity, keeping the metadata and constraints of `Property.with`; sensitive keys are `writeOnly`, an entity's identity `readOnly`, optional keys out of `required`, objects closed with `additionalProperties: false`. `toOpenAPI({ User, Post }, { refPrefix })` gives `components.schemas`, a record named among the models being a `$ref` where another holds it. `InvalidOpenAPIModel` exception, in the `Output` layer; `OpenAPISchema`, `OpenAPIComponents` and `OpenAPIOptions` types.
- `Property.with(options)`: a subclass of any property narrowed and documented by `options`, e.g. `Integer.with({ min: 1, description: "Age in years" })`. `title`, `description`, `examples`, `deprecated`, `readOnly` and `writeOnly` go to its JSON Schema (for OpenAPI); `default` (or the first of `examples`) is its demo value. Strings take `min`, `max` and `pattern`; numbers and integers `min`, `max`, `exclusiveMin`, `exclusiveMax` and `multipleOf`. Constraints only narrow the property (a looser bound is ignored, a second pattern goes under `allOf`), and its handlers, flags and statics are kept. `PropertyOptions`, `PropertyMetadata`, `StringConstraints` and `NumberConstraints` types.
- The properties of a blueprint context, `ctx.optional.*` included, can be called with those options, as `ctx.number({ min: 1 })` or `ctx.optional.string({ max: 20 })`; used as they are, they are the property classes. A blueprint, `listOf` and `optionalOf` store the class itself. `CallableProperty` type.

- `EntityNonUniqueKeyOf` type: the keys of an entity that are not unique.

## 0.0.2 — 2026-10-28

### Changed

- Released from CI through npm trusted publishing, with provenance, instead of by hand.

## 0.0.1 — 2026-10-28

The first release, published as `@afora/core`.

### Added

- `entityOf(blueprint, options)`: a record with identity. It gets `id` (a UUID v7, generated when missing, always in `options.unique`), `createdAt` (now, when missing), `updatedAt` (set by each change) and `deletedAt` (set by `destroy()`, after which the entity no longer changes). An entity is a field of records and of other entities, with `optionalOf` and `listOf`; a plain object given for one becomes an entity with its own id.
- `AbstractEntity` with `destroy`, `isDeleted`, `equals` and the `onDestroy` hook; `entityBuilderOf` for your own identity and clock; `isEntityClass` and `isEntity`.
- `DeletedEntity`, `ImmutableEntityKey` and `ReservedEntityKey` exceptions, in the `Entity` layer.
- `EntityConstructor`, `EntityInput`, `EntityOptions`, `EntityProperties`, `DeclaredEntityInstance`, `EntityBuilder`, `EntityBuilderSettings`, `EntityIdentityKey` and `IEntityIdentity` types.
- `enumOf(values, { name, default, optional })` in `std`: a property holding one of the listed strings or numbers, e.g. `enumOf(["draft", "published"])`, and `ctx.enumOf` in blueprints. It goes in `listOf` and `optionalOf` as any property.
- Plugin factories: `blueprintPluginOf(name, properties, factories)` puts functions that make fields in the blueprint context, as `ctx.enumOf`; a factory replaces a field with the same name and cannot take a reserved key. `BlueprintFactory` and `IBlueprintFactories` types.
- `ctx.listOf`, `ctx.optionalOf` and `ctx.propertyOf` in every blueprint context, e.g. `ctx.listOf(ctx.enumOf(["news", "tech"]))`; `BlueprintHelpers` type.
- `repositoryOf({ entity, actions, provider, environmentDependencies })`: a repository of an entity with the chosen async methods, `findBy<Key>` (unique keys only, checked by type and at declaration), `findManyBy<Key>`, `create`, `update`, `delete` and `count`. `inMemoryProvider()` is the default provider and enforces every unique key; `IRepositoryProvider` is the contract of your own.
- `relations` in `repositoryOf`: the repositories that load the entities an entity holds, which are stored by their ids and read back current, in batches (`findIn`, optional in `IRepositoryProvider` and implemented by `inMemoryProvider`). `findBy<Key>` and `findManyBy<Key>` take the entity or its id (`QueryValueOf` type). A missing, extra or duplicated relation throws `InvalidRepositoryDeclaration`; an id with no entity throws `InvalidRepositoryData`.
- `RepositoryOf(repository)`: the class of a repository, to extend with methods and overrides; `RepositoryOf<Entity, Actions>` is the type of a repository. `AbstractRepository` and `isRepository`.
- `InvalidRepositoryDeclaration`, `InvalidRepositoryEntity`, `InvalidRepositoryData`, `RepositoryUniqueViolation` and `RepositoryEntityNotFound` exceptions, in the `Repository` layer.
- `environmentOf(blueprint, { source })`: the variables of the environment, converted to a number or a boolean when their property takes one, and validated on first `load()`; `InvalidEnvironment` and the `Environment` layer.
- Use cases take repositories and environments as dependencies; `execute` replaces some methods of a repository, or the variables of an environment. The methods of a class extending a repository call each other through the use case, so their events go up to it and the replaced methods apply inside them; only the events of entities of the repository's own class go up. `DependencyOf`, `DependencyOverrides` and `UseCaseDependency` types.
- `EntityUniqueKeys` on every entity class, and the unique keys at type level: `entityOf` keeps the literal `options.unique`, and `propertyOf({ unique: true })` marks its keys (`EntityUniqueKey`, `MarkedUniqueKey`, `UniqueMark`).
- **Standard Schema V1** on every field: property classes (the handled value), blueprints (the handled object), lists, and record classes (an instance of the class). Works with Hono, tRPC, TanStack Form and any other Standard Schema consumer; see `examples/interop`.
- `safeParse` on property classes, blueprints and record classes: never throws for an invalid value and returns `{ value }` or `{ issues }`, with every issue collected, each with `code`, `path` and `source`.
- Records and optional records as blueprint fields; a plain object given for a record field becomes an instance of that record.
- `BlueprintInput`, `Issue`, `IssueCode`, `ParseResult`, `DeclaredRecordInstance` and `StandardSchemaV1` types.
- `configure({ hasher, idGenerator })` and `resetRuntime()`, with the `PasswordHasher` and `IdGenerator` interfaces.
- `PasswordHasherRequired`, `SyncVerifyUnsupported` and `UnsupportedPasswordHash` exceptions.
- `bun run bench`, `bun run test:types`, `bun run test:interop` and `bun run smoke`.

### Changed

- The protected `hydrate(data)` of a repository is async, and `hydrateMany(list)` loads a list in one batch.
- The input of a record field (`BlueprintInput`) is what the record's constructor takes, so that a nested entity can come without its identity.
- `listOf`, `optionalOf` and `propertyOf` are reserved context keys: a plugin declaring one of them, as a property or a factory, throws `ReservedBlueprintKey`.
- Runs on Node >= 22 as well as Bun. Password hashing uses `Bun.password` on Bun, native argon2 from `node:crypto` where the runtime has it, and otherwise throws `PasswordHasherRequired` until a hasher is configured. `node:crypto` is loaded on first use, not at import.
- `Id.generate()` uses a portable, monotonic UUID v7.
- The `typescript` peer dependency is now `>=5.5` and optional; declarations work with `bundler` and `nodenext` resolution.
- Exceptions raised by a record carry every issue in `details.issues` (not enumerable).
- `safeParse` on a record class goes through its constructor, so subclass constructors are honored and their errors become issues.
- Parsing invalid input is 2x to 5x faster: no exceptions as control flow, TypeBox errors computed once per failing value, and the `cause` of an issue is built when it is read (a non-enumerable getter). An issue's `cause` has the same content as before.
- README rewritten around the domain layer, Standard Schema, performance and a comparison with other libraries.

### Known limitations

- `StandardSchemaV1.InferOutput` of a record subclass is the instance type of the base record; at runtime it is the subclass.
- Invalid input is still slower to validate than with Zod or Valibot (about 2x to 5x, on Bun and Node), mostly because TypeBox collects the errors of each failing property; see `bench/RESULTS.md`.
