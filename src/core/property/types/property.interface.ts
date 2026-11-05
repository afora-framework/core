import type { TSchema } from "typebox";
import type { AbstractDefineProperty } from "../define-property";
import type { PropertyValue } from "./property-constructor.type";

export interface IProperty<SchemaType extends TSchema> {
	readonly definition: AbstractDefineProperty<SchemaType>;
	readonly value: PropertyValue<SchemaType>;
}
