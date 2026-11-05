import type { Static, TSchema } from "typebox";
import type { ParseResult } from "../parse/types/parse.interface";
import { standardOfClass } from "../standard/standard";
import type { StandardSchemaV1 } from "../standard/standard-schema";
import { Demo } from "../symbols/demo";
import { State } from "../symbols/state";
import type { AbstractDefineProperty } from "./define-property";
import type { PropertyStates } from "./enums/property-states";
import { refinePropertyOf } from "./refine";
import type { IProperty } from "./types/property.interface";
import type { AnyPropertyConstructor } from "./types/property-collection.type";
import type { PropertyValue } from "./types/property-constructor.type";
import type { PropertyOptions } from "./types/property-options.interface";
import type { IPropertyType } from "./types/property-type.interface";

/** The definition each class parses with, made on its first `safeParse`. */
const parsingDefinitions = new WeakMap<
	object,
	AbstractDefineProperty<TSchema>
>();

/**
 * The definition `Class` parses with. It does not depend on any member the
 * constructor sets, and `parse` leaves nothing on it that the next one reads,
 * so every `safeParse` shares one.
 */
function parsingDefinitionOf(Class: {
	prototype: object;
}): AbstractDefineProperty<TSchema> {
	let definition = parsingDefinitions.get(Class);
	if (!definition) {
		definition = (
			Object.create(Class.prototype) as {
				createDefinition(): AbstractDefineProperty<TSchema>;
			}
		).createDefinition();
		parsingDefinitions.set(Class, definition);
	}
	return definition;
}

export abstract class AbstractProperty<SchemaType extends TSchema>
	implements IProperty<SchemaType>
{
	get [State](): PropertyStates {
		return this.definition[State];
	}
	readonly definition: AbstractDefineProperty<SchemaType>;
	readonly value: PropertyValue<SchemaType>;

	constructor(value: PropertyValue<SchemaType>) {
		this.definition = this.createDefinition();
		this.value = this.definition.make(
			value === Demo
				? (this.definition.type[Demo] as Static<SchemaType>)
				: (value as Static<SchemaType>),
		) as PropertyValue<SchemaType>;
	}

	/**
	 * Builds an instance from the property's `default` value. Throws if the
	 * property is required and has no `default`.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: any property, whatever its schema
	static demo<Self extends AbstractProperty<any>>(
		this: new (
			value: never,
		) => Self,
	): Self {
		return new this(Demo as never);
	}

	/**
	 * The value the property would hold for `value`, handled as its
	 * constructor does, or every issue that rejects it; never throws.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: any property, whatever its schema
	static safeParse<Self extends new (value: never) => AbstractProperty<any>>(
		this: Self,
		value: unknown,
	): ParseResult<InstanceType<Self>["value"]> {
		// biome-ignore lint/complexity/noThisInStatic: the class it is called on, a subclass included
		return parsingDefinitionOf(this).parse(value) as ParseResult<
			InstanceType<Self>["value"]
		>;
	}

	/**
	 * A subclass of the class it is called on, narrowed and documented by
	 * `options`, e.g. `Integer.with({ min: 1, description: "Age in years" })`:
	 * `title`, `description`, `examples`, `deprecated`, `readOnly` and
	 * `writeOnly` go to its JSON Schema (for OpenAPI), and `min`, `max`,
	 * `pattern`... are checked along with its own constraints, which they can
	 * only narrow. Its demo value is `default`, or the first of `examples`.
	 */
	static with<Self extends AnyPropertyConstructor>(
		this: Self,
		options: PropertyOptions<
			Self["type"] extends IPropertyType<infer SchemaType> ? SchemaType : never
		>,
	): Self {
		// biome-ignore lint/complexity/noThisInStatic: the class it is called on, a subclass included
		return refinePropertyOf(this, options);
	}

	/**
	 * The Standard Schema of the class it is read from, a subclass included:
	 * `validate` gives the handled value, or the issues that reject it.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: typed by the declaration of each class
	static get "~standard"(): StandardSchemaV1.Props<any, any> {
		// biome-ignore lint/complexity/noThisInStatic: the class it is read from, a subclass included
		return standardOfClass(this);
	}

	protected abstract createDefinition(): AbstractDefineProperty<SchemaType>;
}
