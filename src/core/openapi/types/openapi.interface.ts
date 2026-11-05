/**
 * An OpenAPI 3.1 Schema Object, which is a JSON Schema (draft 2020-12): what
 * `toOpenAPI` gives for a field, with the keywords it writes typed.
 */
export interface OpenAPISchema {
	readonly type?: string | readonly string[];
	readonly properties?: { readonly [key: string]: OpenAPISchema };
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean | OpenAPISchema;
	readonly items?: OpenAPISchema;
	readonly $ref?: string;
	readonly title?: string;
	readonly description?: string;
	readonly examples?: readonly unknown[];
	readonly deprecated?: boolean;
	readonly readOnly?: boolean;
	readonly writeOnly?: boolean;
	readonly [keyword: string]: unknown;
}

/**
 * What `toOpenAPI` gives for named models: the `components` of an OpenAPI
 * document, a schema per name, e.g. `{ schemas: { User: {...} } }`.
 */
export interface OpenAPIComponents<Name extends PropertyKey = string> {
	readonly schemas: { readonly [Key in Name]: OpenAPISchema };
}

export interface OpenAPIOptions {
	/**
	 * Where a record named among the models is referenced from: `$ref` is this
	 * prefix and its name. `"#/components/schemas/"` by default.
	 */
	readonly refPrefix?: string;
}
