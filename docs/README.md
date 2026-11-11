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

## Start here

| Page                                              | For                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Tutorial](tutorial.md)                           | Building an API step by step, on Bun or Node.                                |
| [Coming from Hono + Zod](coming-from-hono-zod.md) | The same endpoint before and after, what moves where, and what you can keep. |
| [afora.json](afora-json.md)                       | Writing the application as data, by hand or with an agent.                   |

## Reference

The [README](../README.md) has the install, a quick start and an overview. These pages are the reference, one per concept. The concepts build on each other, so reading them in this order works.

| Page                                    | What it covers                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Properties](properties.md)             | `propertyOf`, `Property.with`, the Std properties, the `preHandle -> validation -> afterHandle` pipeline. |
| [Blueprints](blueprints.md)             | Object shapes, `listOf`, `optionalOf`, `join`, plugins that extend the context.                           |
| [Records](records.md)                   | `recordOf`, `sensitive`, `unique`, `change`, record plugins, experimental slicing.                        |
| [Entities](entities.md)                 | Identity, timestamps, `destroy()`, domain events.                                                         |
| [Repositories](repositories.md)         | Actions, queries, deletion, providers, transactions, relations, extending, testing a provider.            |
| [Schema evolution](schema-evolution.md) | `fill`, `renamedFrom`, `schemaVersion` and `upgrade`, `previousNames`, `app.migrate`, the schema lock.    |
| [Use cases](use-cases.md)               | Method injection, context and metadata, the steps DSL and its tables, use case plugins.                   |
| [Commands](commands.md)                 | Operations, use case plugins by catalog, transactions, event policies and `publishEvents`.                |
| [Standard use cases](std-use-cases.md)  | `ctx.create(Posts)` and the others: what each needs, takes and does, their options, ownership.            |
| [Outputs](outputs.md)                   | Stages, the `select` and `openapi` ones, `statusOf` and `problemOf`, catalogs of stages.                  |
| [HTTP providers](providers.md)          | Hono, Fastify, Express, Elysia: the same options and hooks, one behavior; writing a provider.             |
| [Access](auth.md)                       | `access` and `@Access`: scopes, owner, context from the caller; `Unauthenticated` and `Forbidden`.        |
| [Applications](applications.md)         | The manifest of declarations, composition, bound providers, `describe()`.                                 |
| [Exceptions](exceptions.md)             | Layers, `trace`, `guard`.                                                                                 |
| [Logging](logging.md)                   | `log` and log providers, the `Logger` dependency, `logFrom`; what afora logs.                             |
| [Environments](environments.md)         | Validated environment variables.                                                                          |
| [Standard Schema](standard-schema.md)   | Hono, tRPC, TanStack Form, `safeParse`, issue codes.                                                      |
| [OpenAPI](openapi.md)                   | `toOpenAPI` for models; the `openapi` sink is in [Outputs](outputs.md).                                   |
| [afora.json](afora-json.md)             | The JSON-first guide: generate, extract, round trip, catalogs, limitations.                               |

## API tiers

Every export belongs to a tier, and the tier says where to import it from. [API tiers](api-tiers.md) has the tier of each export, with the reason.

| Tier         | Import from                | What it holds                                                                                                                            | Semver |
| ------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| stable       | `@afora/core`              | The concepts of these pages: what application code declares, runs and catches.                                                           | yes    |
| adapters     | `@afora/core/adapters`     | Plumbing for sinks, providers and code generators: `IRepositoryProvider`, `sinkOf`, `problemOf`, `statusOf`, the `app.describe()` types. | yes    |
| testing      | `@afora/core/testing`      | `providerContract` and `memoryPublisher`, for packages that implement a provider or a publisher.                                         | yes    |
| experimental | `@afora/core/experimental` | Slicing, and description helpers such as `stageDescriptionOf` and `useCaseTargetOf`.                                                     | no     |
| internal     | not exported               | Base classes (`AbstractEntity`...), runtime guards, constants of a rule.                                                                 | no     |

Only stable, adapters and testing are the contract of [VERSIONING.md](../VERSIONING.md): before 1.0 a break there is marked **Breaking.** in the CHANGELOG with a Migration block (before and after), and from 1.0 on it waits for a major. Experimental exports may change in any release, and internal code is not the API. Application code needs only `@afora/core`.

Other documents: [VERSIONING.md](../VERSIONING.md) says what is stable, [CHANGELOG.md](../CHANGELOG.md) lists every change, and each package has its own README: [codegen](../packages/codegen/README.md), [mcp](../packages/mcp/README.md), [hono](../packages/hono/README.md), [fastify](../packages/fastify/README.md), [express](../packages/express/README.md), [elysia](../packages/elysia/README.md), [ws](../packages/ws/README.md), [drizzle](../packages/drizzle/README.md) and [dynamodb](../packages/dynamodb/README.md).
