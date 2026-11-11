/**
 * `@afora/core/experimental`: features that may change in any release. Not
 * covered by the compatibility policy in `VERSIONING.md`. See
 * `docs/api-tiers.md`.
 */

// JSON Web Tokens for the `auth` option of the HTTP sinks and the tokens of
// the standard `login`; the shape of the session may still change.
export { InvalidJwtOptions, jwtOf } from "./core/auth/jwt";
export type {
	DescribedJwtOptions,
	Jwt,
	JwtAlgorithm,
	JwtOptions,
	JwtSubject,
	JwtTokenOptions,
} from "./core/auth/types/jwt.interface";
export { sliceOf, sliceValue } from "./core/blueprint/slice";
export type {
	SlicedBlueprint,
	SlicedValue,
	SliceMask,
	ValueMask,
} from "./core/blueprint/types/slice.interface";
export {
	eventPolicyCatalogOf,
	eventPolicyDescriptionOf,
} from "./core/event-policy/event-policy";
export { stageDescriptionOf } from "./core/output/stage";
export {
	type PropertyLineage,
	propertyLineageOf,
} from "./core/property/lineage";
export { providerDescriptionOf } from "./core/repository/provider";
// For providers that filter, order and page rows themselves (document stores):
// the same rules as `inMemoryProvider`.
export {
	matchesQuery,
	prepareQuery,
	sameValue,
	selectRows,
} from "./core/repository/query";
export { useCaseOriginOf } from "./core/use-case/plugin";
export { useCaseTargetOf } from "./core/use-case/target";
export type { UseCaseOriginInfo } from "./core/use-case/types/plugin.interface";
export type { StdTokenOptions } from "./std/use-cases/types";

// Moved out of stable before the 27.0 freeze (#59): unused by the examples,
// the packages and the docs, and covered by a stable export. See the section
// "Moved before 27.0" of `docs/api-tiers.md` for what would promote each one.

// What `entityOf` keeps under `EntitySettings`, with bookkeeping that may
// still change; `app.describe()` is the stable read of `versioned` and `expires`.
export type { EntityStorageSettings } from "./core/entity/types/entity.interface";
// The frozen list of levels; the docs spell them out and `LogLevel` is stable.
export { LogLevels } from "./core/logger/logger";
// Property type plumbing: the first names the internal base class, the second
// is `Record<string, AnyPropertyConstructor>`.
export type { AbstractPropertyConstructor } from "./core/property/types/abstract-property-constructor.type";
export type { IPropertyCollection } from "./core/property/types/property-collection.type";
// The interface holding each generated repository method: name the repository
// with `RepositoryOf<typeof Entity, [...]>` instead. The values these methods
// take and give (`RepositoryPage`, `RepositoryCursorQuery`...) stay stable.
export type {
	RepositoryExists,
	RepositoryExplain,
	RepositoryFindCursor,
	RepositoryFindMany,
	RepositoryFindPage,
	RepositoryForEachPage,
} from "./core/repository/types/query.interface";
export type {
	RepositoryCount,
	RepositoryCreate,
	RepositoryDelete,
	RepositoryIncrement,
	RepositoryRestore,
	RepositoryUpdate,
} from "./core/repository/types/repository.interface";
// The Std record plugins, reached through `StdRecordPlugins`:
// `(ctx) => [ctx.publishable]` in `plugins`, and
// `StdRecordPlugins.plugins.publishable` for `hasPlugin`.
export {
	Archivable,
	Ownable,
	Publishable,
	Taggable,
} from "./std/record-plugins";
