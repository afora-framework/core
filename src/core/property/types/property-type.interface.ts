import type { Static, TSchema } from "typebox";
import type { ISchema } from "../../schema/types/schema.interface";
import { Demo } from "../../symbols/demo";

export interface IPropertyType<SchemaType extends TSchema> {
	/** Value used by `demo()`; it is the property's `default`, when there is one. */
	readonly [Demo]: Static<SchemaType> | undefined;
	readonly name: string;
	readonly schema: ISchema<SchemaType>;
	readonly optional?: boolean;
	/** Whether a record masks its value in `toJSON`, at any depth. */
	readonly sensitive?: boolean;
	/** Whether a record lists a key holding it in `options.unique`, for repositories to enforce. */
	readonly unique?: boolean;
}

/**
 * The type of a property declared `unique`, as `Slug`, so that the keys
 * holding it are told apart from the others by their type.
 */
export type UniqueMark<Unique extends boolean> = Unique extends true
	? { readonly type: { readonly unique: true } }
	: unknown;

/** `{ unique: true }` when `Property` is declared `unique`, for its optional version. */
export type UniqueTypeOf<Property> = Property extends {
	readonly type: { readonly unique: true };
}
	? { readonly unique: true }
	: unknown;
