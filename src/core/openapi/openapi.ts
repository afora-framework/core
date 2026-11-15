import { recordFieldOf } from "../blueprint/record-field";
import type {
	AnyRecordClass,
	BlueprintField,
} from "../blueprint/types/blueprint.interface";
import { InvalidOpenAPIModel } from "./exceptions";
import type {
	OpenAPIComponents,
	OpenAPIOptions,
	OpenAPISchema,
} from "./types/openapi.interface";
import { isField, recordSchemaOf, type Scope, schemaOf } from "./walker";

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
		return schemaOf(modelOrModels, openAPIScope(new Map(), refPrefix));
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

	const scope = openAPIScope(names, refPrefix);
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

/** The scope of an OpenAPI schema: records named among the models are `$ref`s under `prefix`. */
function openAPIScope(
	names: ReadonlyMap<AnyRecordClass, string>,
	prefix: string,
): Scope {
	return { dialect: "openapi", names, prefix };
}
