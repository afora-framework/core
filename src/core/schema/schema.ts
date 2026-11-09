import type { Static, TSchema } from "typebox";
import Compile from "typebox/compile";
import type { ISchema, ISchemaType } from "./types/schema.interface";

/** Keywords kept as they are: the types, and the references between schemas. */
const KEPT_KEYWORDS = new Set([
	"type",
	"required",
	"$ref",
	"$id",
	"$anchor",
	"$dynamicRef",
	"$dynamicAnchor",
]);

/** Keywords whose value is a schema, or a list of schemas. */
const SCHEMA_KEYWORDS = new Set([
	"additionalProperties",
	"items",
	"additionalItems",
	"prefixItems",
	"anyOf",
	"oneOf",
	"allOf",
	"contains",
	"propertyNames",
]);

/** Keywords whose value maps names (or patterns) to schemas. */
const SCHEMA_MAP_KEYWORDS = new Set([
	"properties",
	"patternProperties",
	"dependentSchemas",
	"$defs",
	"definitions",
]);

const JSON_TYPES = new Set([
	"null",
	"array",
	"string",
	"number",
	"boolean",
	"object",
]);

/** The JSON Schema type of `value`, if it has one. */
function typeOfValue(value: unknown): string | undefined {
	const type =
		value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
	return JSON_TYPES.has(type) ? type : undefined;
}

/**
 * `schema` without its constraints (`minLength`, `format`, `const`, ...). It
 * accepts every value `schema` accepts, so keywords whose meaning would flip
 * without their constraints (`not`, `if`/`then`/`else`) are dropped whole.
 */
function shapeOf(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(shapeOf);
	if (typeof schema !== "object" || schema === null) return schema;

	const shape: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (KEPT_KEYWORDS.has(key)) shape[key] = value;
		else if (SCHEMA_KEYWORDS.has(key)) shape[key] = shapeOf(value);
		else if (SCHEMA_MAP_KEYWORDS.has(key)) {
			shape[key] = Object.fromEntries(
				Object.entries(value as object).map(([name, item]) => [
					name,
					shapeOf(item),
				]),
			);
		}
	}

	// `const` and `enum` without `type` (e.g. `Type.Enum`) keep the types of their values.
	if (!("type" in shape)) {
		const values =
			"const" in schema
				? [(schema as { const: unknown }).const]
				: (schema as { enum?: unknown }).enum;
		if (Array.isArray(values)) {
			const types = values.map(typeOfValue);
			if (types.every((type) => type !== undefined)) {
				shape.type = [...new Set(types)];
			}
		}
	}
	return shape;
}

/** One TypeBox error as the text kept in the `details` of an exception. */
export function describeError(error: {
	instancePath: string;
	message: string;
}): string {
	return `${error.instancePath || "/"}: ${error.message}`;
}

abstract class AbstractSchema<
	SchemaType extends TSchema,
	Value = Static<SchemaType>,
> implements ISchema<SchemaType, Value>
{
	private validator?: ISchemaType<SchemaType, Value>;
	private shapeValidator?: ISchemaType<TSchema>;

	constructor(protected readonly _type: SchemaType) {}

	match(value: unknown): value is Value {
		return this.type.Check(value);
	}

	matchShape(value: unknown): boolean {
		this.shapeValidator ??= Compile(shapeOf(this._type) as TSchema);
		return this.shapeValidator.Check(value);
	}

	errors(value: unknown): string[] {
		return this.type.Errors(value).map(describeError);
	}

	toString(): string {
		return JSON.stringify(this._type);
	}

	get type(): ISchemaType<SchemaType, Value> {
		this.validator ??= Compile(this._type) as unknown as ISchemaType<
			SchemaType,
			Value
		>;
		return this.validator;
	}
}

/** A schema class declared with `schemaOf`. */
export interface SchemaClass<SchemaType extends TSchema> {
	new (type?: SchemaType): ISchema<SchemaType>;
	fromString(value: string): ISchema<SchemaType>;
}

export function schemaOf<SchemaType extends TSchema>(
	name: string,
	schema: SchemaType,
): SchemaClass<SchemaType> {
	class Schema extends AbstractSchema<SchemaType> {
		constructor(type: SchemaType = schema) {
			super(type);
		}

		static fromString(value: string): Schema {
			return new Schema(JSON.parse(value) as SchemaType);
		}
	}

	Object.defineProperty(Schema, "name", { value: name });
	Object.defineProperty(Schema, Symbol.for("nodejs.util.inspect.custom"), {
		value: () => `@afora::schema:${name}`,
	});

	return Schema;
}
