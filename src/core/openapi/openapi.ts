import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { recordFieldOf } from "../blueprint/record-field";
import type {
	AnyRecordClass,
	BlueprintField,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { identityKeysOf } from "../entity/abstract-entity";
import { isEntityClass } from "../entity/entity";
import { isProperty } from "../property/is-property";
import { InvalidOpenAPIModel } from "./exceptions";
import type {
	OpenAPIComponents,
	OpenAPIOptions,
	OpenAPISchema,
} from "./types/openapi.interface";

type Schema = Record<string, unknown>;

/** What generating a schema needs: the records named among the models, and where they are. */
interface Scope {
	readonly names: ReadonlyMap<AnyRecordClass, string>;
	readonly prefix: string;
}

/** Keys a record marks on its own: sensitive ones, and the identity of an entity. */
interface Marks {
	readonly writeOnly: readonly string[];
	readonly readOnly: readonly string[];
}

const NO_MARKS: Marks = { writeOnly: [], readOnly: [] };

/** Whether `value` is any blueprint field. */
function isField(value: unknown): value is BlueprintField {
	return (
		isProperty(value) ||
		isBlueprint(value) ||
		isBlueprintList(value) ||
		recordFieldOf(value) !== undefined
	);
}

/** Whether `field`, as a key of a blueprint, accepts `undefined`. */
function isOptional(field: BlueprintField): boolean {
	if (isProperty(field)) return field.type.optional === true;
	if (isBlueprint(field) || isBlueprintList(field)) return field.optional;
	return recordFieldOf(field)?.optional ?? false;
}

/**
 * A plain copy of a TypeBox schema, without its hidden `~` keys; a nested
 * schema with an `$id` (e.g. the JSON Schema meta-schema) becomes a `$ref` to it.
 */
export function plainOf(value: unknown, nested = false): unknown {
	if (Array.isArray(value)) return value.map((item) => plainOf(item, true));
	if (typeof value !== "object" || value === null) return value;

	const id = (value as { $id?: unknown }).$id;
	if (nested && typeof id === "string") return { $ref: id };

	const plain: Schema = {};
	for (const [key, item] of Object.entries(value)) {
		if (!key.startsWith("~")) plain[key] = plainOf(item, true);
	}
	return plain;
}

/** The object schema of `properties`, every key closed, as blueprints reject undeclared ones. */
function objectOf(
	properties: IBlueprintCollection,
	scope: Scope,
	marks: Marks,
): Schema {
	const shape: Record<string, Schema> = {};
	const required: string[] = [];

	for (const [key, field] of Object.entries(properties)) {
		const schema = schemaOf(field, scope);
		if (marks.readOnly.includes(key)) schema.readOnly = true;
		if (marks.writeOnly.includes(key)) schema.writeOnly = true;
		shape[key] = schema;
		if (!isOptional(field)) required.push(key);
	}

	return {
		type: "object",
		properties: shape,
		...(required.length > 0 ? { required } : {}),
		additionalProperties: false,
	};
}

/** The schema of the blueprint of `record`, its sensitive keys write-only and an entity's identity read-only. */
function recordSchemaOf(record: AnyRecordClass, scope: Scope): Schema {
	const { sensitive = [] } =
		(
			record as {
				readonly options?: { readonly sensitive?: readonly string[] };
			}
		).options ?? {};
	return objectOf(record.blueprint.properties, scope, {
		writeOnly: sensitive,
		readOnly: isEntityClass(record) ? identityKeysOf(record) : [],
	});
}

/** The schema of `field`; a record named among the models is a `$ref`. */
function schemaOf(field: BlueprintField, scope: Scope): Schema {
	if (isBlueprintList(field)) {
		const { item, minItems, maxItems } = field;
		return {
			type: "array",
			items: schemaOf(item, scope),
			...(minItems === undefined ? {} : { minItems }),
			...(maxItems === undefined ? {} : { maxItems }),
		};
	}
	if (isBlueprint(field)) return objectOf(field.properties, scope, NO_MARKS);

	const record = recordFieldOf(field);
	if (record) {
		const name = scope.names.get(record.record);
		return name === undefined
			? recordSchemaOf(record.record, scope)
			: { $ref: `${scope.prefix}${name}` };
	}

	if (!isProperty(field)) {
		throw new InvalidOpenAPIModel({
			source: "openapi",
			details: { name: String(field) },
		});
	}
	const schema = plainOf(field.type.schema.type.Type()) as Schema;
	if (field.type.sensitive) schema.writeOnly = true;
	return schema;
}

/**
 * The OpenAPI 3.1 schema (a JSON Schema) of a property, blueprint, list,
 * record or entity, every nested record inline. Each `description`,
 * `examples`... given with `Property.with` is kept; sensitive keys are
 * `writeOnly`, the identity of an entity (`id`, `createdAt`, ...) `readOnly`,
 * optional keys left out of `required`, and objects closed with
 * `additionalProperties: false`.
 */
export function toOpenAPI(field: BlueprintField): OpenAPISchema;
/**
 * The `components` of an OpenAPI document for `models`, by name, e.g.
 * `toOpenAPI({ User, Post })`: a record named among them is a `$ref` wherever
 * another model holds it, as `{ $ref: "#/components/schemas/User" }`.
 */
export function toOpenAPI<const Models extends Record<string, BlueprintField>>(
	models: Models,
	options?: OpenAPIOptions,
): OpenAPIComponents<keyof Models & string>;
export function toOpenAPI(
	modelOrModels: BlueprintField | Record<string, BlueprintField>,
	{ refPrefix = "#/components/schemas/" }: OpenAPIOptions = {},
): OpenAPISchema | OpenAPIComponents {
	if (isField(modelOrModels)) {
		return schemaOf(modelOrModels, { names: new Map(), prefix: refPrefix });
	}
	if (typeof modelOrModels !== "object" || modelOrModels === null) {
		throw new InvalidOpenAPIModel({
			source: "openapi",
			details: { name: String(modelOrModels) },
		});
	}

	const names = new Map<AnyRecordClass, string>();
	for (const [name, model] of Object.entries(modelOrModels)) {
		if (!isField(model)) {
			throw new InvalidOpenAPIModel({ source: "openapi", details: { name } });
		}
		const record = recordFieldOf(model);
		if (record && !names.has(record.record)) names.set(record.record, name);
	}

	const scope: Scope = { names, prefix: refPrefix };
	const schemas: Record<string, OpenAPISchema> = {};
	for (const [name, model] of Object.entries(modelOrModels)) {
		const record = recordFieldOf(model);
		// A model is described in full, not as a reference to itself.
		schemas[name] =
			record && names.get(record.record) === name
				? recordSchemaOf(record.record, scope)
				: schemaOf(model, scope);
	}
	return { schemas };
}
