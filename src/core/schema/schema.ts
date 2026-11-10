import type { Static, TSchema } from "typebox";
import Compile from "typebox/compile";
import { Locale, Settings } from "typebox/system";
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

/** One TypeBox error, as `Errors` gives it. */
export interface SchemaError {
	readonly keyword: string;
	readonly schemaPath: string;
	readonly instancePath: string;
	readonly params: object;
	readonly message: string;
}

/** Keywords that say nothing about a value, so no error comes from them. */
const INERT_KEYWORDS = new Set<string | symbol>([
	"~kind",
	"~optional",
	"~readonly",
	"~unsafe",
	"title",
	"description",
	"default",
	"examples",
	"deprecated",
	"readOnly",
	"writeOnly",
	"$comment",
]);

const isNumeric = (value: unknown) =>
	typeof value === "number" || typeof value === "bigint";

/**
 * The keywords a plain value is checked by (a string, a number, a boolean...),
 * in the order TypeBox reports them, each with whether its value is one
 * TypeBox reads, and the `params` of its error.
 */
const LEAF_KEYWORDS: readonly (readonly [
	keyword: string,
	reads: (value: unknown) => boolean,
	params: (value: unknown) => object,
])[] = [
	[
		"type",
		(value) =>
			typeof value === "string" ||
			(Array.isArray(value) && value.every((item) => typeof item === "string")),
		(type) => ({ type }),
	],
	["minLength", (value) => typeof value === "number", (limit) => ({ limit })],
	["maxLength", (value) => typeof value === "number", (limit) => ({ limit })],
	["format", (value) => typeof value === "string", (format) => ({ format })],
	["pattern", (value) => typeof value === "string", (pattern) => ({ pattern })],
	["exclusiveMinimum", isNumeric, (limit) => ({ comparison: ">", limit })],
	["exclusiveMaximum", isNumeric, (limit) => ({ comparison: "<", limit })],
	["minimum", isNumeric, (limit) => ({ comparison: ">=", limit })],
	["maximum", isNumeric, (limit) => ({ comparison: "<=", limit })],
	["multipleOf", isNumeric, (multipleOf) => ({ multipleOf })],
	["const", () => true, (allowedValue) => ({ allowedValue })],
	["enum", Array.isArray, (allowedValues) => ({ allowedValues })],
];

const LEAF_KEYWORD_NAMES = new Set<string | symbol>(
	LEAF_KEYWORDS.map(([keyword]) => keyword),
);

/** One keyword of a leaf schema: its own check, and the error of a value it rejects. */
interface LeafCheck {
	readonly keyword: string;
	readonly params: object;
	check(value: unknown): boolean;
}

/**
 * The checks of `schema` when it is a leaf: only keywords of `LEAF_KEYWORDS`
 * (and annotations), each compiled by TypeBox on its own, so that a value
 * rejected by the whole schema is told why without `Errors`, which walks the
 * schema again, keyword by keyword, on every call. `undefined` for any other
 * schema (objects, arrays, unions, references, refinements...).
 */
function leafChecksOf(schema: unknown): readonly LeafCheck[] | undefined {
	if (typeof schema !== "object" || schema === null) return undefined;
	for (const key of Reflect.ownKeys(schema)) {
		if (!LEAF_KEYWORD_NAMES.has(key) && !INERT_KEYWORDS.has(key)) {
			return undefined;
		}
	}

	const checks: LeafCheck[] = [];
	for (const [keyword, reads, params] of LEAF_KEYWORDS) {
		if (!Object.hasOwn(schema, keyword)) continue;
		const value = (schema as Record<string, unknown>)[keyword];
		if (!reads(value)) return undefined;
		const validator = Compile({ [keyword]: value } as TSchema);
		checks.push({
			keyword,
			params: params(value),
			check: (candidate) => validator.Check(candidate),
		});
	}
	return checks;
}

/** The leaf checks of each schema, `null` when it is not a leaf; made on its first rejected value. */
const leafChecks = new WeakMap<object, readonly LeafCheck[] | null>();

/**
 * The errors of `value`, which `schema` rejects, as `schema.type.Errors(value)`
 * gives them: same errors, same order, same messages.
 * @internal
 */
export function errorsOfSchema(
	schema: ISchema<TSchema>,
	value: unknown,
): readonly SchemaError[] {
	let checks = leafChecks.get(schema);
	if (checks === undefined) {
		checks = leafChecksOf(schema.type.Type()) ?? null;
		leafChecks.set(schema, checks);
	}
	if (checks !== null) {
		const { maxErrors } = Settings.Get();
		const locale = Locale.Get();
		const errors: SchemaError[] = [];
		for (const { keyword, params, check } of checks) {
			if (errors.length >= maxErrors) break;
			if (check(value)) continue;
			const error = { keyword, schemaPath: "#", instancePath: "", params };
			errors.push({ ...error, message: locale(error as never) });
		}
		// A leaf that rejects a value has an error for it; if not, TypeBox answers.
		if (errors.length > 0) return errors;
	}
	return schema.type.Errors(value) as readonly SchemaError[];
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
