import { Kind } from "../symbols/kind";
import type {
	AnyOptionalRecord,
	AnyRecordClass,
} from "./types/blueprint.interface";

/** Whether `value` is a class made by `recordOf`, or one extending it. */
export function isRecordClass(value: unknown): value is AnyRecordClass {
	return (
		typeof value === "function" &&
		(value as { [Kind]?: unknown })[Kind] === "record"
	);
}

/** Whether `value` is a record made optional by `optionalOf`. */
export function isOptionalRecord(value: unknown): value is AnyOptionalRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { [Kind]?: unknown })[Kind] === "record"
	);
}

/**
 * The record class a field holds an instance of, and whether it accepts
 * `undefined`; `undefined` when the field is not a record.
 */
export function recordFieldOf(
	field: unknown,
): { readonly record: AnyRecordClass; readonly optional: boolean } | undefined {
	if (isRecordClass(field)) return { record: field, optional: false };
	if (isOptionalRecord(field)) return field;
	return undefined;
}
