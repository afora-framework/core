# FAQ

## Choosing afora

**When should I not use afora?**

- You need only to validate some data at an edge and nothing else. Zod, Valibot or TypeBox alone are smaller for that, and afora's fields already work in anything that takes [Standard Schema](standard-schema.md).
- Your app is mostly a thin layer over a database with no rules of its own, and you already have an ORM and a router you are happy with.
- You need a framework with years of stable releases behind it. 27.0 is afora's first stable release: its contract is frozen from the release candidate on, but it has no track record yet. See [Stability](#stability-and-versioning) below.
- You need a framework that also does views, jobs, queues and sessions. afora models the domain and serves it; the rest is yours to pick.

**What is it good at?**

Domain rules that must hold wherever the code runs: a unique email, a password that never leaves in a response, a body that may not carry undeclared keys, a business error that is a 409 and not a 500. Each is a mechanism of the runtime, not a convention. The [README](../README.md#why-afora) has the table.

**How does it relate to Zod and TypeBox?**

afora models on [TypeBox](https://github.com/sinclairzx81/typebox): a property validates with a TypeBox schema, and TypeBox `^1` is a required peer dependency. Every property, blueprint, list and record class also implements Standard Schema V1 (vendor `"afora"`), so it plugs into Hono, tRPC and TanStack Form where you would pass a Zod schema. You can keep Zod for what it does well and use afora for the domain: [Coming from Hono + Zod](coming-from-hono-zod.md) shows both.

**Do I have to write an `afora.json`?**

No. `afora.json` is one way to write the same application: as data, for an agent or a generator. The TypeScript API is the other, and `afora-codegen extract` gives the JSON back from code. See [afora.json](afora-json.md).

## Runtime

**Bun or Node?**

Both. afora needs Bun >= 1.4.4 or Node >= 22, and its core also loads in browsers and Workers, because `src/` imports no `node:crypto`, `Buffer` or Bun-only API at load. The differences are small:

- `Password` hashes with argon2id: `Bun.password` on Bun, native `node:crypto` on Node 24.7 and later. On an older Node, it throws `PasswordHasherRequired` until you call `configure({ hasher })`.
- `afora-codegen extract` imports your TypeScript file, so use Bun, or Node >= 22.18 (type stripping on by default). `afora-mcp` imports an application in a Bun subprocess, so it needs Bun on the `PATH` for that. See [CLI](cli.md).
- The repo's own tests and tooling use Bun.

**Can I use it in the browser or a Worker?**

The core loads there. Hashing needs a `hasher` you configure (a Worker has no `Bun.password`), and a provider needs a store reachable from there (`inMemoryProvider()` always works). `Id.generate()` makes a UUID v7 on any runtime.

**Why do I get `PasswordHasherRequired`?**

Your runtime has no argon2 that afora can find. Call `configure({ hasher })` once at startup. See [Troubleshooting](troubleshooting.md#passwordhasherrequired).

## Behavior

**Why is `{ ...record }` empty?**

The values of a record live in a `WeakMap` and its keys are getters on the prototype, so nothing is an own property. That is on purpose: a plain spread or `Object.keys` cannot copy a record and bypass its rules or leak a sensitive key. Read a key as `user.name`, and use `user.toJSON()` (or `JSON.stringify(user)`) for the plain value, with sensitive leaves masked as `"********"`. See [Records](records.md).

**Why does my record reject a key I did not declare?**

Records reject undeclared keys at any depth, with `UndeclaredRecordProperty` (issue code `undeclared_key` in `safeParse`). The value is rejected, never trimmed. If a client sends extra fields, that is a 400, not a silent drop.

**Why can't I name a field `set`, `toJSON` or `constructor`?**

Those are members of a record, or of every object. `recordOf` throws `ReservedRecordKey` (`ReservedBlueprintKey` for a blueprint). The lists are `RESERVED_RECORD_KEYS` and `RESERVED_ENTITY_KEYS`, and they never grow.

**A record with the same unique value built twice does not throw. Why?**

A record never compares itself with other records: `unique` lists the key for a repository to enforce. The violation comes from `create` or `update` as `RepositoryUniqueViolation`. See [Records](records.md) and [Repositories](repositories.md).

**Does `delete` remove the row?**

By default, yes (`deletion: "hard"`). With `deletion: "soft"` it stores `deletedAt`, reads leave the row out and `restore` brings it back. See the [recipe](recipes/soft-delete.md).

**Can I call a repository I declared at module level inside an application?**

Once an application binds it to its provider, the module-level repository throws `RepositoryUsedOutsideApplication`, so it cannot read another store by mistake. Use `app.repositories.X` or `app.run(UseCase, input)`. See [Applications](applications.md).

## Building an API

**Why does a 500 say only `"Internal error."`, and how do I show a message?**

An error nobody declared may carry anything (a SQL fragment, a path), so a 5xx hides its detail unless the sink has `debug: true`. An exception the output lists in `statuses` (`{ PaymentFailed: 502 }`), or one the operation declares in its `errors`, keeps its message at any status: listing it is the decision to show it. A few are never shown, even when listed, such as `InvalidEnvironment`, `InvalidUseCaseResponse` and `InvalidUseCaseStep`: they are a 500 without `issues`, since they describe the server, not the request. See [Outputs](outputs.md).

**Can an id be an integer, or a key of my own?**

Yes, per entity. UUID v7 is the default; `entityOf(blueprint, { id: Uuid })` accepts a UUID of any version, `{ id: Key }` takes a natural key from the input, `{ id: Serial }` lets the database assign an integer (in memory and Drizzle; not DynamoDB), and `idOf(property, generate?)` builds any other strategy. See [Entities](entities.md#ids).

**Can a use case answer a list, or another status than its route's?**

Both. `response: listOf(Item)` makes the body an array, each item validated and masked ([Use cases](use-cases.md#a-list-as-the-response)). `return withStatus(503, body)` answers another status with the same body, if the route lists it in `statuses` ([A status chosen at run time](use-cases.md#a-status-chosen-at-run-time)).

**How do I accept a file upload?**

Give the input a file field, `ctx.fileOf({ types: ["image/*"], maxBytes: 5_000_000 })` (or `ctx.file` for any file), and route it with `post`, `put` or `patch`. Every HTTP sink reads it from a `multipart/form-data` body, checks its type and size (and, for common images, its first bytes), and the OpenAPI document describes the form. An entity cannot hold a file: store where it went. See [Files](std-properties.md#files).

**Can a `DELETE` take a body?**

Yes, with `route: { method: "delete", path, body: true }`; without it, the input of a `delete` comes from the path and the query, as before. See [Routes](use-cases.md#routes).

**Where does a cache, a storage or a client of another API go?**

In a service: `serviceOf<Cache>("cache")` among the dependencies of a use case, and `applicationOf({ services: { cache: (scope) => ... } })` to make it, once per call, with the context, the caller and the request at hand. A test replaces it as any dependency, `execute({ cache })`. See [Services](use-cases.md#services).

**How do I get the JSON Schema of an entity, for something that is not OpenAPI?**

`jsonSchemaOf(User)` gives a standalone draft 2020-12 document for any property, blueprint, list, record or entity. See [JSON Schema](openapi.md#json-schema).

## Testing

**Why can't I `spyOn` a repository method?**

A repository is frozen, because one repository is shared by every use case and application that names it, and a patched method would leak into other tests. Spy on the provider under it with `spyProvider` of `@afora/core/testing`: it records each call and can make one fail, even behind an HTTP sink. For a direct call, `execute({ Users: { findById: ... } })` replaces a method for that call only. See [Testing an application](testing.md#spying-on-the-database).

## Performance

**Is it fast?**

For a library that validates, normalizes and builds an object, yes. In the committed benchmark run, `blueprint.safeParse` is ahead of Zod 4 on most of the fourteen cases and behind on some (the list of 1,000 items among them); compiled TypeBox, Ajv and Typia are faster on valid input, because they only check and do not transform. Creating a record or an entity costs more than parsing, because it also builds the instance. The numbers, how they are measured and the guard that CI runs are in [Performance](performance.md).

**Does an invalid value cost more?**

Validation of invalid input collects every issue, and that path is held to the same budget as the valid one: `bun run bench:guard` fails a change that makes it slower. `safeParse` never throws for invalid input.

## Stability and versioning

**Is it stable?**

From 27.0 on, yes. Versions are `YY.minor.patch`: the major is the year of the cycle (27 for 2027) and is raised at most once a year, and only a major may break the contract, after a deprecation (`@deprecated`, a warning once per process, a CHANGELOG entry). A minor adds features, a patch fixes bugs, so `^27.0.0` is safe. The release candidates (`27.0.0-rc.N`, on the `next` dist-tag) already have the frozen contract and take only fixes. Before 27.0 (`0.0.x`) anything could break, and each break is listed in the CHANGELOG as **Breaking.** with a before/after migration. What is covered: the documented behavior, every export of `@afora/core`, `/adapters` and `/testing`, the format of descriptors, the issue `code` values and `afora.json` (`version: 1`). What is not: the text of error messages (match on the class, the layer or the `code`), anything in `@afora/core/experimental`, internal modules and benchmark numbers. The full policy is [VERSIONING.md](../VERSIONING.md), and [API tiers](api-tiers.md) gives the tier of each export.

**Where do I import from?**

`@afora/core` for application code. `@afora/core/adapters` for sinks, providers and code generators. `@afora/core/testing` for the test kit. `@afora/core/experimental` only if you accept that it may change. See [API tiers](api-tiers.md).

**Which TypeScript versions work?**

TypeScript >= 5.5 (optional peer). It is tested on 5.5, the latest 5.x and 7, with `bundler` and `nodenext` resolution.

## Agents and tooling

**Can an agent write the app?**

That is a design goal. `@afora/mcp` is an MCP server (stdio) with which an agent reads the catalog, edits the `afora.json`, validates it, generates the code and gets the TypeScript diagnostics of what was generated. All writes stay inside the project directory. See [CLI](cli.md#afora-mcp) and the [mcp README](../packages/mcp/README.md).

**Can I expose my domain as MCP tools?**

Yes: the `mcpTools` stage of `@afora/mcp` turns the operations of an output into MCP tools, the same ones `@afora/hono` serves over HTTP.

**Does the code generator overwrite my files?**

Only files that carry the generated banner. A file that exists without it is refused, and nothing is written. See [CLI](cli.md#afora-codegen-generate).

## More

- [Troubleshooting](troubleshooting.md) for an error you have.
- [Glossary](glossary.md) for a term.
- [Discussions](https://github.com/afora-framework/core/discussions) for a question this page does not answer.
