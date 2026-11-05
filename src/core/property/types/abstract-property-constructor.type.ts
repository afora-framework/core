import type { TSchema } from "typebox";
import type { ParseResult } from "../../parse/types/parse.interface";
import type { StandardSchemaV1 } from "../../standard/standard-schema";
import type { AbstractProperty } from "../abstract-property";
import type { PropertyValue } from "./property-constructor.type";
import type { IPropertyType } from "./property-type.interface";

export type AbstractPropertyConstructor<SchemaType extends TSchema> = {
	new (value: PropertyValue<SchemaType>): AbstractProperty<SchemaType>;
	readonly type: IPropertyType<SchemaType>;
	demo(): AbstractProperty<SchemaType>;
	safeParse(value: unknown): ParseResult<PropertyValue<SchemaType>>;
	readonly "~standard": StandardSchemaV1.Props<
		PropertyValue<SchemaType>,
		PropertyValue<SchemaType>
	>;
};
