import type { TOptional, TSchema } from "typebox";
import type { ParseResult } from "../../parse/types/parse.interface";
import type { StandardSchemaV1 } from "../../standard/standard-schema";
import type { AbstractProperty } from "../abstract-property";
import type { AnyPropertyConstructor } from "./property-collection.type";
import type { PropertyValue } from "./property-constructor.type";
import type { CallableKey, StoredField } from "./property-options.interface";
import type { IPropertyType, UniqueTypeOf } from "./property-type.interface";

/**
 * `Property` accepting `undefined`: its schema becomes `TOptional`, while its
 * own methods and statics (e.g. `Password#verify`, `Id.generate`) are kept.
 */
export type OptionalProperty<Property extends AnyPropertyConstructor> =
	Property extends { readonly type: IPropertyType<infer SchemaType> }
		? SchemaType extends TOptional<TSchema>
			? StoredField<Property>
			: Omit<
					Property,
					"type" | "prototype" | "safeParse" | "~standard" | CallableKey
				> & {
					new (
						value: PropertyValue<TOptional<SchemaType>>,
					): AbstractProperty<TOptional<SchemaType>> &
						Omit<InstanceType<Property>, keyof AbstractProperty<TSchema>>;
					readonly type: IPropertyType<TOptional<SchemaType>> &
						UniqueTypeOf<Property>;
					safeParse(
						value: unknown,
					): ParseResult<PropertyValue<TOptional<SchemaType>>>;
					readonly "~standard": StandardSchemaV1.Props<
						PropertyValue<TOptional<SchemaType>>,
						PropertyValue<TOptional<SchemaType>>
					>;
				}
		: never;
