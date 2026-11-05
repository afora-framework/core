import type {
	BlueprintField,
	IBlueprintCollection,
} from "./blueprint.interface";

/**
 * A function that makes a field from its arguments, e.g. `enumOf`; a
 * blueprint's definition calls it from its context, as `ctx.enumOf([...])`.
 */
// biome-ignore lint/suspicious/noExplicitAny: any arguments a factory takes
export type BlueprintFactory = (...args: any[]) => BlueprintField;

/** Field factories by name, e.g. `{ enumOf }`. */
export type IBlueprintFactories = Record<string, BlueprintFactory>;

/** A named, reusable collection of fields that blueprints are built from. */
export interface IBlueprintPlugin<
	Properties extends IBlueprintCollection = IBlueprintCollection,
	Factories extends IBlueprintFactories = IBlueprintFactories,
> {
	readonly name: string;
	readonly properties: Properties;
	/** Field factories the plugin adds to the context; absent when it has none. */
	readonly factories?: Factories;
}
