### Changed

- **Breaking.** The exports of `@afora/core` are split into tiers (#42); see `docs/api-tiers.md` for the tier of each one, with the reason. Application code keeps importing from `@afora/core`: everything the README and the docs show for declaring, running and serving a domain stays there (468 of 557 exports). See Migration below.
- **Breaking.** New stable subpath `@afora/core/adapters`, for authors of sinks, providers and code generators. These moved there from `@afora/core` (49): `coerceTextValues`, `outputValueOf`, `problemOf`, `PROBLEM_MEDIA_TYPE`, `statusOf`, `sinkOf`, `stageCatalogOf`, `stageKindOf`, `operationRoutes`, `routeOptionsIssue`, `requestIdHeaderOf`, `ROUTE_OPTION_KEYS`, `ENTITY_IDENTITY_KEYS`, `RESERVED_ENTITY_KEYS`, `RESERVED_RECORD_KEYS`, the symbols `Kind` and `Demo`; the provider types `IRepositoryProvider`, `RepositoryContext`, `RepositoryData`, `ProviderQuery`, `ProviderCapabilities`, `ProviderIncrementOptions`, `ProviderKeyset`, `ProviderUpdateOptions`; the sink types `OperationDescriptor`, `OperationRoute`, `Problem`, `ProblemOptions`, `SinkFactory`, `SinkSettings`, `SinkStage`; and the `app.describe()` types `ApplicationDescription`, `CommandDescription`, `ExceptionDescription`, `FieldDescription`, `FieldsDescription`, `LogDescription`, `OutputDescription`, `PropertyDescription`, `PropertyLineageDescription`, `PropertyReference`, `ProviderReference`, `RecordDescription`, `UseCaseDependencyDescription`, `UseCaseDescription`, `ProviderDescription`, `EventPolicyDescription`, `StageDescription`. Like the main entry and `@afora/core/testing`, it is part of the contract of `VERSIONING.md`.
- **Breaking.** Moved to `@afora/core/experimental`, outside the contract (9): `providerDescriptionOf`, `eventPolicyCatalogOf`, `eventPolicyDescriptionOf`, `stageDescriptionOf`, `propertyLineageOf`, `useCaseOriginOf`, `useCaseTargetOf` and the types `PropertyLineage` and `UseCaseOriginInfo`. `app.describe()` gives the same descriptions.
- **Breaking.** No longer exported (31): the base classes `AbstractProperty`, `AbstractDefineProperty`, `AbstractRecord`, `AbstractEntity`, `AbstractRepository` and `AbstractUseCase` (extend what `propertyOf`, `recordOf`, `entityOf`, `repositoryOf` and `useCaseOf` return); the guards `isApplication`, `isProviderSlot`, `isProviderStorage`, `isLogFactory`, `isBlueprint`, `isBlueprintList`, `isOptionalRecord`, `isRecordClass`, `isEnvironment`, `isProperty`, `isRecordPlugin`, `isRepository` and `isPasswordHash`; `recordFieldOf`, `schemaOf` and its type `SchemaClass`; `PropertyStates` and `UNEXPECTED_ERROR`; `PASSWORD_MIN_LENGTH`, `PASSWORD_MAX_LENGTH`, `PASSWORD_SPECIAL_CHARACTERS` and `passwordIssues`; and the `@internal` types `UseCaseContextOf`, `UseCasePluginContext` and `UseCasePluginsByName`.
- `@afora/hono`, `@afora/mcp`, `@afora/ws`, `@afora/drizzle` and `@afora/codegen` import their plumbing from `@afora/core/adapters` (and their tests `stageDescriptionOf` from `@afora/core/experimental`), so they need a `@afora/core` with that subpath. Code generated from an `afora.json` imports only from `@afora/core`, unchanged; the names it reserves for declarations (`afora_catalog` `reservedDeclarationNames`) are those of `@afora/core` only, so the names that moved can now be declared.
- `VERSIONING.md` lists `@afora/core/adapters` and `@afora/core/testing` as contract and `@afora/core/experimental` as not, uses the `**Breaking.**` marker of this file, and has the CHANGELOG template: from now on every breaking change has a Migration block, before and after. `docs/README.md` explains the tiers.

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
