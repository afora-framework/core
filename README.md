# afora

Domain modeling on [TypeBox](https://github.com/sinclairzx81/typebox): entities with invariants, sensitive data masking and exceptions that know their layer, usable by any [Standard Schema](https://standardschema.dev) consumer.

afora is not a general-purpose validator. It is for code that models a domain, and it plugs into the validators your framework already accepts.

- **Records with invariants.** Properties (`Email`, `Slug`, `Password`, your own) validate and normalize every value; blueprints compose them; a record (`class User extends recordOf(...)`) holds the handled value and rejects undeclared keys at any depth.
- **Sensitive data masking.** A property declared `sensitive` (`Password`) is masked by `toJSON()` at any depth, so `JSON.stringify(user)` cannot leak it.
- **Entities, repositories and use cases.** `entityOf` adds identity, timestamps and domain events; `repositoryOf` generates typed `findBy<Key>` methods for the keys in `options.unique` and enforces them; use cases inject repositories and environments and can override them per call.
- **Typed change namespace and side effects.** `change: ["password"]` generates `change.password(value)` (also destructurable, as `const { change } = user`), which re-validates the value and runs `onSetAll` and `onSet`.
- **Exceptions that know their layer.** Each error carries a layer (`Property`, `Record`, `UseCase`, `Output`...) and a `trace` that grows as it goes up.
- **Standard Schema V1 on every field.** Properties, blueprints, lists and record classes work as is in Hono, tRPC and TanStack Form, and `safeParse` never throws for an invalid value.
- **Commands and outputs.** `commandOf` groups use cases behind one execution boundary (context, transactions, event policies); `outputOf` turns commands into operations and pipes them to a sink: an HTTP API with `@afora/hono`, an OpenAPI 3.1 document, or MCP tools, with problem+json errors and masked responses.
- **The whole application in JSON.** An `afora.json` generates the code (`@afora/codegen`), use cases included, as data (steps), and `extractSpec(app)` gives back the `afora.json` of an application written by hand.
- **Repositories on any store.** A provider contract with typed queries, soft deletion and transactions, a runner-agnostic kit to test one (`@afora/core/testing`), in memory by default and on Drizzle ORM with `@afora/drizzle`.

## Install

```bash
bun add @afora/core typebox   # or: npm install @afora/core typebox
```

Requirements: [Bun](https://bun.sh) >= 1.4.4 or Node.js >= 22. TypeBox (`typebox`, version `^1`) is a required peer dependency, shared with your application and afora's companion packages. The package ships ESM with TypeScript declarations; TypeScript >= 5.5 is an optional peer dependency.

`Password` hashes with argon2id: with `Bun.password` on Bun, with native `node:crypto` argon2 on a Node that has it (24.7+), and otherwise it throws `PasswordHasherRequired` until you call `configure({ hasher })`. `Id.generate()` makes a portable, monotonic UUID v7 on any runtime. afora imports no `node:crypto` (or `Buffer`) at load, so it loads in browsers and Workers; the native hasher is looked up on first use through `process.getBuiltinModule` (Node 22.3+). The native hasher derives argon2 version 19 only; a hash of another version throws `UnsupportedPasswordHash` (verify it with `Bun.password`, or `configure({ hasher })`).

```ts
import { configure, type PasswordHasher } from "@afora/core";

const hasher: PasswordHasher = {
	hash: (plain) => myArgon2.hash(plain),
	verify: (plain, hash) => myArgon2.verify(plain, hash),
	verifySync: (plain, hash) => myArgon2.verifySync(plain, hash), // optional; `Password.verifySync` throws without it
};
configure({ hasher, idGenerator: () => myUuidV7() }); // both optional; `resetRuntime()` restores the defaults
```

## Quick start

A `User` entity with a sensitive key and a unique key, a repository, a use case written as steps, a command that wraps it in a transaction, and an output that serves the command as an HTTP API with an OpenAPI document. Install what it uses:

```bash
bun add @afora/core @afora/hono hono typebox
```

Save this as `quickstart.ts` and run `bun quickstart.ts`. It is the code of `examples/interop/quickstart.ts`, run by `bun run test:interop` (there the imports resolve to the local sources).

```ts
import {
	blueprintOf,
	commandOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	outputOf,
	Password,
	repositoryOf,
	useCaseOf,
} from "@afora/core";
import { hono } from "@afora/hono";

// Entity: invariants, a sensitive key and a unique key
export class User extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.text,
		email: ctx.email, // trimmed and lowercased
		password: ctx.password, // only an argon2 hash is accepted; always masked
	})),
	{ unique: ["email"] },
) {}

// Repository: only the actions you choose; the provider is in memory by default
const Users = repositoryOf({
	entity: User,
	actions: ["findByEmail", "create"],
});

const UserAlreadyExists = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "UserAlreadyExists",
	message: "A user with this email already exists.",
});

async function hashPassword(plain: string) {
	return (await Password.hash(plain)).value;
}

// Use case: the steps are data, so they can also live in an afora.json
class Register extends useCaseOf({
	name: "Register",
	blueprint: blueprintOf((ctx) => ({
		name: ctx.text,
		email: ctx.email,
		plainPassword: ctx.string,
	})),
	response: blueprintOf(() => ({ user: User })),
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

// Command: the execution boundary (here, one transaction per call)
const Accounts = commandOf({
	name: "Accounts",
	useCases: { register: Register },
	transaction: true,
});

// Output: the commands as an HTTP API with an OpenAPI document
const Api = outputOf({
	name: "Api",
	commands: [Accounts],
	statuses: { UserAlreadyExists: 409 },
	pipe: [
		hono({
			basePath: "/api",
			docs: {
				path: "/openapi.json",
				info: { title: "Accounts", version: "1.0.0" },
			},
		}),
	],
});

export const api = Api.build();

if (import.meta.main) Bun.serve({ fetch: api.fetch });
```

What it does:

```
POST /api/accounts/register  { "name": "Ana", "email": "  Ana@Example.COM ", "plainPassword": "Str0ng!Pass" }
-> 200 { "user": { "id": "...", "name": "Ana", "email": "ana@example.com", "password": "********", ... } }

the same email again
-> 409 application/problem+json  { "title": "UserAlreadyExists", "layer": "use-case", ... }

{ "name": "Ana", "email": "nope" }
-> 400 application/problem+json  { ..., "issues": [{ "path": ["email"], ... }, { "path": ["plainPassword"], ... }] }

GET /openapi.json -> the OpenAPI 3.1 document of the route
```

### The same app as an afora.json

Everything above, except the hashing function, is data, so it can be written as an `afora.json` and generated. `@afora/codegen` writes the TypeScript you would have written by hand (the classes above, plus an `applicationOf`), committed and reviewable. This is `examples/interop/quickstart.afora.json`, which the same test validates and generates.

```json
{
	"version": 1,
	"name": "accounts",
	"output": { "dir": "src/domain" },
	"provider": "inMemory",
	"entities": {
		"User": {
			"fields": { "name": "text", "email": "email", "password": "password" },
			"unique": ["email"]
		}
	},
	"repositories": {
		"Users": { "entity": "User", "actions": ["findByEmail", "create"] }
	},
	"exceptions": {
		"UserAlreadyExists": {
			"layer": "use-case",
			"message": "A user with this email already exists."
		}
	},
	"useCases": {
		"Register": {
			"input": {
				"fields": {
					"name": "text",
					"email": "email",
					"plainPassword": "string"
				}
			},
			"response": { "fields": { "user": "User" } },
			"dependencies": { "users": "Users" },
			"errors": ["UserAlreadyExists"],
			"implementation": {
				"steps": [
					{
						"find": "users.findByEmail",
						"args": ["$input.email"],
						"as": "existing"
					},
					{
						"ensure": "absent",
						"value": "$existing",
						"error": "UserAlreadyExists"
					},
					{
						"run": "hashPassword",
						"fn": { "import": "../hash-password.ts#hashPassword" },
						"args": ["$input.plainPassword"],
						"as": "hash"
					},
					{
						"build": "User",
						"values": {
							"name": "$input.name",
							"email": "$input.email",
							"password": "$hash"
						},
						"as": "user"
					},
					{ "create": "users", "value": "$user", "as": "saved" },
					{ "return": { "user": "$saved" } }
				]
			}
		}
	},
	"commands": {
		"Accounts": { "useCases": { "register": "Register" }, "transaction": true }
	},
	"outputs": {
		"Api": {
			"commands": ["Accounts"],
			"statuses": { "UserAlreadyExists": 409 },
			"pipe": [
				{
					"sink": "hono",
					"options": {
						"basePath": "/api",
						"docs": {
							"path": "/openapi.json",
							"info": { "title": "Accounts", "version": "1.0.0" }
						}
					}
				}
			]
		}
	}
}
```

The `run` step names a function written by hand, imported relative to the output directory. Put it in `src/hash-password.ts`:

```ts
import { Password } from "@afora/core";

export async function hashPassword(plain: string) {
	return (await Password.hash(plain)).value;
}
```

Then generate, telling codegen where the `hono` stage comes from, and serve the application:

```bash
bun add -d @afora/codegen
bunx afora-codegen generate afora.json --stages @afora/hono   # writes src/domain/*.ts
```

```ts
import { App } from "./src/domain";

Bun.serve({ fetch: App.outputs.Api.build().fetch });
```

`generate` writes one file per kind (`entities.ts`, `repositories.ts`, `use-cases.ts`, `commands.ts`, `outputs.ts`...), an `application.ts` and an `index.ts`, each starting with a banner saying not to edit it. `afora-codegen extract` goes the other way and gives the `afora.json` of an `Application`. The guide is in [docs/afora-json.md](docs/afora-json.md).

## What you get

Each concept has a page in [docs/](docs/README.md), in the order they build on one another:

- [Properties](docs/properties.md): one validated and normalized value, with flags for `sensitive` and `unique`.
- [Blueprints](docs/blueprints.md): an object shape built from properties, lists, optionals and nested blueprints.
- [Records](docs/records.md): a class that holds the handled value, masks sensitive keys and generates `change.<key>`; plugins; experimental slicing.
- [Entities](docs/entities.md): a record with identity, timestamps, `destroy()` and domain events.
- [Repositories](docs/repositories.md): typed async methods for an entity, queries, soft deletion, providers, transactions and relations.
- [Use cases](docs/use-cases.md): the Command pattern with method injection, written as code or as steps.
- [Commands](docs/commands.md): use cases under operation names, with a context, a transaction and an event policy.
- [Outputs](docs/outputs.md): commands through stages into a sink, such as an HTTP API or an OpenAPI document.
- [Applications](docs/applications.md): a named, checked manifest of every declaration, and `describe()`.
- [Exceptions](docs/exceptions.md): errors that know their layer and keep a trace.
- [Environments](docs/environments.md): validated environment variables.
- [Standard Schema](docs/standard-schema.md), [OpenAPI](docs/openapi.md) and the [afora.json guide](docs/afora-json.md).

## Standard Schema

Every field (a property, blueprint, list or record class) implements Standard Schema V1 (`vendor: "afora"`), so Hono, tRPC, TanStack Form and any other library that takes one takes it as is. `validate` is synchronous, never throws for an invalid value and reports every issue with its `path`. Without a framework, `safeParse` returns `{ value }` or `{ issues }`. See [docs/standard-schema.md](docs/standard-schema.md); the real-library tests are in `examples/interop`.

## Packages

`@afora/codegen` generates afora code from an `afora.json` (and extracts the `afora.json` of an `Application` back), and `@afora/mcp` is an MCP server that lets an agent build a domain with it: see [packages/codegen](packages/codegen/README.md) and [packages/mcp](packages/mcp/README.md). `@afora/hono` is a `hono` sink for outputs: it serves the operations as a Hono app, with problem+json errors, masked responses and an optional OpenAPI document ([packages/hono](packages/hono/README.md)). `@afora/drizzle` is a repository provider on Drizzle ORM (SQLite and Postgres) that passes the provider contract kit: see [packages/drizzle](packages/drizzle/README.md).

## Example

`examples/blog` is a blog (users with the `authenticatable` plugin, posts with soft deletion, use cases written as steps, a Hono API on Drizzle and SQLite) whose whole `src/domain` is generated from one `afora.json` by `@afora/codegen`. Only the database, the schema, the provider (made from a `Database` environment with `providerFrom` when the server calls `App.start()`, and named `database` in the `providers` of the spec), a password hashing function and the server are hand-written. Its tests check that the committed code is what the spec generates, drive the API end to end and extract the spec back from the application: `bun run test:blog`.

## Performance

`bun run bench` compares afora with TypeBox (compiled), Zod 4, Valibot and ArkType on the same data, on Bun and on Node; the results are in `bench/RESULTS.md`. Absolute numbers depend on the machine, so read the ratios. On the measured machine (Apple M2):

- **Valid input.** afora is about 1.8x to 2.5x slower than Valibot and about 1.1x to 2.1x slower than Zod 4 (flat and nested objects, Bun and Node). It is faster than ArkType in these cases, where ArkType's morphs move it to a slower path.
- **Invalid input.** This is still where afora is weakest, but much closer than before. Flat objects are about 5x slower than Valibot and 3.7x slower than Zod 4 on Bun, and about 4.4x and 3.6x on Node; nested objects are about 2.9x and 2.1x on Bun, and about 3.1x on Node. It is faster than ArkType here. Most of what remains is TypeBox's own error collection, which runs once for each failing property; the `cause` exception of an issue is built only when it is read.
- **Floor.** Compiled TypeBox, which only checks and does not transform, is about 9x to 27x faster than afora on valid input. afora builds on it.

What afora does that the fast rows do not all do: a handler pipeline per property (`preHandle`, schema check, `afterHandle`), preceded by a shape check so handlers only see the right types; objects walked key by key instead of one compiled function; frozen results; every issue with `code`, `path` and `source`; and, for `Record.safeParse` and `new Record`, creating the instance. If you validate untrusted bulk data in a hot path and need none of that, use a validator built for it, and use afora at the domain boundary, where the cost per entity is small next to I/O.

## Comparison

A rough guide, not a verdict. "Partial" means it is possible but not what the library is for.

|                             | afora                                          | Zod 4               | Valibot        | Effect Schema                      |
| --------------------------- | ---------------------------------------------- | ------------------- | -------------- | ---------------------------------- |
| Standard Schema V1          | yes, on every field                            | yes                 | yes            | yes                                |
| Transforms                  | yes (`preHandle`, `afterHandle`)               | yes                 | yes            | yes                                |
| Domain entities / classes   | yes (records with change methods and effects)  | no                  | no             | partial (`Schema.Class`)           |
| Sensitive masking           | yes (`sensitive`, in `toJSON`)                 | no                  | no             | partial (`Redacted`)               |
| Layered errors with a trace | yes (`ExceptionLayers`, `trace`)               | no                  | no             | partial (tagged errors, no layers) |
| Runtime speed               | slower; see Performance                        | faster              | faster         | not measured here                  |
| Bundle size                 | not measured; depends on TypeBox and `slugify` | larger than Valibot | small, modular | larger                             |
| Ecosystem and maturity      | new, small                                     | very large          | large          | large, in the Effect ecosystem     |

Where the others win: Zod and Valibot are faster, have far larger ecosystems and documentation, and have integrations and code generators for most tools; Valibot is modular and small; Effect Schema fits a codebase already built on Effect. afora gives up those to model entities, masking and layers in the type you already validate with.

## Contributing

Issues open from a template: bug report, feature request, or feedback from building on afora. Questions go to [Discussions](https://github.com/afora-framework/core/discussions). Pull requests follow [the PR template](.github/PULL_REQUEST_TEMPLATE.md).

Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`feat(repository): …`, `fix: …`), checked by commitlint in a Husky `commit-msg` hook; the `pre-commit` hook runs Biome and Knip. CI runs lint, Knip, type checks, unit and interop tests, the build and the Node smoke test on every push and pull request. Pushing a `v*` tag that matches `package.json` publishes to npm with provenance.

Scripts:

```bash
bun install
bun test              # unit tests
bun check             # type check
bun run test:types    # build, then type-check the packed package on TypeScript, bundler and nodenext resolution
bun run test:type-perf # build, then budget the editor cost per edit and snapshot hovers, completions and errors
bun run test:api      # build, then snapshot the public surface (exports and declarations) and the afora.json schema
bun run test:interop  # Hono, tRPC and TanStack Form tests (examples/interop), including the quick start
bun run test:blog     # the generated blog (examples/blog): drift, API and extraction
bun run smoke         # build, then run the package on plain Node
bun run bench         # benchmark against TypeBox, Zod, Valibot and ArkType
bun run lint          # biome lint
bun run knip          # unused files, exports and dependencies
bun run fmt           # biome format + fix
bun run build         # build dist/ (ESM + .d.ts)
bun run test:codegen  # tests of packages/codegen
bun run test:mcp      # tests of packages/mcp
bun run test:hono     # tests of packages/hono
bun run test:drizzle  # tests of packages/drizzle (SQLite and PGlite)
bun run build:packages # build the core, then packages/codegen, packages/mcp, packages/hono and packages/drizzle
```

## Versioning

What is stable, what may break and how deprecations work is in [VERSIONING.md](VERSIONING.md).

## License

MIT
