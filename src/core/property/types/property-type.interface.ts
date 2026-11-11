import type { Static, TSchema } from "typebox";
import type { ISchema } from "../../schema/types/schema.interface";
import { Demo } from "../../symbols/demo";

/**
 * What a property declares about itself. `Value` is the value of its schema,
 * computed where `SchemaType` is known, as in `ISchema`.
 */
export interface IPropertyType<
	SchemaType extends TSchema,
	Value = Static<SchemaType>,
> {
	/** Value used by `demo()`; it is the property's `default`, when there is one. */
	readonly [Demo]: Value | undefined;
	readonly name: string;
	readonly schema: ISchema<SchemaType, Value>;
	readonly optional?: boolean;
	/** Whether a record masks its value in `toJSON`, at any depth. */
	readonly sensitive?: boolean;
	/** Whether a record lists a key holding it in `options.unique`, for repositories to enforce. */
	readonly unique?: boolean;
	/** `fill` of `.with()`: the value given to the key when a stored row lacks it. */
	readonly fill?: Value;
	/** `renamedFrom` of `.with()`: the key that held the value in older rows. */
	readonly renamedFrom?: string;
}

/**
 * The type of a property declared `unique`, as `Slug`, so that the keys
 * holding it are told apart from the others by their type.
 */
export type UniqueMark<Unique extends boolean> = Unique extends true
	? { readonly type: { readonly unique: true } }
	: unknown;

/**
 * The type of a property declared `sensitive`, as `Password`, so that the
 * type of `toJSON` masks the keys holding it.
 */
export type SensitiveMark<Sensitive extends boolean> = Sensitive extends true
	? { readonly type: { readonly sensitive: true } }
	: unknown;

/** `{ sensitive: true }` when `Property` is declared `sensitive`, for its optional version. */
export type SensitiveTypeOf<Property> = Property extends {
	readonly type: { readonly sensitive: true };
}
	? { readonly sensitive: true }
	: unknown;

/** `{ unique: true }` when `Property` is declared `unique`, for its optional version. */
export type UniqueTypeOf<Property> = Property extends {
	readonly type: { readonly unique: true };
}
	? { readonly unique: true }
	: unknown;
