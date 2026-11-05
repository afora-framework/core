import { isProperty } from "../property/is-property";
import { refinePropertyOf } from "../property/refine";
import type { AnyPropertyConstructor } from "../property/types/property-collection.type";
import type {
	PropertyOptions,
	StoredField,
} from "../property/types/property-options.interface";
import type { BlueprintField } from "./types/blueprint.interface";

/** The property each callable stands for. */
const targets = new WeakMap<object, AnyPropertyConstructor>();

/**
 * `Property`, which can also be called, as `ctx.number({ min: 1 })`, for the
 * subclass `refinePropertyOf` makes. Used as it is, it is the class itself:
 * `new`, `extends`, `instanceof` and its statics go to `Property`.
 */
export function callableOf(
	Property: AnyPropertyConstructor,
): AnyPropertyConstructor {
	const callable = new Proxy(Property, {
		apply: (target, _this, [options]: [PropertyOptions<never>?]) =>
			refinePropertyOf(target, options ?? {}),
	});
	targets.set(callable, Property);
	return callable;
}

/** `field`, or the property it stands for when it is a callable, to store it. */
export function fieldOf<Field extends BlueprintField>(
	field: Field,
): StoredField<Field> {
	return ((isProperty(field) ? targets.get(field) : undefined) ??
		field) as StoredField<Field>;
}
