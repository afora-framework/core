import { type Static, type TOptional, type TSchema, Type } from "typebox";
import type { ParseResult } from "../parse/types/parse.interface";
import { schemaOf } from "../schema/schema";
import type { StandardSchemaV1 } from "../standard/standard-schema";
import { Demo } from "../symbols/demo";
import { AbstractProperty } from "./abstract-property";
import { AbstractDefineProperty } from "./define-property";
import type { AbstractPropertyConstructor } from "./types/abstract-property-constructor.type";
import type { AnyPropertyConstructor } from "./types/property-collection.type";
import type { PropertyValue } from "./types/property-constructor.type";
import type { PropertyOptions } from "./types/property-options.interface";
import type {
	IPropertyType,
	UniqueMark,
} from "./types/property-type.interface";

type SchemaValueType<
	SchemaType extends TSchema,
	Optional extends boolean = false,
> = Optional extends true ? TOptional<SchemaType> : SchemaType;

/**
 * What `propertyOf` takes. `SchemaType` is inferred from `schema` alone: the
 * value is `NoInfer`, since inferring through `Static` makes TypeScript
 * measure `Static` itself, which costs about a second on every check.
 */
type PropertyOfArgs<
	SchemaType extends TSchema,
	Optional extends boolean = false,
	Unique extends boolean = false,
	Value = Static<SchemaType>,
> = {
	name: string;
	schema: SchemaType;
	default?: NoInfer<Value>;
	optional?: Optional;
	/** A record masks its value in `toJSON`, at any depth, as `Password`. */
	sensitive?: boolean;
	/**
	 * A record lists a key holding it in `options.unique`, as `Slug`; records
	 * do not check it, repositories (or the database) enforce it.
	 */
	unique?: Unique;
	preHandle?: (value: NoInfer<Value>) => NoInfer<Value>;
	afterHandle?: (value: NoInfer<Value>) => NoInfer<Value>;
};

/**
 * The instance type of a class declared with `propertyOf`; `Value` is the
 * value of its schema, as in `ISchema`.
 */
export declare class DeclaredProperty<
	SchemaType extends TSchema,
	Value = Static<SchemaType>,
> extends AbstractProperty<SchemaType, Value> {
	protected override createDefinition(): AbstractDefineProperty<
		SchemaType,
		Value
	>;
}

/**
 * A class declared with `propertyOf`; extend it to add behavior, as `Id` does.
 * `Value` is the value of its schema, as in `ISchema`.
 */
export interface PropertyClass<
	SchemaType extends TSchema,
	Value = Static<SchemaType>,
> {
	new (
		value: PropertyValue<SchemaType, Value>,
	): DeclaredProperty<SchemaType, Value>;
	readonly type: IPropertyType<SchemaType, Value>;
	/** The value handled by the property, or every issue that rejects `value`; never throws. */
	safeParse(value: unknown): ParseResult<PropertyValue<SchemaType, Value>>;
	/** The Standard Schema of the class: `validate` gives the handled value. */
	readonly "~standard": StandardSchemaV1.Props<
		PropertyValue<SchemaType, Value>,
		PropertyValue<SchemaType, Value>
	>;
	/**
	 * A subclass narrowed and documented by `options`, e.g.
	 * `Integer.with({ min: 1, description: "Age in years" })`.
	 */
	with<Self extends AnyPropertyConstructor>(
		this: Self,
		options: PropertyOptions<SchemaType, Value>,
	): Self;
	// biome-ignore lint/suspicious/noExplicitAny: any property, whatever its schema
	demo<Self extends AbstractProperty<any>>(
		this: new (
			value: never,
		) => Self,
	): Self;
}

export function propertyOf<
	SchemaType extends TSchema,
	Optional extends boolean = false,
	const Unique extends boolean = false,
>({
	name,
	schema,
	optional,
	sensitive = false,
	unique = false as Unique,
	default: _default,
	preHandle: onPreHandle,
	afterHandle: onAfterHandle,
}: PropertyOfArgs<SchemaType, Optional, Unique>): PropertyClass<
	SchemaValueType<SchemaType, Optional>,
	Static<SchemaType>
> &
	UniqueMark<Unique> {
	type ValueSchema = SchemaValueType<SchemaType, Optional>;

	const valueSchema = (
		optional ? Type.Optional(schema) : schema
	) as ValueSchema;
	const SchemaConstructor = schemaOf(name, valueSchema);

	const type: IPropertyType<ValueSchema> = {
		[Demo]: _default,
		name,
		schema: new SchemaConstructor(),
		optional: optional ?? false,
		sensitive,
		unique,
	};

	class DefineProperty extends AbstractDefineProperty<ValueSchema> {
		override get type(): IPropertyType<ValueSchema> {
			return type;
		}

		protected override preHandle(value: Static<ValueSchema>) {
			return onPreHandle ? onPreHandle(value) : value;
		}

		protected override afterHandle(value: Static<ValueSchema>) {
			return onAfterHandle ? onAfterHandle(value) : value;
		}
	}

	class Property extends AbstractProperty<ValueSchema> {
		static readonly type = type;

		protected override createDefinition(): AbstractDefineProperty<ValueSchema> {
			return new DefineProperty();
		}
	}

	// Names the class's type for declaration emit; at runtime it is `Property`.
	return Property satisfies AbstractPropertyConstructor<ValueSchema> as unknown as PropertyClass<
		ValueSchema,
		Static<SchemaType>
	> &
		UniqueMark<Unique>;
}
