import type { TOptional, TSchema } from "typebox";
import type { ParseResult } from "../../parse/types/parse.interface";
import type { StandardSchemaV1 } from "../../standard/standard-schema";
import type { AbstractProperty } from "../abstract-property";
import type { AnyPropertyConstructor } from "./property-collection.type";
import type { PropertyValue } from "./property-constructor.type";
import type { CallableKey, StoredField } from "./property-options.interface";
import type {
	IPropertyType,
	SensitiveTypeOf,
	UniqueTypeOf,
} from "./property-type.interface";

/**
 * `Property` accepting `undefined`: its schema becomes `TOptional`, while its
 * own methods and statics (e.g. `Password#verify`, `Id.generate`) are kept.
 */
export type OptionalProperty<Property extends AnyPropertyConstructor> =
	Property extends {
		readonly type: IPropertyType<infer SchemaType, infer Value>;
	}
		? SchemaType extends TOptional<TSchema>
			? StoredField<Property>
			: Omit<
					Property,
					"type" | "prototype" | "safeParse" | "~standard" | CallableKey
				> & {
					new (
						value: PropertyValue<TOptional<SchemaType>, Value>,
					): AbstractProperty<TOptional<SchemaType>, Value> &
						Omit<InstanceType<Property>, keyof AbstractProperty<TSchema>>;
					readonly type: IPropertyType<TOptional<SchemaType>, Value> &
						UniqueTypeOf<Property> &
						SensitiveTypeOf<Property>;
					safeParse(
						value: unknown,
					): ParseResult<PropertyValue<TOptional<SchemaType>, Value>>;
					readonly "~standard": StandardSchemaV1.Props<
						PropertyValue<TOptional<SchemaType>, Value>,
						PropertyValue<TOptional<SchemaType>, Value>
					>;
				}
		: never;
