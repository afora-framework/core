import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { isRecordClass, recordFieldOf } from "../blueprint/record-field";
import { blueprintSourcesOf } from "../blueprint/sources";
import type {
	BlueprintField,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import {
	isBlueprintVariant,
	variantNameOf,
	variantOfValue,
} from "../blueprint/variant";
import { MAX_VALUE_DEPTH } from "../parse/depth";
import { isMarked } from "./marks";

/** What a masked value becomes, whatever its length, so none is told apart. */
export const MASK = "********";

/** The keys each record declares `sensitive`, by the blueprint of the record. */
const sensitiveByBlueprint = new WeakMap<object, readonly string[]>();

/**
 * Notes that a record of `blueprint` declares the `sensitive` keys, so that
 * a value of that blueprint outside the record (a use case response) is
 * masked the same way. A blueprint shared by records gets the keys of each.
 */
export function markSensitiveKeys(
	blueprint: object,
	sensitive: readonly string[],
): void {
	if (sensitive.length === 0) return;
	const known = sensitiveByBlueprint.get(blueprint) ?? [];
	sensitiveByBlueprint.set(blueprint, [...new Set([...known, ...sensitive])]);
}

/**
 * The keys the records of `blueprint` declare `sensitive`, which a value of
 * it is masked by outside them (none when no record is of it): also those of
 * the blueprints it was derived from (`optionalOf`, `join`, `sliceOf`)
 * that it still has.
 * @internal
 */
export function sensitiveKeysOf(blueprint: object): readonly string[] {
	const own = sensitiveByBlueprint.get(blueprint) ?? [];
	const sources = blueprintSourcesOf(blueprint);
	if (sources.length === 0) return own;
	const properties =
		(blueprint as { readonly properties?: object }).properties ?? {};
	const inherited = sources
		.flatMap(sensitiveKeysOf)
		.filter((key) => Object.hasOwn(properties, key));
	return inherited.length === 0 ? own : [...new Set([...own, ...inherited])];
}

/**
 * `value` with every leaf, at any depth, replaced by `MASK`: strings, numbers,
 * booleans and bigints; `null` and `undefined` as is. A record is masked by
 * its `toJSON`. An object or a list deeper than `MAX_VALUE_DEPTH` (which a
 * record keeps only inside an object of a class) is one `MASK`, so the walk
 * stays within the stack.
 */
function maskAll(value: unknown, depth = 0): unknown {
	if (value === undefined || value === null) return value;
	if (typeof value !== "object") return MASK;
	if (depth >= MAX_VALUE_DEPTH) return MASK;
	const next = depth + 1;
	if (Array.isArray(value)) {
		return Object.freeze(value.map((item) => maskAll(item, next)));
	}
	// Record keys are prototype getters; metadata is stored under a symbol.
	if (isRecordClass(value.constructor)) {
		return maskAll((value as { toJSON(): unknown }).toJSON(), depth);
	}
	return Object.freeze(
		Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, maskAll(item, next)]),
		),
	);
}

/**
 * `value` of `field` with what is sensitive masked: everything when
 * `sensitive`, a property declared `sensitive` always, at any depth of
 * blueprints, lists and variants. A record gives its `toJSON`, masked by its own options.
 */
function maskField(
	field: BlueprintField | undefined,
	value: unknown,
	sensitive: boolean,
	byBlueprint = false,
): unknown {
	if (value === undefined) return value;
	if (isBlueprintVariant(field)) {
		// A record of one of its classes gives its `toJSON` with the key first.
		const name = variantNameOf(field, value);
		if (name !== undefined) {
			const json = Object.freeze({
				[field.key]: name,
				...(value as { toJSON(): object }).toJSON(),
			});
			return sensitive ? maskAll(json) : json;
		}
	}
	if (recordFieldOf(field)) {
		const json = (value as { toJSON(): unknown }).toJSON();
		return sensitive ? maskAll(json) : json;
	}
	if (sensitive || isMarked(field, "sensitive")) return maskAll(value);
	if (isBlueprintList(field) && Array.isArray(value)) {
		return Object.freeze(
			value.map((item) => maskField(field.item, item, false, byBlueprint)),
		);
	}
	if (isBlueprint(field) && typeof value === "object" && value !== null) {
		// A record has no keys of its own: it is read by its `toJSON`.
		const plain = isRecordClass(value.constructor)
			? (value as { toJSON(): unknown }).toJSON()
			: value;
		return maskCollection(
			field.properties,
			plain as Readonly<Record<string, unknown>>,
			byBlueprint ? sensitiveKeysOf(field) : undefined,
			byBlueprint,
		);
	}
	if (isBlueprintVariant(field)) {
		// The key of the variant is kept as it is; the rest is masked by its blueprint.
		const variant = variantOfValue(field, value);
		return variant
			? maskCollection(
					variant.properties,
					value as Readonly<Record<string, unknown>>,
					byBlueprint ? sensitiveKeysOf(variant) : undefined,
					byBlueprint,
				)
			: value;
	}
	return value;
}

/**
 * `value` of `properties` with the values of the `sensitive` keys and of
 * every property declared `sensitive`, at any depth, masked. With
 * `byBlueprint`, a nested blueprint of a record also masks the keys that
 * record declares `sensitive`.
 */
export function maskCollection(
	properties: IBlueprintCollection,
	value: Readonly<Record<string, unknown>>,
	sensitive: readonly string[] = [],
	byBlueprint = false,
): Readonly<Record<string, unknown>> {
	return Object.freeze(
		Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				maskField(properties[key], item, sensitive.includes(key), byBlueprint),
			]),
		),
	);
}

/**
 * `value` of `field` (a blueprint or a list) as it may leave the process:
 * every property declared `sensitive` (a `Password`) masked at any depth of
 * blueprints, lists and variants, records by their `toJSON`, and the keys a
 * record declares `sensitive` where the blueprint is the one of that record.
 */
export function maskValueOf(field: BlueprintField, value: unknown): unknown {
	return maskField(field, value, false, true);
}
