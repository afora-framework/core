import { recordFieldOf } from "../blueprint/record-field";
import type {
	AnyRecordClass,
	BlueprintField,
} from "../blueprint/types/blueprint.interface";
import { InvalidOpenAPIModel } from "./exceptions";
import type { JSONSchema } from "./types/json-schema.interface";
import {
	type Definition,
	isField,
	recordSchemaOf,
	refsToDefs,
	type Schema,
	schemaOf,
} from "./walker";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * The JSON Schema (draft 2020-12) of a property, blueprint, list, variant,
 * record or entity, as a standalone document: what an AI client, a form or
 * any JSON Schema validator reads. It is `toOpenAPI` in the JSON Schema
 * dialect: each record held inside is defined once under `$defs`, by its
 * name, and referenced as `{ $ref: "#/$defs/Address" }` (so is the schema
 * of a property with an `$id`, without it, so the document is
 * self-contained), a read-only key is not `required`, and a variant is
 * `oneOf` without the OpenAPI `discriminator`. Sensitive keys are
 * `writeOnly`, the identity of an entity `readOnly`, optional keys left out
 * of `required`, and objects closed with `additionalProperties: false`.
 *
 * @example
 * ```ts
 * import { blueprintOf, jsonSchemaOf } from "@afora/core";
 *
 * const Post = blueprintOf((ctx) => ({ title: ctx.string, tags: ctx.list.string }));
 * jsonSchemaOf(Post);
 * // { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", ... }
 * ```
 */
export function jsonSchemaOf(field: BlueprintField): JSONSchema {
	if (!isField(field)) {
		throw new InvalidOpenAPIModel({
			source: "jsonSchemaOf",
			details: { name: String(field) },
		});
	}

	const defs = new Map<AnyRecordClass | string, Definition>();
	const scope = {
		dialect: "json-schema",
		names: new Map(),
		prefix: "#/$defs/",
		defs,
	} as const;
	const record = recordFieldOf(field);
	// The record given is the document itself, not a reference to a definition.
	const root =
		record && record.record === field
			? recordSchemaOf(record.record, scope)
			: schemaOf(field, scope);

	const $defs: Record<string, Schema> = {};
	for (const { name, schema } of defs.values()) {
		if (schema) $defs[name] = schema;
	}
	const document = {
		$schema: DIALECT,
		...root,
		...(defs.size > 0 ? { $defs } : {}),
	};
	refsToDefs(document, defs, scope.prefix);
	return document as JSONSchema;
}
