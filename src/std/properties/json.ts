import { type Static, type TOptional, type TSchema, Type } from "typebox";
import { Meta } from "typebox/schema";
import Value from "typebox/value";
import type { Issue, IssueCode } from "../../core/parse/types/parse.interface";
import { recordPropertyLineage } from "../../core/property/lineage";
import { type PropertyClass, propertyOf } from "../../core/property/property";
import { InvalidJsonData, InvalidJsonSchema } from "./exceptions";

/** A value JSON can hold, as `JSON.parse` gives it. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

type Path = readonly (string | number)[];

/** Why `value` is not JSON, and where; `undefined` when it is. */
function notJson(
	value: unknown,
	path: Path = [],
	ancestors: readonly object[] = [],
): { readonly path: Path; readonly message: string } | undefined {
	if (value === null) return undefined;
	switch (typeof value) {
		case "string":
		case "boolean":
			return undefined;
		case "number":
			return Number.isFinite(value)
				? undefined
				: { path, message: `is not JSON (${value})` };
		case "object":
			break;
		default:
			return { path, message: `is not JSON (${typeof value})` };
	}
	if (ancestors.includes(value)) return { path, message: "is circular" };
	const inner = [...ancestors, value];
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const found = notJson(value[index], [...path, index], inner);
			if (found) return found;
		}
		return undefined;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return {
			path,
			message: `is not JSON (an instance of ${prototype?.constructor?.name ?? "a class"})`,
		};
	}
	for (const [key, item] of Object.entries(value)) {
		const found = notJson(item, [...path, key], inner);
		if (found) return found;
	}
	return undefined;
}

const JSON_SCHEMA = Type.Unsafe({
	type: "object",
	allOf: [Meta["https://json-schema.org/draft/2020-12/schema"]],
});

/** Schemas found to be JSON Schemas, so each is checked once. */
const checked = new WeakSet<object>();

function assertJsonSchema(schema: unknown, source: string): TSchema {
	if (typeof schema === "object" && schema !== null && checked.has(schema)) {
		return schema as TSchema;
	}
	if (!Value.Check(JSON_SCHEMA, schema)) {
		throw new InvalidJsonSchema({ source });
	}
	checked.add(schema as object);
	return schema as TSchema;
}

/** A JSON Pointer (`/data/0/a~1b`) as a path (`["data", 0, "a/b"]`). */
function pathOf(pointer: string): (string | number)[] {
	if (pointer === "") return [];
	return pointer
		.slice(1)
		.split("/")
		.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
		.map((segment) =>
			/^(?:0|[1-9][0-9]*)$/.test(segment) ? +segment : segment,
		);
}

interface SchemaError {
	readonly keyword: string;
	readonly schemaPath: string;
	readonly instancePath: string;
	readonly params: Readonly<Record<string, unknown>>;
	readonly message: string;
}

/** The issues of the errors TypeBox finds, one for each key that is missing or not declared. */
function issuesOfErrors(
	errors: readonly SchemaError[],
	source: string,
): Issue[] {
	const issues: Issue[] = [];
	const add = (path: Path, code: IssueCode, message: string): void => {
		issues.push({ path, code, message, source });
	};
	for (const error of errors) {
		const path = pathOf(error.instancePath);
		const keys = (name: string): readonly string[] =>
			Array.isArray(error.params[name]) ? (error.params[name] as string[]) : [];
		if (error.keyword === "required") {
			for (const key of keys("requiredProperties")) {
				add([...path, key], "required", "is required");
			}
		} else if (error.keyword === "additionalProperties") {
			for (const key of keys("additionalProperties")) {
				add([...path, key], "undeclared_key", "is not declared");
			}
		} else if (
			// `additionalProperties: false` is reported again for each key.
			!(
				error.keyword === "boolean" &&
				error.schemaPath.endsWith("/additionalProperties")
			)
		) {
			add(
				path,
				error.keyword === "type" ? "invalid_type" : "invalid_value",
				error.message,
			);
		}
	}
	return issues;
}

/**
 * Every issue that keeps `value` from being JSON valid for `schema` (a JSON
 * Schema, draft 2020-12, or a TypeBox type), as afora issues: empty when
 * there is none. For schemas known at runtime only, e.g. loaded from a
 * database: TypeBox checks the value by walking the schema, compiling
 * nothing. Throws `InvalidJsonSchema` when `schema` is not a JSON Schema.
 */
export function jsonSchemaIssues(
	schema: TSchema,
	value: unknown,
	{ source = "json" }: { readonly source?: string } = {},
): readonly Issue[] {
	const checkedSchema = assertJsonSchema(schema, source);
	const found = notJson(value);
	if (found) {
		return [
			{
				path: found.path,
				code: "invalid_value",
				message: found.message,
				source,
			},
		];
	}
	if (Value.Check(checkedSchema, value)) return [];
	return issuesOfErrors(
		Value.Errors(checkedSchema, value) as unknown as readonly SchemaError[],
		source,
	);
}

/**
 * `value`, when it is JSON valid for `schema`; else throws `InvalidJsonData`
 * with every issue in `details.issues` (a 400 for `statusOf`). `source` names
 * what is checked in the issues and the exception, e.g. the content type.
 * See `jsonSchemaIssues`.
 */
export function checkJsonSchema<const Schema extends TSchema>(
	schema: Schema,
	value: unknown,
	options: { readonly source?: string } = {},
): Static<Schema> {
	const issues = jsonSchemaIssues(schema, value, options);
	if (issues.length > 0) {
		throw new InvalidJsonData({
			source: options.source ?? "json",
			details: { issues },
		});
	}
	return value as Static<Schema>;
}

/** A value TypeBox makes from `schema`, if it can. */
function demoOf(schema: TSchema): unknown {
	try {
		return Value.Create(schema);
	} catch {
		return undefined;
	}
}

/** Throws, for the property to reject it, when `value` is not JSON. */
function assertJson<Value>(value: Value): Value {
	const found = notJson(value);
	if (found) {
		throw new Error(
			`${found.path.length === 0 ? "" : `/${found.path.join("/")}: `}${found.message}`,
		);
	}
	return value;
}

/**
 * Any JSON value: `null`, a boolean, a finite number, a string, or a list or
 * plain object of them, at any depth. Rejects `undefined` (in a list or an
 * object too), functions, `NaN`, class instances such as `Date`, and cycles.
 * For JSON of a known shape, `jsonOf({ schema })`.
 */
export const JsonProperty = propertyOf({
	name: "json",
	schema: Type.Unsafe<JsonValue>({}),
	default: {},
	preHandle: assertJson,
});

/** A class declared with `jsonOf`. */
export type JsonClass<
	Schema extends TSchema,
	Optional extends boolean = false,
> = PropertyClass<
	Optional extends true ? TOptional<Schema> : Schema,
	Static<Schema>
>;

/**
 * JSON checked by a JSON Schema (draft 2020-12) known when the property is
 * declared, written as JSON (`{ type: "object", properties: {...} }`, typed
 * as `Static` gives it) or with TypeBox (`Type.Object({...})`). Its issues
 * are at the path of the data that breaks the schema. Throws
 * `InvalidJsonSchema` for a schema that is not a JSON Schema. For a schema
 * known only at runtime, `checkJsonSchema`.
 */
export function jsonOf<
	const Schema extends TSchema,
	Optional extends boolean = false,
>({
	schema,
	name = "json",
	optional,
	default: _default,
}: {
	readonly schema: Schema;
	readonly name?: string;
	readonly optional?: Optional;
	/** The demo value; one TypeBox makes from the schema, when it can, by default. */
	readonly default?: Static<Schema>;
}): JsonClass<Schema, Optional> {
	assertJsonSchema(schema, name);
	const made = _default ?? demoOf(schema);
	const Json = propertyOf({
		name,
		schema,
		optional,
		...(made !== undefined && Value.Check(schema, made)
			? { default: made as Static<Schema> }
			: {}),
		preHandle: assertJson,
	});
	recordPropertyLineage(Json, {
		kind: "factory",
		factory: "jsonOf",
		args: Object.freeze({
			schema,
			...(name === "json" ? {} : { name }),
			...(optional ? { optional: true } : {}),
			...(_default === undefined ? {} : { default: _default }),
		}),
	});
	return Json as unknown as JsonClass<Schema, Optional>;
}
