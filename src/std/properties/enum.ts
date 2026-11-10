import { type TEnum, type TEnumValue, type TOptional, Type } from "typebox";
import { recordPropertyLineage } from "../../core/property/lineage";
import { type PropertyClass, propertyOf } from "../../core/property/property";

/** A class declared with `enumOf`. */
export type EnumClass<
	Values extends TEnumValue[],
	Optional extends boolean = false,
> = PropertyClass<
	Optional extends true ? TOptional<TEnum<Values>> : TEnum<Values>,
	Values[number]
>;

/**
 * A property holding one of `values`, e.g.
 * `enumOf(["draft", "published"])`. Its demo value is the first one unless
 * `default` says otherwise.
 */
export function enumOf<
	const Values extends TEnumValue[],
	Optional extends boolean = false,
>(
	values: readonly [...Values],
	{
		name = "enum",
		optional,
		default: _default = values[0],
	}: {
		name?: string;
		optional?: Optional;
		default?: Values[number];
	} = {},
): EnumClass<Values, Optional> {
	const Enum = propertyOf({
		name,
		schema: Type.Enum(values),
		optional,
		default: _default,
	});
	recordPropertyLineage(Enum, {
		kind: "factory",
		factory: "enumOf",
		args: Object.freeze({
			values: Object.freeze([...values]),
			...(name === "enum" ? {} : { name }),
			...(optional ? { optional: true } : {}),
			...(_default === values[0] ? {} : { default: _default }),
		}),
	});
	return Enum;
}
