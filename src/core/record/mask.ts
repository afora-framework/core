import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { isRecordClass, recordFieldOf } from "../blueprint/record-field";
import type {
	BlueprintField,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import {
	isBlueprintVariant,
	variantNameOf,
	variantOfValue,
} from "../blueprint/variant";
import { isMarked } from "./marks";

/** What a masked value becomes, whatever its length, so none is told apart. */
export const MASK = "********";

/**
 * `value` with every leaf, at any depth, replaced by `MASK`: strings, numbers,
 * booleans and bigints; `null` and `undefined` as is. A record is masked by
 * its `toJSON`.
 */
function maskAll(value: unknown): unknown {
	if (value === undefined || value === null) return value;
	if (Array.isArray(value)) return Object.freeze(value.map(maskAll));
	// Record keys are prototype getters; metadata is stored under a symbol.
	if (typeof value === "object" && isRecordClass(value.constructor)) {
		return maskAll((value as { toJSON(): unknown }).toJSON());
	}
	if (typeof value === "object") {
		return Object.freeze(
			Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, maskAll(item)]),
			),
		);
	}
	return MASK;
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
			value.map((item) => maskField(field.item, item, false)),
		);
	}
	if (isBlueprint(field) && typeof value === "object" && value !== null) {
		return maskCollection(
			field.properties,
			value as Readonly<Record<string, unknown>>,
		);
	}
	if (isBlueprintVariant(field)) {
		// The key of the variant is kept as it is; the rest is masked by its blueprint.
		const variant = variantOfValue(field, value);
		return variant
			? maskCollection(
					variant.properties,
					value as Readonly<Record<string, unknown>>,
				)
			: value;
	}
	return value;
}

/**
 * `value` of `properties` with the values of the `sensitive` keys and of
 * every property declared `sensitive`, at any depth, masked.
 */
export function maskCollection(
	properties: IBlueprintCollection,
	value: Readonly<Record<string, unknown>>,
	sensitive: readonly string[] = [],
): Readonly<Record<string, unknown>> {
	return Object.freeze(
		Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				maskField(properties[key], item, sensitive.includes(key)),
			]),
		),
	);
}
