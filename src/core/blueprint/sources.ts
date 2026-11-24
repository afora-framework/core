/** The blueprints each blueprint was derived from, by `optionalOf`, `join` or `sliceOf`. */
const sources = new WeakMap<object, readonly object[]>();

/**
 * Notes that `derived` was made from `bases` (an optional copy, a join, a
 * slice), so that what is noted about a base (the keys its records declare
 * `sensitive`) follows it, for the keys `derived` still has.
 * @internal
 */
export function deriveBlueprint(
	derived: object,
	bases: readonly object[],
): void {
	sources.set(derived, [...(sources.get(derived) ?? []), ...bases]);
}

/**
 * The blueprints `blueprint` was derived from (none for one made by
 * `blueprintOf`).
 * @internal
 */
export function blueprintSourcesOf(blueprint: object): readonly object[] {
	return sources.get(blueprint) ?? [];
}
