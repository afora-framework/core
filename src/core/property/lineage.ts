import type { AnyPropertyConstructor } from "./types/property-collection.type";

/** How a property class came from another one, or from a factory. */
export type PropertyLineage =
	| {
			/** Made by `Base.with(options)`. */
			readonly kind: "refined";
			readonly base: AnyPropertyConstructor;
			readonly options: Readonly<Record<string, unknown>>;
	  }
	| {
			/** Made by `optionalOf(Base)`. */
			readonly kind: "optional";
			readonly base: AnyPropertyConstructor;
	  }
	| {
			/** Made by a factory such as `enumOf`, with the arguments it got. */
			readonly kind: "factory";
			readonly factory: string;
			readonly args: Readonly<Record<string, unknown>>;
	  };

const lineages = new WeakMap<object, PropertyLineage>();

/** Records how `Property` was made; the first record wins. */
export function recordPropertyLineage(
	Property: object,
	lineage: PropertyLineage,
): void {
	if (!lineages.has(Property)) lineages.set(Property, lineage);
}

/**
 * How `Property` was made: `Base.with(options)`, `optionalOf(Base)` or a
 * factory (`enumOf`, which registers itself with `recordPropertyLineage`);
 * `undefined` for a root property, declared with `propertyOf`, which its
 * `type.name` identifies (`"email"` for `Email`).
 */
export function propertyLineageOf(
	Property: unknown,
): PropertyLineage | undefined {
	return typeof Property === "function" ? lineages.get(Property) : undefined;
}
