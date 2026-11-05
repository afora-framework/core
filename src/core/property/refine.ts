import type { TSchema } from "typebox";
import { schemaOf } from "../schema/schema";
import { Demo } from "../symbols/demo";
import type { AbstractDefineProperty } from "./define-property";
import { recordPropertyLineage } from "./lineage";
import type { AnyPropertyConstructor } from "./types/property-collection.type";
import type { PropertyOptions } from "./types/property-options.interface";
import type { IPropertyType } from "./types/property-type.interface";

/** Options written to the schema as they are. */
const METADATA_KEYS = [
	"title",
	"description",
	"examples",
	"deprecated",
	"readOnly",
	"writeOnly",
] as const;

/** Lower bounds, kept at the highest of the two. */
const LOWER_BOUNDS = {
	min: ["minimum", "minLength"],
	exclusiveMin: ["exclusiveMinimum"],
} as const;

/** Upper bounds, kept at the lowest of the two. */
const UPPER_BOUNDS = {
	max: ["maximum", "maxLength"],
	exclusiveMax: ["exclusiveMaximum"],
} as const;

/**
 * A subclass of `Property` whose instances, `safeParse` and `~standard` use
 * `type`; its own methods and statics are kept, as is its name.
 */
export function derivePropertyOf(
	Property: AnyPropertyConstructor,
	type: IPropertyType<TSchema>,
): AnyPropertyConstructor {
	// biome-ignore lint/suspicious/noExplicitAny: extends whichever property it gets
	const Base = Property as new (value: any) => any;

	class Derived extends Base {
		static readonly type = type;

		protected createDefinition(): AbstractDefineProperty<TSchema> {
			const definition = super.createDefinition();
			// Configurable, so that a class derived from this one can set its own.
			Object.defineProperty(definition, "type", {
				value: type,
				configurable: true,
			});
			return definition;
		}
	}

	Object.defineProperty(Derived, "name", { value: Property.name });
	return Derived as unknown as AnyPropertyConstructor;
}

/** A copy of `schema`, its hidden TypeBox keys (`~kind`, `~optional`) included. */
function copyOf(schema: TSchema): Record<string, unknown> {
	return Object.defineProperties({}, Object.getOwnPropertyDescriptors(schema));
}

/** `schema` with `constraint` checked along with its own, under `allOf`. */
function addAllOf(
	schema: Record<string, unknown>,
	constraint: Record<string, unknown>,
): void {
	schema.allOf = [...((schema.allOf as unknown[]) ?? []), constraint];
}

/** The schema of `base` with `options` applied, as `Property.with` describes them. */
function refinedSchemaOf(
	base: TSchema,
	options: Record<string, unknown>,
): TSchema {
	const schema = copyOf(base);
	const keyword = (keys: readonly string[]) =>
		keys.length === 1 || schema.type !== "string" ? keys[0] : keys[1];

	for (const key of METADATA_KEYS) {
		if (options[key] !== undefined) schema[key] = options[key];
	}
	for (const [option, keys] of Object.entries(LOWER_BOUNDS)) {
		const value = options[option] as number | undefined;
		if (value === undefined) continue;
		const name = keyword(keys) as string;
		const current = schema[name] as number | undefined;
		schema[name] = current === undefined ? value : Math.max(current, value);
	}
	for (const [option, keys] of Object.entries(UPPER_BOUNDS)) {
		const value = options[option] as number | undefined;
		if (value === undefined) continue;
		const name = keyword(keys) as string;
		const current = schema[name] as number | undefined;
		schema[name] = current === undefined ? value : Math.min(current, value);
	}
	if (options.multipleOf !== undefined) {
		if (schema.multipleOf === undefined) schema.multipleOf = options.multipleOf;
		else addAllOf(schema, { multipleOf: options.multipleOf });
	}
	if (options.pattern !== undefined) {
		const pattern =
			options.pattern instanceof RegExp
				? options.pattern.source
				: (options.pattern as string);
		if (schema.pattern === undefined) schema.pattern = pattern;
		else addAllOf(schema, { pattern });
	}

	return schema as TSchema;
}

/**
 * A subclass of `Property` narrowed and documented by `options`: its metadata
 * (`description`, `examples`, ...) goes to the schema, and its constraints
 * (`min`, `max`, `pattern`, ...) are checked along with the property's own.
 * The demo value is `options.default`, or the first of `options.examples`.
 */
export function refinePropertyOf<Property extends AnyPropertyConstructor>(
	Property: Property,
	options: PropertyOptions<TSchema>,
): Property {
	const base = Property.type;
	const settings = options as Record<string, unknown>;
	const schema = refinedSchemaOf(base.schema.type.Type(), settings);
	const SchemaConstructor = schemaOf(base.name, schema);
	const examples = settings.examples as readonly unknown[] | undefined;

	const type: IPropertyType<TSchema> = {
		...base,
		[Demo]: settings.default ?? examples?.[0] ?? base[Demo],
		schema: new SchemaConstructor(),
	};

	const Refined = derivePropertyOf(Property, type) as Property;
	recordPropertyLineage(Refined, {
		kind: "refined",
		base: Property,
		options: Object.freeze({ ...settings }),
	});
	return Refined;
}
