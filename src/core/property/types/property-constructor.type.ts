import type { Static, TOptional, TSchema } from "typebox";

/**
 * The value a property holds: the value of its schema, or `undefined` too
 * when it is optional. `Value` is the value of the schema, as in `ISchema`.
 */
export type PropertyValue<
	SchemaType extends TSchema,
	Value = Static<SchemaType>,
> = SchemaType extends TOptional<TSchema> ? Value | undefined : Value;
