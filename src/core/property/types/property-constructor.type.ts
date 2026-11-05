import type { Static, TOptional, TSchema } from "typebox";

export type PropertyValue<SchemaType extends TSchema> =
	SchemaType extends TOptional<TSchema>
		? Static<SchemaType> | undefined
		: Static<SchemaType>;
