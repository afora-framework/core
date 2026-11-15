import type { OpenAPISchema } from "./openapi.interface";

/**
 * A JSON Schema (draft 2020-12) document: what `jsonSchemaOf` gives, its
 * `$schema` set and the records it holds under `$defs`.
 */
export interface JSONSchema extends OpenAPISchema {
	readonly $schema: "https://json-schema.org/draft/2020-12/schema";
	readonly $defs?: { readonly [name: string]: OpenAPISchema };
}
