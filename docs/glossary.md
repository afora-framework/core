# Glossary

The terms afora uses, in alphabetical order. Each entry is short and points to the page that has the rest.

**access.** What a use case declares about who may call it: scopes, an owner, `public`. The output checks it before the use case runs and rejects with `Unauthenticated` (401) or `Forbidden` (403). See [Access](auth.md).

**action.** One of the methods a repository generates (`findById`, `findPage`, `create`, `update`, `delete`, `restore`...). `repositoryOf({ actions })` lists the ones you want, and only those exist. See [Repositories](repositories.md).

**afora.json.** A JSON file that declares an application as data: properties, entities, repositories, use cases, commands and outputs. `@afora/codegen` turns it into TypeScript and back. See [afora.json](afora-json.md) and [CLI](cli.md).

**application.** The named, immutable manifest made by `applicationOf` that gathers declarations, binds repositories to a provider and starts everything in one context. See [Applications](applications.md).

**blueprint.** An object shape made of properties, built with `blueprintOf((ctx) => ({ ... }))`. It validates and normalizes a value, and has `safeParse`. See [Blueprints](blueprints.md).

**catalog.** A named list from which a spec picks by name: providers, stages, event policies (given to codegen with `--providers`, `--stages`, `--policies`) and use case plugins (`useCaseCatalogOf`). See [afora.json](afora-json.md#catalogs-providers-stages-and-event-policies).

**change.** The `change` option of a record: `change: ["title"]` generates `instance.change.title(value)`, a typed way to set a key. See [Records](records.md).

**command.** A group of use cases under operation names (`commandOf`), and the execution boundary of a call: it validates the context, can wrap the use case in a transaction and handles its events. See [Commands](commands.md).

**context (`ctx`).** Two things. In a blueprint, `ctx` is the argument of the builder function, giving the properties (`ctx.text`, `ctx.slug`) the plugins provide. In a use case or command, the context is what the caller gives next to the input (a user id, a request id), validated by its own blueprint. See [Blueprints](blueprints.md) and [Use cases](use-cases.md#context-and-metadata).

**deletion.** `"hard"` (the default) removes the row, `"soft"` stores `deletedAt` and keeps it. See [Repositories](repositories.md) and the [soft delete recipe](recipes/soft-delete.md).

**domain event.** A fact an entity queues (`created`, `updated`, `deleted`, or one of its own) with `eventOf` and `emit`. Nothing runs it by itself: a command, with a policy such as `publishEvents`, does after the call commits. See [Entities](entities.md) and [Commands](commands.md#event-policies).

**entity.** A record with an identity: `id`, `createdAt`, `updatedAt`, `deletedAt`, plus `destroy()` and domain events. Made with `entityOf`. See [Entities](entities.md).

**environment.** The validated environment variables of an app (`environmentOf`), read and checked on first use. A failure is `InvalidEnvironment`, or `InvalidApplicationEnvironment` at `app.start()`. See [Environments](environments.md).

**event policy.** A handler made by `eventPolicyOf` that a command runs on the events of a call. `publishEvents` is the one that ships. See [Commands](commands.md#event-policies).

**exception.** An error that knows its layer, name, source and trace (`exceptionOf`). Every error the library raises is one. See [Exceptions](exceptions.md).

**exception layer.** The part of afora that raised an exception: `Schema`, `Property`, `Blueprint`, `Record`, `Entity`, `UseCase`, `Repository`, `Environment`, `Event`, `Command`, `Output`, `Application`. See [Exceptions](exceptions.md).

**experimental.** The tier of `@afora/core/experimental`: it may change in any release. See [API tiers](api-tiers.md).

**identity keys.** The keys an entity adds to its blueprint: `id`, `createdAt`, `updatedAt`, `deletedAt` (and `expiresAt` or `version` when declared). They are read-only, and a blueprint cannot declare them. See [Entities](entities.md).

**issue.** One problem found by `safeParse` or `~standard.validate`: a `code`, a `path`, a `message` and a `source`. They are collected, never thrown. See [Standard Schema](standard-schema.md).

**lock (schema lock).** `afora.lock.json`, a committed snapshot of the shapes of your entities. `afora-codegen schema check` compares it with the code in CI, and `app.start({ lock })` refuses a mismatch. See [Schema evolution](schema-evolution.md).

**operation.** What an output serves: one use case under a command, with id `Command.name` (`Blog.create`). It is a frozen `OperationDescriptor`. See [Outputs](outputs.md).

**output.** Turns commands into operations and runs them through a pipe of stages (`outputOf`). `build()` gives what the sink makes: an HTTP app, an OpenAPI document, MCP tools. See [Outputs](outputs.md).

**plugin.** An extension of something afora builds. A blueprint plugin (`blueprintPluginOf`) adds properties to `ctx`; a record plugin (`recordPluginOf`, such as `Archivable` or `Ownable`) adds keys and behavior to records; a use case plugin (`ctx.create(Posts)`) makes a use case for a repository. See [Blueprints](blueprints.md), [Records](records.md) and [Use cases](use-cases.md#plugins).

**principal.** The caller of an operation: `{ subject, scopes, claims? }`. A sink makes it from the credentials of a request. See [Access](auth.md).

**property.** A class that validates and normalizes one value through `preHandle -> validation -> afterHandle` (`propertyOf`). The flags `optional`, `sensitive` and `unique` pass up to records. See [Properties](properties.md).

**provider.** Where a repository keeps its data: an object that implements `IRepositoryProvider` (`findOne`, `findMany`, `insert`, `update`, `remove`, `count`). `inMemoryProvider()` is the default; `@afora/drizzle` and `@afora/dynamodb` are others. Also, the HTTP packages (`@afora/hono`, `fastify`, `express`, `elysia`) are called providers of an output. See [Repositories](repositories.md) and [HTTP providers](providers.md).

**publisher.** An object with `publish(topic, event)`, registered by key in `applicationOf({ publishers })`, to which `publishEvents` sends events. See [Commands](commands.md#event-policies).

**record.** A class that implements a blueprint: it keeps a value of its shape, with `sensitive`, `unique` and `change` keys (`recordOf`). Keys are prototype getters, so spreading a record gives nothing: use `toJSON()`. See [Records](records.md).

**relation.** An entity held by another entity (a `Post` with an `author`). It is stored as an id and loaded back through the repositories listed in `relations`. See [Repositories](repositories.md).

**repository.** The async methods that read and write one entity through a provider (`repositoryOf`). See [Repositories](repositories.md).

**route.** The HTTP method and path a use case declares with `@Route` or `route`, which sinks and the OpenAPI document follow. See [Use cases](use-cases.md#routes).

**sensitive.** A key or property that `toJSON` masks as `"********"` at any depth. `Password` is always sensitive. See [Records](records.md).

**sink.** The last stage of an output, which builds something concrete from the operations (`hono(...)`, `openapi(...)`, `mcpTools`, or one you write with `sinkOf`). See [Outputs](outputs.md) and the [custom stage recipe](recipes/custom-sink-or-stage.md).

**spec.** The content of an `afora.json`. Also what `afora-codegen extract` prints for an application. See [afora.json](afora-json.md).

**stable.** The tier of `@afora/core` that the contract of [VERSIONING.md](../VERSIONING.md) covers, with adapters and testing. See [API tiers](api-tiers.md).

**stage.** One step of the pipe of an output: a transform (changes or drops operations) or a sink (builds the result). A stage is a name plus JSON options. See [Outputs](outputs.md).

**std.** The standard library part of afora: ready-made properties (`Id`, `Slug`, `Email`, `Password`...), `blueprintOf`, `entityOf`, the standard use cases and the record plugins. `core` holds the generic machinery and never imports from `std`. See [Properties](properties.md) and [Standard use cases](std-use-cases.md).

**step.** One element of the `steps` of a use case: plain data (`find`, `ensure`, `build`, `create`, `run`...) that the use case interprets instead of a hand-written `execute`. The same steps are valid in TypeScript and in JSON. See [Use cases](use-cases.md#steps).

**tier.** The group an export belongs to, which says where to import it from and whether semver covers it: stable, adapters, testing, experimental, internal. See [API tiers](api-tiers.md).

**trace.** The list of steps an exception went through, from its origin, which grows as it crosses layers. See [Exceptions](exceptions.md).

**unique.** A key a repository enforces as unique (`RepositoryUniqueViolation`), by `options.unique` or a `unique` property such as `Slug`. See [Records](records.md).

**use case.** An operation with an input blueprint, a response blueprint and dependencies (other use cases, repositories, environments) injected into `execute`. An instance runs once. See [Use cases](use-cases.md).

**variant.** A field that is one of several blueprints told apart by a key (`variantOf("type", { click: Click, view: View })`). See [Blueprints](blueprints.md#one-of-several-blueprints).
