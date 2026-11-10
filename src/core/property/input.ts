import { fieldOf } from "../blueprint/callable";
import type { BlueprintField } from "../blueprint/types/blueprint.interface";
import { isProperty } from "./is-property";
import type { AnyPropertyConstructor } from "./types/property-collection.type";

/**
 * The static of a property class whose callers give another form of its
 * value than the one it stores: a password is given plain and stored as a
 * hash. Classes extending or refining the property keep it.
 */
export const PropertyInput: unique symbol = Symbol("propertyInput");

/** What a property class holds under `PropertyInput`. */
export interface IPropertyInput<Value = unknown> {
	/** The property that validates what a caller gives, of the same value type. */
	readonly accepts: AnyPropertyConstructor;
	/** Turns what a caller gave into the value the property stores. */
	convert(value: Value): Value | Promise<Value>;
}

/**
 * What `field` declares under `PropertyInput`; `undefined` for a property
 * that takes its value as it stores it, and for a field that is not a
 * property.
 */
export function propertyInputOf(field: unknown): IPropertyInput | undefined {
	const property = fieldOf(field as BlueprintField);
	if (!isProperty(property)) return undefined;
	const declared = (
		property as unknown as { readonly [PropertyInput]?: IPropertyInput }
	)[PropertyInput];
	return typeof declared === "object" &&
		declared !== null &&
		isProperty(declared.accepts) &&
		typeof declared.convert === "function"
		? declared
		: undefined;
}
