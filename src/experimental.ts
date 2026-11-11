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
