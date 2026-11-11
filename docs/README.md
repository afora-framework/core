# Documentation

A CRUD API over HTTP, validated, documented and with its guarantees, is four declarations:

```ts
import {
	blueprintOf,
	commandOf,
	entityOf,
	outputOf,
	repositoryOf,
	resourceOf,
} from "@afora/core";
import { hono } from "@afora/hono";

// What a post is: each field validates and normalizes its value
export class Post extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text, slug: ctx.slug, body: ctx.text })),
	{ unique: ["slug"], change: ["title", "body"] },
) {}

// Where posts are kept: in memory, until you name a provider
const Posts = repositoryOf({
	entity: Post,
	actions: ["findById", "findPage", "create", "update", "delete"],
});

// What can be done with them: the five operations of a REST resource
const Blog = commandOf({
	name: "Blog",
	useCases: resourceOf(Posts, { path: "/posts" }),
});

// How they are served: an HTTP API, with its OpenAPI document
const Api = outputOf({
	name: "Api",
	commands: [Blog],
	pipe: [
		hono({
			docs: {
				path: "/openapi.json",
				info: { title: "Blog", version: "1.0.0" },
			},
		}),
	],
});

export const api = Api.build();

if (import.meta.main) Bun.serve({ fetch: api.fetch });
```

That is `POST /posts`, `GET /posts`, `GET /posts/{id}`, `PATCH /posts/{id}`, `DELETE /posts/{id}` and `GET /openapi.json`, with a 400 and its issues for an invalid body, a 409 for a slug that exists, and no key accepted that the blueprint does not declare. The [tutorial](tutorial.md) starts from this file and adds a rule of your own, sign in and access, one step at a time.

The pages follow the sections of the site, in reading order; [nav.json](nav.json) lists them and [About these docs](site.md) explains how they are organized.

## Getting started

The [README](../README.md) says what afora is and when not to use it, installs it on Bun or Node, and has a quick start in TypeScript and in `afora.json`. The concepts build on each other the way the code does:

property → blueprint → record → entity → repository → use case → command → output → application

A property validates one value, a blueprint is a shape made of properties, a record holds a value of that shape, and an entity is a record with an identity. A repository stores entities, a use case is one operation of the domain, a command groups use cases with their transactions and events, an output serves commands (as HTTP, OpenAPI, WebSocket...), and an application gathers all of it and starts it.

## Tutorial and guides

| Page                                              | For                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Tutorial](tutorial.md)                           | Building an API step by step, on Bun or Node.                                    |
| [Coming from Hono + Zod](coming-from-hono-zod.md) | The same endpoint before and after, what moves where, and what you can keep.     |
| [afora.json](afora-json.md)                       | Writing the application as data, by hand or with an agent.                       |
| [Testing an application](testing.md)              | Testing records, use cases, an application and its HTTP API, without a database. |

## Concepts

One page per concept, the spec of its behavior. Reading them in this order works.

| Page                                                 | What it covers                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Properties](properties.md)                          | `propertyOf`, `Property.with`, the `preHandle -> validation -> afterHandle` pipeline, enums, unions, JSON. |
| [Standard properties and plugins](std-properties.md) | Every standard property (`Id`, `Email`, `Password`, dates...) and the five record plugins.                 |
| [Blueprints](blueprints.md)                          | Object shapes, `listOf`, `optionalOf`, `variantOf`, `join`, plugins that extend the context.               |
| [Records](records.md)                                | `recordOf`, `sensitive`, `unique`, `change`, record plugins, experimental slicing.                         |
| [Entities](entities.md)                              | Identity, timestamps, `destroy()`, domain events.                                                          |
| [Repositories](repositories.md)                      | Actions, queries, deletion, providers, transactions, relations, extending, testing a provider.             |
| [Schema evolution](schema-evolution.md)              | `fill`, `renamedFrom`, `schemaVersion` and `upgrade`, `previousNames`, `app.migrate`, the schema lock.     |
| [Use cases](use-cases.md)                            | Method injection, context and metadata, the steps DSL and its tables, use case plugins.                    |
| [Commands](commands.md)                              | Operations, use case plugins by catalog, transactions, event policies and `publishEvents`.                 |
| [Standard use cases](std-use-cases.md)               | `ctx.create(Posts)` and the others: what each needs, takes and does, their options, ownership.             |
| [Outputs](outputs.md)                                | Stages, the `select` and `openapi` ones, `statusOf` and `problemOf`, catalogs of stages.                   |
| [HTTP providers](providers.md)                       | Hono, Fastify, Express, Elysia: the same options and hooks, one behavior; writing a provider.              |
| [Access](auth.md)                                    | `access` and `@Access`: scopes, owner, context from the caller; `Unauthenticated` and `Forbidden`.         |
| [Applications](applications.md)                      | The manifest of declarations, composition, bound providers, `describe()`.                                  |
| [Environments](environments.md)                      | Validated environment variables.                                                                           |
| [Exceptions](exceptions.md)                          | Layers, `trace`, `guard`.                                                                                  |
| [Logging](logging.md)                                | `log` and log providers, the `Logger` dependency, `logFrom`; what afora logs.                              |
| [Tracing](tracing.md)                                | `trace` and `@afora/otel`: the spans afora makes, their attributes, no value in any span.                  |
| [Standard Schema](standard-schema.md)                | Hono, tRPC, TanStack Form, `safeParse`, `stripUndeclared`.                                                 |
| [OpenAPI](openapi.md)                                | `toOpenAPI` for models; the `openapi` sink is in [Outputs](outputs.md).                                    |

## Recipes

Short answers to common tasks, each with code that `bun run test:interop` runs.

- [Soft delete and restore](recipes/soft-delete.md)
- [Pagination with a cursor](recipes/cursor-pagination.md)
- [Uniqueness across tenants](recipes/tenant-uniqueness.md)
- [Publishing domain events](recipes/domain-events.md)
- [A custom property](recipes/custom-property.md)
- [A custom provider](recipes/custom-provider.md)
- [A custom stage and sink](recipes/custom-sink-or-stage.md)
- [Overriding a repository method in a test](recipes/override-repository-method.md)

## Packages

Each package has its own README: [codegen](../packages/codegen/README.md) and [mcp](../packages/mcp/README.md) (with the [command line](cli.md) reference of both), the HTTP providers [hono](../packages/hono/README.md), [fastify](../packages/fastify/README.md), [express](../packages/express/README.md) and [elysia](../packages/elysia/README.md), the [ws](../packages/ws/README.md) sink, the [otel](../packages/otel/README.md) tracer, and the storage providers [drizzle](../packages/drizzle/README.md) and [dynamodb](../packages/dynamodb/README.md).

## Runtime and deployment

[Runtime](runtime.md): what runs on Bun, Node, Workers and browsers, password hashing and ids (`configure`, `resetRuntime`), and deploying on each target.

## Reference

| Page                                                       | What it lists                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [API reference](reference/api.md)                          | Every export, by entry point, from its JSDoc.                                  |
| [Exceptions](reference/exceptions.md)                      | Every exception: its layer, what throws it, its HTTP status, how to handle it. |
| [Issue codes](reference/issue-codes.md)                    | The codes of `safeParse` issues, and where issues end up.                      |
| [afora.json schema](../packages/codegen/afora.schema.json) | The JSON Schema of `afora.json`.                                               |
| [API tiers](api-tiers.md)                                  | The tier of each export, with the reason.                                      |

### API tiers

Every export belongs to a tier, and the tier says where to import it from. [API tiers](api-tiers.md) has the tier of each export, with the reason.

| Tier         | Import from                | What it holds                                                                                                                            | Semver |
| ------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| stable       | `@afora/core`              | The concepts of these pages: what application code declares, runs and catches.                                                           | yes    |
| adapters     | `@afora/core/adapters`     | Plumbing for sinks, providers and code generators: `IRepositoryProvider`, `sinkOf`, `problemOf`, `statusOf`, the `app.describe()` types. | yes    |
| testing      | `@afora/core/testing`      | `providerContract` and `memoryPublisher`, for packages that implement a provider or a publisher.                                         | yes    |
| experimental | `@afora/core/experimental` | Slicing, and description helpers such as `stageDescriptionOf` and `useCaseTargetOf`.                                                     | no     |
| internal     | not exported               | Base classes (`AbstractEntity`...), runtime guards, constants of a rule.                                                                 | no     |

Only stable, adapters and testing are the contract of [VERSIONING.md](../VERSIONING.md): before 27.0 a break there is marked **Breaking.** in the CHANGELOG with a Migration block (before and after), and from 27.0 on it waits for the next year's major. Experimental exports may change in any release, and internal code is not the API. Application code needs only `@afora/core`.

## Project

[VERSIONING.md](../VERSIONING.md) says what is stable, [CHANGELOG.md](../CHANGELOG.md) lists every change, [Performance](performance.md) explains the benchmarks ([results](../bench/RESULTS.md)), and [FAQ](faq.md), [Troubleshooting](troubleshooting.md) and the [Glossary](glossary.md) answer the common questions. [CONTRIBUTING.md](../CONTRIBUTING.md) covers working on afora itself.
