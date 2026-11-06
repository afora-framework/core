/**
 * `@afora/core/experimental`: features that may change in any release. Not
 * covered by the compatibility policy in `VERSIONING.md`.
 */
export { sliceOf, sliceValue } from "./core/blueprint/slice";
export type {
	SlicedBlueprint,
	SlicedValue,
	SliceMask,
	ValueMask,
} from "./core/blueprint/types/slice.interface";
