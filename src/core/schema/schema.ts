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

/** Where the errors of one walk go: at most `max` of them, with the messages of `locale`. */
interface Sink {
	readonly errors: SchemaError[];
	readonly max: number;
	readonly locale: (error: never) => string;
	/** TypeBox's `exactOptionalPropertyTypes`: an optional key given as `undefined` is checked. */
	readonly exact: boolean;
}

/**
 * Tells why a schema rejects `value`, writing each error to `sink` as TypeBox
 * `Errors` would, and whether it accepts it. The paths are those of the
 * schema and of the value in the whole.
 */
type Explain = (
	value: unknown,
	schemaPath: string,
	instancePath: string,
	sink: Sink,
) => boolean;

/** Adds an error to `sink` unless it is full, as TypeBox's context does; always `false`. */
function addError(
	sink: Sink,
	keyword: string,
	schemaPath: string,
	instancePath: string,
	params: object,
): false {
	if (sink.errors.length < sink.max) {
		const error = { keyword, schemaPath, instancePath, params };
		sink.errors.push({ ...error, message: sink.locale(error as never) });
	}
	return false;
}

/** A key as TypeBox writes it in a path. */
const segmentOf = (key: string) =>
	key.replaceAll("~", "~0").replaceAll("/", "~1");

/** Whether `value` has `key`, as TypeBox asks it: inherited keys count, but for the three of a prototype. */
const hasKey = (value: object, key: string) =>
	key === "__proto__" || key === "constructor" || key === "prototype"
		? Object.hasOwn(value, key)
		: key in value;

/** The keywords `explainerOf` reads besides those of a leaf. */
const STRUCTURE_KEYWORDS = new Set<string | symbol>([
	"required",
	"properties",
	"additionalProperties",
	"items",
	"minItems",
	"maxItems",
	"anyOf",
]);

/**
 * The explanation of `schema`, compiled once, when it is made of nothing but
 * the keywords of a leaf, `required`, `properties`, `additionalProperties:
 * false`, `items` (one schema), `minItems`, `maxItems` and `anyOf`, at every
 * depth. It gives what TypeBox `Errors` gives (same errors, same order, same
 * paths, the same limit for each variant of an `anyOf`) without walking the
 * schema keyword by keyword on every call. `undefined` for a schema with any
 * other keyword (`allOf`, `not`, references, refinements...), which only
 * TypeBox tells.
 */
function explainerOf(schema: unknown): Explain | undefined {
	if (!isRecord(schema)) return undefined;
	for (const key of Reflect.ownKeys(schema)) {
		if (
			!LEAF_KEYWORD_NAMES.has(key) &&
			!INERT_KEYWORDS.has(key) &&
			!STRUCTURE_KEYWORDS.has(key)
		) {
			return undefined;
		}
	}

	// The keywords of a leaf, each checked by TypeBox on its own; `type` goes first.
	let type: LeafCheck | undefined;
	const leaves: LeafCheck[] = [];
	for (const [keyword, reads, params] of LEAF_KEYWORDS) {
		if (!Object.hasOwn(schema, keyword)) continue;
		const value = schema[keyword];
		if (!reads(value)) return undefined;
		const validator = Compile({ [keyword]: value } as TSchema);
		const leaf: LeafCheck = {
			keyword,
			params: params(value),
			check: (candidate) => validator.Check(candidate),
		};
		if (keyword === "type") type = leaf;
		else leaves.push(leaf);
	}

	let required: readonly string[] | undefined;
	if (Object.hasOwn(schema, "required")) {
		const value = schema.required;
		if (!Array.isArray(value)) return undefined;
		if (!value.every((key) => typeof key === "string")) return undefined;
		required = value;
	}

	let properties:
		| readonly {
				readonly key: string;
				readonly segment: string;
				readonly required: boolean;
				readonly explain: Explain;
		  }[]
		| undefined;
	if (Object.hasOwn(schema, "properties")) {
		if (!isRecord(schema.properties)) return undefined;
		const list = [];
		for (const [key, property] of Object.entries(schema.properties)) {
			const explain = explainerOf(property);
			if (!explain) return undefined;
			list.push({
				key,
				segment: segmentOf(key),
				required: required?.includes(key) ?? false,
				explain,
			});
		}
		properties = list;
	}

	// Only a closed object: any other `additionalProperties` is a schema of its own.
	let declared: ReadonlySet<string> | undefined;
	if (Object.hasOwn(schema, "additionalProperties")) {
		if (schema.additionalProperties !== false) return undefined;
		declared = new Set(properties?.map(({ key }) => key));
	}

	let items: Explain | undefined;
	if (Object.hasOwn(schema, "items")) {
		items = explainerOf(schema.items);
		if (!items) return undefined;
	}

	const limits: LeafCheck[] = [];
	for (const keyword of ["minItems", "maxItems"]) {
		if (!Object.hasOwn(schema, keyword)) continue;
		const limit = schema[keyword];
		if (typeof limit !== "number") return undefined;
		const validator = Compile({ [keyword]: limit } as TSchema);
		limits.push({
			keyword,
			params: { limit },
			check: (candidate) => validator.Check(candidate),
		});
	}

	let anyOf: readonly Explain[] | undefined;
	if (Object.hasOwn(schema, "anyOf")) {
		if (!Array.isArray(schema.anyOf)) return undefined;
		const list: Explain[] = [];
		for (const option of schema.anyOf) {
			const explain = explainerOf(option);
			if (!explain) return undefined;
			list.push(explain);
		}
		anyOf = list;
	}

	// The order below is the order TypeBox visits the keywords in, none skipped
	// for another having failed.
	return (value, schemaPath, instancePath, sink) => {
		if (sink.errors.length >= sink.max) return false;
		let accepted = true;

		if (type && !type.check(value)) {
			accepted = addError(sink, "type", schemaPath, instancePath, type.params);
		}

		if (isRecord(value)) {
			if (required) {
				const missing = required.filter((key) => !hasKey(value, key));
				if (missing.length > 0) {
					accepted = addError(sink, "required", schemaPath, instancePath, {
						requiredProperties: missing,
					});
				}
			}
			if (declared) {
				const undeclared: string[] = [];
				for (const key of Object.getOwnPropertyNames(value)) {
					if (declared.has(key)) continue;
					undeclared.push(key);
					addError(
						sink,
						"boolean",
						`${schemaPath}/additionalProperties`,
						`${instancePath}/${segmentOf(key)}`,
						{},
					);
				}
				if (undeclared.length > 0) {
					accepted = addError(
						sink,
						"additionalProperties",
						schemaPath,
						instancePath,
						{ additionalProperties: undeclared },
					);
				}
			}
			if (properties) {
				for (const property of properties) {
					const { key } = property;
					// An optional key left `undefined` is not checked, unless TypeBox is told to.
					if (!property.required && !sink.exact && value[key] === undefined) {
						continue;
					}
					if (!hasKey(value, key)) continue;
					const explained = property.explain(
						value[key],
						`${schemaPath}/properties/${property.segment}`,
						`${instancePath}/${property.segment}`,
						sink,
					);
					if (!explained) accepted = false;
				}
			}
		}

		if (Array.isArray(value)) {
			if (items) {
				const explain = items;
				// `forEach`, as TypeBox: the holes of an array are not items.
				value.forEach((item, index) => {
					const explained = explain(
						item,
						`${schemaPath}/items`,
						`${instancePath}/${index}`,
						sink,
					);
					if (!explained) accepted = false;
				});
			}
			for (const limit of limits) {
				if (limit.check(value)) continue;
				accepted = addError(
					sink,
					limit.keyword,
					schemaPath,
					instancePath,
					limit.params,
				);
			}
		}

		for (const leaf of leaves) {
			if (leaf.check(value)) continue;
			accepted = addError(
				sink,
				leaf.keyword,
				schemaPath,
				instancePath,
				leaf.params,
			);
		}

		if (anyOf) {
			// Each variant has the limit to itself; what the failed ones found is
			// then added, up to the limit of the whole, before the error of `anyOf`.
			const failed: SchemaError[][] = [];
			let matched = false;
			for (const [index, explain] of anyOf.entries()) {
				const own: Sink = { ...sink, errors: [] };
				const explained = explain(
					value,
					`${schemaPath}/anyOf/${index}`,
					instancePath,
					own,
				);
				if (explained) matched = true;
				else failed.push(own.errors);
			}
			if (!matched) {
				for (const errors of failed) {
					for (const error of errors) {
						if (sink.errors.length < sink.max) sink.errors.push(error);
					}
				}
				accepted = addError(sink, "anyOf", schemaPath, instancePath, {});
			}
		}

		return accepted;
	};
}

/** The explanation of each schema, `null` when only TypeBox tells it; made on its first rejected value. */
const explainers = new WeakMap<object, Explain | null>();

/** A sink with the limit, the messages and the settings TypeBox has now; `undefined` without them. */
function sinkOf(): Sink | undefined {
	const settings = Settings.Get();
	const locale = Locale.Get();
	if (typeof settings?.maxErrors !== "number" || typeof locale !== "function") {
		return undefined;
	}
	return {
		errors: [],
		max: settings.maxErrors,
		locale: locale as Sink["locale"],
		exact: settings.exactOptionalPropertyTypes === true,
	};
}

/** One variant of a discriminated union: where it is in `anyOf`, and what tells its errors. */
interface Variant {
	readonly index: number;
	/** Its explanation, when it has one. */
	readonly explain: Explain | undefined;
	/** Its errors as TypeBox tells them, with paths from the variant. */
	Errors(value: unknown): readonly SchemaError[];
}

/** A union whose variants are objects told apart by the value of one key. */
interface DiscriminatedUnion {
	/** The key, as it is and as a segment of an instance path. */
	readonly key: string;
	readonly segment: string;
	/** The value of the key in each variant, in the order of the variants. */
	readonly allowedValues: readonly unknown[];
	readonly variants: ReadonlyMap<unknown, Variant>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The value `key` must have in the object schema `variant`, when it is a required literal. */
function literalOf(
	variant: unknown,
	key: string,
): { value: unknown } | undefined {
	if (!isRecord(variant) || variant.type !== "object") return undefined;
	const { properties, required } = variant;
	if (!isRecord(properties) || !Array.isArray(required)) return undefined;
	if (!required.includes(key) || !Object.hasOwn(properties, key)) {
		return undefined;
	}
	const property = properties[key];
	if (!isRecord(property) || !Object.hasOwn(property, "const"))
		return undefined;
	const value = property.const;
	return typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
		? { value }
		: undefined;
}

/**
 * `schema` as a discriminated union: nothing but an `anyOf` (and annotations)
 * whose variants are all object schemas that require one same key with a
 * literal, a different one in each. `undefined` for any other schema, a union
 * of other things included.
 */
function discriminatedUnionOf(schema: unknown): DiscriminatedUnion | undefined {
	if (!isRecord(schema) || !Array.isArray(schema.anyOf)) return undefined;
	for (const key of Reflect.ownKeys(schema)) {
		if (key !== "anyOf" && !INERT_KEYWORDS.has(key)) return undefined;
	}
	const options: readonly unknown[] = schema.anyOf;
	const [first] = options;
	if (options.length < 2 || !isRecord(first) || !isRecord(first.properties)) {
		return undefined;
	}

	for (const key of Object.keys(first.properties)) {
		const variants = new Map<unknown, Variant>();
		for (const [index, option] of options.entries()) {
			const literal = literalOf(option, key);
			if (!literal || variants.has(literal.value)) break;
			let validator: { Errors(value: unknown): unknown } | undefined;
			variants.set(literal.value, {
				index,
				explain: explainerOf(option),
				Errors: (value) => {
					validator ??= Compile(option as TSchema);
					return validator.Errors(value) as readonly SchemaError[];
				},
			});
		}
		if (variants.size !== options.length) continue;
		return {
			key,
			segment: segmentOf(key),
			allowedValues: [...variants.keys()],
			variants,
		};
	}
	return undefined;
}

/** The discriminated union of each schema, `null` when it is not one; found on its first rejected value. */
const discriminatedUnions = new WeakMap<object, DiscriminatedUnion | null>();

/**
 * The errors of the object `value`, which the discriminated union rejects:
 * those of the variant its key names, and of that variant alone, or the one
 * error of a key that names none. TypeBox gives the errors of every variant,
 * most of them about variants the value was never meant to be. `undefined`
 * when only TypeBox can answer.
 */
function errorsOfVariant(
	union: DiscriminatedUnion,
	value: Record<string, unknown>,
): readonly SchemaError[] | undefined {
	const variant = union.variants.get(value[union.key]);
	if (variant) {
		const at = `#/anyOf/${variant.index}`;
		const sink = variant.explain && sinkOf();
		if (variant.explain && sink) {
			variant.explain(value, at, "", sink);
			return sink.errors.length > 0 ? sink.errors : undefined;
		}
		const errors = variant.Errors(value);
		if (errors.length === 0) return undefined;
		return errors.map((error) => ({
			...error,
			schemaPath: at + error.schemaPath.slice(1),
		}));
	}

	const maxErrors = Settings.Get().maxErrors;
	const locale = Locale.Get();
	if (typeof maxErrors !== "number" || typeof locale !== "function") {
		return undefined;
	}
	if (maxErrors < 1) return [];
	const error = {
		keyword: "enum",
		schemaPath: "#/anyOf",
		instancePath: `/${union.segment}`,
		params: { allowedValues: union.allowedValues },
	};
	return [{ ...error, message: locale(error as never) }];
}

/**
 * The errors of `value`, which `schema` rejects. For every schema but one
 * they are what `schema.type.Errors(value)` gives: same errors, same order,
 * same messages. The one is a discriminated union given an object, told by
 * the variant its key names (see `errorsOfVariant`). TypeBox is only asked
 * about a schema with a keyword that has no explanation here (`explainerOf`).
 * @internal
 */
export function errorsOfSchema(
	schema: ISchema<TSchema>,
	value: unknown,
): readonly SchemaError[] {
	let checks = leafChecks.get(schema);
	if (checks === undefined) {
		checks = leafChecksOf(rawTypeOf(schema)) ?? null;
		leafChecks.set(schema, checks);
	}
	const maxErrors = Settings.Get().maxErrors;
	const locale = Locale.Get();
	// Without the limit and the messages of TypeBox, only TypeBox can answer.
	if (
		checks !== null &&
		typeof maxErrors === "number" &&
		typeof locale === "function"
	) {
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
	if (checks === null && isRecord(value)) {
		let union = discriminatedUnions.get(schema);
		if (union === undefined) {
			union = discriminatedUnionOf(rawTypeOf(schema)) ?? null;
			discriminatedUnions.set(schema, union);
		}
		const errors = union && errorsOfVariant(union, value);
		if (errors) return errors;
	}
	if (checks === null) {
		let explain = explainers.get(schema);
		if (explain === undefined) {
			explain = explainerOf(rawTypeOf(schema)) ?? null;
			explainers.set(schema, explain);
		}
		const sink = explain && sinkOf();
		if (explain && sink) {
			explain(value, "#", "", sink);
			// A schema that rejects a value has an error for it; if not, TypeBox answers.
			if (sink.errors.length > 0) return sink.errors;
		}
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

	/** `match` and `matchShape` as functions that go straight to the compiled checks. */
	checks(): SchemaChecks {
		const validator = this.type;
		const shape = shapeOf(this._type) as { readonly type?: unknown };
		// The shape of a string alone is what TypeBox compiles it to.
		if (shape.type === "string" && Object.keys(shape).length === 1) {
			return {
				match: (value) => validator.Check(value),
				matchShape: (value) => typeof value === "string",
			};
		}
		return {
			match: (value) => validator.Check(value),
			matchShape: (value) => this.matchShape(value),
		};
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

/** The two checks of a schema, as functions. */
export interface SchemaChecks {
	match(value: unknown): boolean;
	matchShape(value: unknown): boolean;
}

/**
 * `schema.match` and `schema.matchShape`, compiled now, for who checks many
 * values with one schema; those of a schema not made by `schemaOf` call it.
 * @internal
 */
export function checksOfSchema(schema: ISchema<TSchema>): SchemaChecks {
	return schema instanceof AbstractSchema
		? schema.checks()
		: {
				match: (value) => schema.match(value),
				matchShape: (value) => schema.matchShape(value),
			};
}

/**
 * The TypeBox schema of `schema`, as it was given, without compiling it:
 * `schema.type.Type()` gives the same schema but compiles it first, which is
 * most of the time spent at import when only the schema is read (the
 * meta-schema of `ctx.schema` alone takes milliseconds). A schema not made
 * by `schemaOf` is asked through `type`.
 * @internal
 */
export function rawTypeOf<SchemaType extends TSchema>(
	schema: ISchema<SchemaType>,
): SchemaType {
	return schema instanceof AbstractSchema
		? (schema as unknown as { readonly _type: SchemaType })._type
		: (schema.type.Type() as SchemaType);
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
