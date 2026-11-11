<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/afora-banner-dark.png">
    <img alt="afora — Simple to write. Built to hold." src=".github/assets/afora-banner-light.png" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@afora/core"><img alt="npm" src="https://img.shields.io/npm/v/@afora/core?color=cb3837&logo=npm"></a>
  <a href="https://github.com/afora-framework/core/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/afora-framework/core/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://www.npmjs.com/package/@afora/core"><img alt="npm provenance" src="https://img.shields.io/badge/npm-provenance-2ea44f?logo=npm"></a>
  <a href="https://standardschema.dev"><img alt="Standard Schema V1" src="https://img.shields.io/badge/Standard%20Schema-V1-3178c6"></a>
  <img alt="Bun >= 1.4.4 and Node >= 22" src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.4.4%20%7C%20Node%20%E2%89%A5%2022-555">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/afora-framework/core"></a>
</p>

<p align="center">
  <a href="https://getafora.com">Website</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/afora-json.md">afora.json</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/afora-framework/core/discussions">Discussions</a>
</p>

<h3 align="center">Simple to write. Built to hold.</h3>

**afora is a domain-first framework for TypeScript backends.** You declare what your entities, use cases and API are, and the runtime keeps the guarantees that are easy to forget: secrets stay masked, unknown fields are rejected, unique keys hold and business errors get the right status. Whoever writes the code, you or your agent, it holds.

Model the domain; the runtime keeps the invariants. Built on [TypeBox](https://github.com/sinclairzx81/typebox), with [Standard Schema](https://standardschema.dev) on every field, on Bun and Node.

## Why afora

An HTTP backend written by an agent (or in a hurry) tends to break the same few guarantees. In afora each one is part of the runtime, not a convention the code has to remember:

| What usually breaks                            | What afora does                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A password hash or token ends up in a response | A `sensitive` property is masked by `toJSON()` at any depth, so no serializer can leak it ([records](docs/records.md)). |
| Extra fields in a request body are accepted    | Undeclared keys are rejected at any depth, and the API answers 400 ([Standard Schema](docs/standard-schema.md)).        |
| A business error is returned as a 500          | Errors know their layer and become problem+json with the right status ([outputs](docs/outputs.md)).                     |
| A duplicate email is written twice             | `unique` keys are enforced by the repository, and a violation is a 409 ([repositories](docs/repositories.md)).          |

[`examples/agent-built`](examples/agent-built/README.md) checks these four on the running API of a ticketing backend an agent built through the MCP server, next to a Hono + Zod baseline written from the same brief. Both hold them; the afora one wrote no code for any of them.

## For you and your agent

**Developer experience**

- **Four declarations to a CRUD API:** an entity, a repository, a command and an output ([overview](docs/README.md)).
- **Types that follow the model:** inputs and responses are inferred, `findByEmail` exists because `email` is unique, and `user.change.password()` because you allowed it.
- **Fits what you already use:** every field is a Standard Schema, so Hono, tRPC and TanStack Form take it as is.
- **Any server, any store:** [Hono](packages/hono/README.md), [Fastify](packages/fastify/README.md), [Express](packages/express/README.md) or [Elysia](packages/elysia/README.md); in memory, [Drizzle](packages/drizzle/README.md) or [DynamoDB](packages/dynamodb/README.md).
- **Errors you can read:** each one names its layer and carries the trace of the layers it crossed ([exceptions](docs/exceptions.md)).

**Agent experience**

- **The application is data:** an `afora.json` declares the entities, the use cases (as steps), the commands and the HTTP API ([guide](docs/afora-json.md)).
- **An MCP server to write it:** [`@afora/mcp`](packages/mcp/README.md) lets an agent read the catalog, edit and validate the spec, generate the code and see its TypeScript diagnostics.
- **Code you review:** [`@afora/codegen`](packages/codegen/README.md) turns the spec into the TypeScript you would write by hand, committed; `extractSpec(app)` gives the spec back from code written by hand.
- **The runtime holds what the agent forgets:** the four rows above, with no code written for them. `examples/blog` is a whole API generated from one `afora.json`.

## Install

```bash
bun add @afora/core typebox   # or: npm install @afora/core typebox
```

Bun >= 1.4.4 or Node.js >= 22; it also loads in browsers and Workers. TypeBox (`typebox`, `^1`) is a peer dependency. How passwords are hashed and ids made on each runtime, and how to replace them with `configure`: [Runtime](docs/runtime.md).

## Quick start

A `User` with a masked password and a unique email, a use case written as steps, a transaction, and an HTTP API with an OpenAPI document. Install what it uses:

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

// Use case: the steps and the route are data, so they can also live in an afora.json
class Register extends useCaseOf({
	name: "Register",
	route: { method: "post", path: "/users", status: 201 }, // where it is served
	blueprint: blueprintOf((ctx) => ({
		name: ctx.text,
		email: ctx.email,
		plainPassword: ctx.string,
	})),
	response: blueprintOf(() => ({ user: User })),
	dependencies: { users: Users },
	errors: [UserAlreadyExists],
	strictSteps: true, // TypeScript checks every reference, arg and the return
	steps: [
		{ find: "users.findByEmail", args: ["$input.email"], as: "existing" },
		{ ensure: "absent", value: "$existing", error: UserAlreadyExists },
		{
			run: "hashPassword",
			fn: hashPassword,
			args: ["$input.plainPassword"],
			params: blueprintOf((ctx) => ({ plain: ctx.string })),
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
POST /api/users  { "name": "Ana", "email": "  Ana@Example.COM ", "plainPassword": "Str0ng!Pass" }
-> 201 { "user": { "id": "...", "name": "Ana", "email": "ana@example.com", "password": "********", ... } }

the same email again
-> 409 application/problem+json  { "title": "UserAlreadyExists", "layer": "use-case", ... }

{ "name": "Ana", "email": "nope" }
-> 400 application/problem+json  { ..., "issues": [{ "path": ["email"], ... }, { "path": ["plainPassword"], ... }] }

GET /openapi.json -> the OpenAPI 3.1 document of the route
```

### The same app as an afora.json

Everything above except the hashing function is data, so it can be written as an `afora.json`. `@afora/codegen` turns it into the same TypeScript, committed and reviewable, and `@afora/mcp` lets an agent write it.

<details>
<summary>The <code>afora.json</code>, the three hand-written files and the commands</summary>

This is `examples/interop/quickstart.afora.json`, which the same test validates and generates.

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
			"route": { "method": "post", "path": "/users", "status": 201 },
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
						"params": { "fields": { "plain": "string" } },
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

Then generate, telling codegen where the `hono` stage comes from in `stages.ts`:

```ts
export { stages } from "@afora/hono";
```

```bash
bun add -d @afora/codegen
bunx afora-codegen generate afora.json --stages ./stages.ts   # writes src/domain/*.ts
```

and serve the application from `src/server.ts` (`bun src/server.ts`):

<!-- docs:code skip: src/server.ts of examples/interop/from-json; ./domain is what afora-codegen generates from the afora.json above -->
```ts
import { App } from "./domain/index.ts";

await App.start();
export const api = App.outputs.Api.build();

if (import.meta.main) Bun.serve({ fetch: api.fetch });
```

These three files are `examples/interop/from-json`, which `bun run test:interop` generates and serves.

`generate` writes one file per kind (`entities.ts`, `repositories.ts`, `use-cases.ts`, `commands.ts`, `outputs.ts`...), an `application.ts` and an `index.ts`, each starting with a banner saying not to edit it. `afora-codegen extract` goes the other way and gives the `afora.json` of an `Application`. The guide is in [docs/afora-json.md](docs/afora-json.md).

</details>

## Learn more

- [Tutorial](docs/tutorial.md): an API built step by step, and [coming from Hono + Zod](docs/coming-from-hono-zod.md).
- [Concepts](docs/README.md), in the order they build on one another: property → blueprint → record → entity → repository → use case → command → output → application.
- [The afora.json guide](docs/afora-json.md) and the [MCP server](packages/mcp/README.md).
- [API reference](docs/reference/api.md), [FAQ](docs/faq.md) and [troubleshooting](docs/troubleshooting.md).

## Packages

| Package                                                    | What it does                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| [`@afora/core`](https://www.npmjs.com/package/@afora/core) | The framework: from properties to outputs (this repository).      |
| [`@afora/codegen`](packages/codegen/README.md)             | `afora.json` to TypeScript, and an application back to its spec.  |
| [`@afora/mcp`](packages/mcp/README.md)                     | An MCP server that lets an agent build the domain.                |
| [`@afora/hono`](packages/hono/README.md)                   | Serves the operations on Hono, with an optional OpenAPI document. |
| [`@afora/fastify`](packages/fastify/README.md)             | The same on Fastify.                                              |
| [`@afora/express`](packages/express/README.md)             | The same on Express 5.                                            |
| [`@afora/elysia`](packages/elysia/README.md)               | The same on Elysia.                                               |
| [`@afora/ws`](packages/ws/README.md)                       | Operations and domain events over WebSocket.                      |
| [`@afora/drizzle`](packages/drizzle/README.md)             | Repositories on Drizzle ORM (SQLite and Postgres).                |
| [`@afora/dynamodb`](packages/dynamodb/README.md)           | Repositories on one DynamoDB table.                               |
| [`@afora/otel`](packages/otel/README.md)                   | OpenTelemetry spans per command, use case and repository call.    |

## Performance

afora validates and transforms faster than Zod 4 on most of the fourteen measured cases; checkers that compile and do not transform (TypeBox, Ajv, Typia) are faster still. The method, every case and the trade-offs are in [Performance](docs/performance.md).

<!-- bench:start -->

![Validations per second on the body of an API request, Node v24.22.2](bench/results/chart.svg)

afora 0.0.11 on Bun 1.4.4, Node v22.23.4 and Node v24.22.2, AMD EPYC 9V74 80-Core Processor; generated from `bench/results/latest.json`. Every case, runtime and library, and how it is measured: [Performance](docs/performance.md).

<!-- bench:end -->

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the checks and how releases work. Questions go to [Discussions](https://github.com/afora-framework/core/discussions); security issues go through [SECURITY.md](SECURITY.md), never a public issue. What is stable and how deprecations work is in [VERSIONING.md](VERSIONING.md).

## License

MIT
