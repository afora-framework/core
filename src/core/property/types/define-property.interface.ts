import type { Static, TSchema } from "typebox";
import type { ParseResult } from "../../parse/types/parse.interface";
import { State } from "../../symbols/state";
import type { PropertyStates } from "../enums/property-states";
import type { IPropertyType } from "./property-type.interface";

export interface IDefineProperty<SchemaType extends TSchema> {
	[State]: PropertyStates;
	get type(): IPropertyType<SchemaType>;
	make(value: Static<SchemaType>): Static<SchemaType>;
	/** Like `make`, but returns the issues of a rejected value instead of throwing. */
	parse(value: unknown): ParseResult<Static<SchemaType>>;
}
