import type { Static, TInteger, TNumber, TSchema, TString } from "typebox";
import type { IPropertyType } from "./property-type.interface";

/**
 * What any property can say about itself, written to its JSON Schema for
 * documentation (e.g. OpenAPI); none of it changes validation.
 */
export interface PropertyMetadata<Value> {
	readonly title?: string;
	readonly description?: string;
	/** Values documented as examples; the first one is the demo value unless `default` is given. */
	readonly examples?: readonly Value[];
	readonly deprecated?: boolean;
	readonly readOnly?: boolean;
	readonly writeOnly?: boolean;
	/** The demo value, as `default` in `propertyOf`; it is not written to the schema. */
	readonly default?: Value;
}

/**
 * Bounds of a number. They only narrow the property: a bound looser than one
 * it already has is ignored.
 */
export interface NumberConstraints {
	/** `minimum`. */
	readonly min?: number;
	/** `maximum`. */
	readonly max?: number;
	/** `exclusiveMinimum`. */
	readonly exclusiveMin?: number;
	/** `exclusiveMaximum`. */
	readonly exclusiveMax?: number;
	readonly multipleOf?: number;
}

/**
 * Constraints of a string. They only narrow the property: a length looser than
 * the one it has is ignored, and a `pattern` is checked along with its own.
 */
export interface StringConstraints {
	/** `minLength`. */
	readonly min?: number;
	/** `maxLength`. */
	readonly max?: number;
	/** A regular expression the value must match; a `RegExp` gives its `source`, its flags are not kept. */
	readonly pattern?: string | RegExp;
}

/**
 * What `Property.with` and `ctx.<property>(options)` take: the metadata of any
 * property, plus the constraints of its kind of schema, for strings and numbers.
 */
export type PropertyOptions<
	SchemaType extends TSchema,
	Value = Static<SchemaType>,
> = PropertyMetadata<NonNullable<Value>> &
	(SchemaType extends TString
		? StringConstraints
		: SchemaType extends TNumber | TInteger
			? NumberConstraints
			: unknown);

/**
 * Brands a `CallableProperty` with the property it stands for.
 *
 * @public Exported so declarations can name the brand.
 */
export declare const Callable: unique symbol;

/**
 * `Property` in a blueprint context: the class itself, which can also be
 * called, as `ctx.number({ min: 1 })`, for the subclass `Property.with` makes.
 */
export type CallableProperty<
	Property extends { readonly type: IPropertyType<TSchema> },
> = Property & {
	(options?: OptionsOfProperty<Property>): Property;
	readonly [Callable]: Property;
};

/**
 * The `PropertyOptions` of a property class, from its schema and the value
 * its type carries, so `Static` is not measured again.
 */
type OptionsOfProperty<Property> = Property extends {
	readonly type: IPropertyType<infer SchemaType, infer Value>;
}
	? PropertyOptions<SchemaType, Value>
	: PropertyOptions<TSchema>;

/** `Field`, or the property it stands for when it is a `CallableProperty`, as a blueprint stores it. */
export type StoredField<Field> = Field extends {
	readonly [Callable]: infer Property;
}
	? Property
	: Field;

/** `StoredField` of every field of a collection. */
export type StoredFields<Fields> = {
	[Key in keyof Fields]: StoredField<Fields[Key]>;
};

/** The keys a `CallableProperty` adds, for types that copy a property's members. */
export type CallableKey = typeof Callable;
