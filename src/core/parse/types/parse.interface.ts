import type { Exception } from "../../exception/exception";
import type { StandardSchemaV1 } from "../../standard/standard-schema";

/** Why a value was rejected. */
export type IssueCode =
	/** `undefined` for a field that is not optional. */
	| "required"
	/** Not an object where a blueprint expects one, nor an array for a list. */
	| "invalid_type"
	/** Rejected by a property: its schema or one of its handlers. */
	| "invalid_value"
	/** A key the blueprint does not declare. */
	| "undeclared_key"
	/** A list with fewer items than its `minItems`. */
	| "too_few_items"
	/** A list with more items than its `maxItems`. */
	| "too_many_items"
	/** Neither an instance of a record field's class nor a valid value of its blueprint. */
	| "not_record";

/**
 * One reason a value was rejected, as a Standard Schema issue: `path` is where
 * it is, e.g. `["addresses", 0, "zip"]`, empty for the value itself.
 */
export interface Issue extends StandardSchemaV1.Issue {
	readonly code: IssueCode;
	readonly path: readonly (string | number)[];
	/** Who rejected it: the property name, or the blueprint or record name. */
	readonly source: string;
	/** The exception a property raised for it, keeping its trace. */
	readonly cause?: Exception;
}

/**
 * The result of a parse, in the shape of a Standard Schema result: the value,
 * handled by its fields, or every issue found, never both.
 */
export type ParseResult<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: readonly Issue[] };
