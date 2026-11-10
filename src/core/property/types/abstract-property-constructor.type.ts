import type { Static, TSchema } from "typebox";
import type { ParseResult } from "../../parse/types/parse.interface";
import type { StandardSchemaV1 } from "../../standard/standard-schema";
import type { AbstractProperty } from "../abstract-property";
import type { PropertyValue } from "./property-constructor.type";
import type { IPropertyType } from "./property-type.interface";

/** A property class; `Value` is the value of its schema, as in `ISchema`. */
export type AbstractPropertyConstructor<
	SchemaType extends TSchema,
	Value = Static<SchemaType>,
> = {
	new (
		value: PropertyValue<SchemaType, Value>,
	): AbstractProperty<SchemaType, Value>;
	readonly type: IPropertyType<SchemaType, Value>;
	demo(): AbstractProperty<SchemaType, Value>;
	safeParse(value: unknown): ParseResult<PropertyValue<SchemaType, Value>>;
	readonly "~standard": StandardSchemaV1.Props<
		PropertyValue<SchemaType, Value>,
		PropertyValue<SchemaType, Value>
	>;
};
