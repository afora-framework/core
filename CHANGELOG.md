# Changelog

## Unreleased

### Changed

- Breaking: TypeBox is now a required peer dependency (`typebox: ^1`) instead of a runtime dependency. Install it alongside `@afora/core`; companion packages and generated applications share the application's TypeBox installation.
- Breaking: record and entity instance metadata moved from `.blueprint` and `.options` to `[Meta].blueprint` and `[Meta].options`. Class statics keep their names. `blueprint` and `options` are now legal domain fields, including plugin fields, and metadata no longer appears in spread or `Object.keys`. Reserved record and entity names are covered by fixed contract tests.
- Breaking: `CallableProperties`, `StoredField`, `StoredFields`, `BlueprintPropertySchema`, `JoinedProperties`, `ListProperties`, `OptionalProperties`, `PluginMembers`, `WithPluginProperties`, `RecordPluginsByName`, `RecordPluginContext`, `BlueprintFactoryContext`, `MergedCollections`, `ApplicationCollectionKey`, `MergedEnvironment` and `RepositoryMethods` were removed from the exports (internal helpers, now marked `@internal`). They still appear inside the declarations of the exported types.
- Breaking: `sliceOf`, `sliceValue` and the `SliceMask`, `ValueMask`, `SlicedBlueprint` and `SlicedValue` types moved to the new subpath `@afora/core/experimental`, which is not covered by the compatibility policy.
- Breaking: the playground and the `afora` CLI moved to the new package `@afora/playground` (`packages/playground`). `@afora/core` no longer ships `dist/playground` (about 10 MB) or a `bin`, so `afora playground` from `@afora/core` is gone: install `@afora/playground` as a dev dependency instead. `bun run playground` and `bun run test:playground` in this repository keep working.
- Breaking: the `change<Key>` methods are now a `change` namespace, `user.change.name(value)` instead of `user.changeName(value)`, with the same validation, `updatedAt` and effects. `change.<key>` is bound to its record, so `const { change } = user` works, and it returns the record. `change` only exists when `options.change` (or a plugin) lists keys, and then a blueprint key named `change` throws `ReservedRecordKey` (a plugin member named `change` throws `RecordPluginConflict`). The standard `authenticatable` plugin now has `change.password(hash)`.
- `recordOf` is now the `std` one, `recordBuilderOf(StdRecordPlugins)`, so that `options.plugins` can pick standard plugins; its classes have a static `plugins`. `change` keys are resolved in the order of the blueprint, as `sensitive` and `unique` are.

- Editor and type-check performance: an edit in a file using afora costs about 30–55k type instantiations (~0.1 s) instead of ~1.33M (~1.2 s), in source and package mode. TypeScript no longer has to measure TypeBox's `Static` on a generic schema (about a second on every check): the property layer carries the value of its schema as a type parameter, computed where the schema is known, and blueprint values (`BlueprintValue`, `BlueprintInput`, `BlueprintData`, list values) are built from the values of their fields, with the same keys, modifiers and order as before. Value types and error messages are unchanged. `PropertyClass`, `IPropertyType`, `ISchema`, `ISchemaType`, `PropertyOptions`, `PropertyValue`, `AbstractProperty`, `DeclaredProperty`, `AbstractDefineProperty`, `IDefineProperty`, `IProperty` and `AbstractPropertyConstructor` gain a second type parameter, `Value`, defaulting to `Static<SchemaType>`, so existing spellings keep working; hovers now show it, e.g. `PropertyClass<TString, string>`. `propertyOf` infers the schema from `schema` alone (`default`, `preHandle` and `afterHandle` are `NoInfer`), as it effectively did.
- Playground IntelliSense: dependency files are parsed once per project reload instead of on every keystroke, and language requests carry the editor version, so a request for an outdated buffer is dropped (and completions, hovers and signatures run before pending diagnostics) instead of delaying the current one. With the type changes above, a completion after an edit takes ~0.1 s instead of ~1.7 s.
- `repositoryOf`: `findManyBy<Key>` is only an action for keys that are not unique; a unique key (`id`, `options.unique`, a `unique` property) has `findBy<Key>` instead. `findManyBy<UniqueKey>` is rejected by type and throws `InvalidRepositoryDeclaration` at declaration, pointing to `findBy<Key>`.

### Added

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
- Playground experiments are saved as `.afora/sandbox/**/*.sandbox.ts` in the selected project, with nested folders, renaming, deletion, disk reload and migration of browser-local experiments.

- Local TypeScript playground and `afora playground` CLI (now `@afora/playground`) with project-aware completion, hover types, diagnostics, Bun execution, examples and browser-local saved experiments. Reads the consuming project's manifest, TypeScript configuration and installed dependencies; source mode supports developing afora itself.
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
