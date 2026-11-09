import type { Static, TSchema } from "typebox";
import type { AbstractDefineProperty } from "../define-property";
import type { PropertyValue } from "./property-constructor.type";

/** A property instance; `Value` is the value of its schema, as in `ISchema`. */
export interface IProperty<
	SchemaType extends TSchema,
	Value = Static<SchemaType>,
> {
	readonly definition: AbstractDefineProperty<SchemaType, Value>;
	readonly value: PropertyValue<SchemaType, Value>;
}
