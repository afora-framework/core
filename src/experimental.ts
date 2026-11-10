/**
 * `@afora/core/experimental`: features that may change in any release. Not
 * covered by the compatibility policy in `VERSIONING.md`. See
 * `docs/api-tiers.md`.
 */
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
export { useCaseOriginOf } from "./core/use-case/plugin";
export { useCaseTargetOf } from "./core/use-case/target";
export type { UseCaseOriginInfo } from "./core/use-case/types/plugin.interface";
