import type { Static, TSchema } from "typebox";
import type { ParseResult } from "../../parse/types/parse.interface";
import { State } from "../../symbols/state";
import type { PropertyStates } from "../enums/property-states";
import type { IPropertyType } from "./property-type.interface";

/** How a property handles its value; `Value` is the value of its schema, as in `ISchema`. */
export interface IDefineProperty<
	SchemaType extends TSchema,
	Value = Static<SchemaType>,
> {
	[State]: PropertyStates;
	get type(): IPropertyType<SchemaType, Value>;
	make(value: Value): Value;
	/** Like `make`, but returns the issues of a rejected value instead of throwing. */
	parse(value: unknown): ParseResult<Value>;
}
