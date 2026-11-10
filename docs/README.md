# Documentation

The [README](../README.md) has the install, a quick start and an overview. These pages are the reference, one per concept. The concepts build on each other, so reading them in this order works.

| Page                                  | What it covers                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Properties](properties.md)           | `propertyOf`, `Property.with`, the Std properties, the `preHandle -> validation -> afterHandle` pipeline. |
| [Blueprints](blueprints.md)           | Object shapes, `listOf`, `optionalOf`, `join`, plugins that extend the context.                           |
| [Records](records.md)                 | `recordOf`, `sensitive`, `unique`, `change`, record plugins, experimental slicing.                        |
| [Entities](entities.md)               | Identity, timestamps, `destroy()`, domain events.                                                         |
| [Repositories](repositories.md)       | Actions, queries, deletion, providers, transactions, relations, extending, testing a provider.            |
| [Use cases](use-cases.md)             | Method injection, context and metadata, the steps DSL and its tables.                                     |
| [Commands](commands.md)               | Operations, transactions and the event policy.                                                            |
| [Outputs](outputs.md)                 | Stages, the `select` and `openapi` ones, `statusOf` and `problemOf`, catalogs of stages.                  |
| [Applications](applications.md)       | The manifest of declarations, composition, bound providers, `describe()`.                                 |
| [Exceptions](exceptions.md)           | Layers, `trace`, `guard`.                                                                                 |
| [Logging](logging.md)                 | `log` and log providers, the `Logger` dependency, `logFrom`; what afora logs.                             |
| [Environments](environments.md)       | Validated environment variables.                                                                          |
| [Standard Schema](standard-schema.md) | Hono, tRPC, TanStack Form, `safeParse`, issue codes.                                                      |
| [OpenAPI](openapi.md)                 | `toOpenAPI` for models; the `openapi` sink is in [Outputs](outputs.md).                                   |
| [afora.json](afora-json.md)           | The JSON-first guide: generate, extract, round trip, catalogs, limitations.                               |

Other documents: [VERSIONING.md](../VERSIONING.md) says what is stable, [CHANGELOG.md](../CHANGELOG.md) lists every change, and each package has its own README: [codegen](../packages/codegen/README.md), [mcp](../packages/mcp/README.md), [hono](../packages/hono/README.md) and [drizzle](../packages/drizzle/README.md).
