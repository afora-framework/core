import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";
import type { Issue } from "../parse/types/parse.interface";

/**
 * A key of a record got a value its field rejects; `source` is the record
 * name, `key` and `errors` are those of the first issue, and `issues` has all
 * of them (not enumerable, so it stays out of logs and comparisons).
 */
export const InvalidRecordValue = exceptionOf({
	layer: ExceptionLayers.Record,
	name: "InvalidRecordValue",
	message: (
		{
			key,
			errors,
		}: {
			readonly key: string;
			readonly errors: readonly string[];
			readonly issues: readonly Issue[];
		},
		source,
	) =>
		`Invalid value for ${key ? `"${key}" of ` : ""}record "${source}": ${errors.join("; ")}`,
});

/** `recordOf` or `entityOf` got an option it cannot use, as a `name` that is not an identifier. */
export const InvalidRecordDeclaration = exceptionOf({
	layer: ExceptionLayers.Record,
	name: "InvalidRecordDeclaration",
	message: (reason: string, source) =>
		`Invalid declaration of record "${source}": ${reason}`,
});

/**
 * A record is given a key its blueprint does not declare, in its value or by
 * `set`; `key` is its path, e.g. `address.extra`, and `source` the record name.
 * `issues` has every issue found of a value, this one first (not enumerable).
 */
export const UndeclaredRecordProperty = exceptionOf({
	layer: ExceptionLayers.Record,
	name: "UndeclaredRecordProperty",
	message: (
		{ key }: { readonly key: string; readonly issues?: readonly Issue[] },
		source,
	) => `Property "${key}" is not declared in record "${source}".`,
});

/** A blueprint key takes the name of a member of the record; `source` is the record name. */
export const ReservedRecordKey = exceptionOf({
	layer: ExceptionLayers.Record,
	name: "ReservedRecordKey",
	message: ({ key }: { readonly key: string }, source) =>
		`"${key}" is a member of record "${source}" and cannot be a key of its blueprint.`,
});

/**
 * `recordPluginOf` was given what cannot be a plugin: a class not made by
 * `recordOf` (an entity included, as plugins have no identity), an invalid
 * name or version, or a class declaring a member of every record (`toJSON`,
 * `set`...); `source` is the plugin name, `reason` says which.
 */
export const InvalidRecordPlugin = exceptionOf({
	layer: ExceptionLayers.Record,
	name: "InvalidRecordPlugin",
	message: ({ reason }: { readonly reason: string }, source) =>
		`Invalid record plugin "${source}": ${reason}.`,
});

/**
 * A plugin adds a key or a member that the record, or another of its
 * plugins, already has, or two different plugins share a name; `source` is
 * the record name, `plugin` the plugin adding `key`, `owner` who has it.
 */
export const RecordPluginConflict = exceptionOf({
	layer: ExceptionLayers.Record,
	name: "RecordPluginConflict",
	message: (
		{
			plugin,
			key,
			owner,
		}: {
			readonly plugin: string;
			readonly key: string;
			readonly owner: string;
		},
		source,
	) =>
		`Plugin "${plugin}" of record "${source}" adds "${key}", which ${owner} already has.`,
});

/** A catalog has no plugin of the name it is asked for; `source` is the catalog. */
export const UnknownRecordPlugin = exceptionOf({
	layer: ExceptionLayers.Record,
	name: "UnknownRecordPlugin",
	message: ({ name }: { readonly name: string }) =>
		`No record plugin named "${name}" in the catalog.`,
});

/**
 * The plugin of a catalog does not satisfy a reference to it: an older or
 * incompatible version, keys or members it no longer has, or a descriptor
 * that is not one; `source` is the plugin name, `reason` says which.
 */
export const IncompatibleRecordPlugin = exceptionOf({
	layer: ExceptionLayers.Record,
	name: "IncompatibleRecordPlugin",
	message: ({ reason }: { readonly reason: string }, source) =>
		`Record plugin "${source}" does not satisfy the reference: ${reason}.`,
});
