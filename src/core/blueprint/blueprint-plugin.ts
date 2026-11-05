import type { IBlueprintCollection } from "./types/blueprint.interface";
import type {
	BlueprintFactory,
	IBlueprintFactories,
	IBlueprintPlugin,
} from "./types/blueprint-plugin.interface";

/** A plugin of `properties`, e.g. `blueprintPluginOf("content", { title: Title })`. */
export function blueprintPluginOf<Properties extends IBlueprintCollection>(
	name: string,
	properties: Properties,
): IBlueprintPlugin<Properties, Record<never, never>> & {
	readonly factories: Record<never, never>;
};
/**
 * A plugin of `properties` and of `factories`, functions that make fields
 * from their arguments, e.g. `blueprintPluginOf("std", { id: Id }, { enumOf })`.
 */
export function blueprintPluginOf<
	Properties extends IBlueprintCollection,
	// Keyed by `keyof Factories`, not `string`, and `factories` required in
	// this overload: otherwise TypeScript fixes the type parameters of a
	// generic factory, as `enumOf`'s, to their constraints.
	Factories extends Record<keyof Factories, BlueprintFactory>,
>(
	name: string,
	properties: Properties,
	factories: Factories,
): IBlueprintPlugin<Properties, Factories> & { readonly factories: Factories };
export function blueprintPluginOf(
	name: string,
	properties: IBlueprintCollection,
	factories: IBlueprintFactories = {},
): IBlueprintPlugin {
	return Object.freeze({
		name,
		properties: Object.freeze({ ...properties }),
		factories: Object.freeze({ ...factories }),
	});
}
