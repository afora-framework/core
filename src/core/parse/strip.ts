import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { recordFieldOf } from "../blueprint/record-field";
import type {
	AnyBlueprint,
	AnyRecordClass,
	BlueprintField,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { fieldsOf, isPlainObject } from "./parse";

/** A copy of `value` with only the keys `properties` declares, each stripped by its field. */
function collectionOf(
	properties: IBlueprintCollection,
	value: unknown,
): unknown {
	if (!isPlainObject(value)) return value;

	const kept: Record<string, unknown> = {};
	for (const [name, field] of fieldsOf(properties)) {
		if (!Object.hasOwn(value, name)) continue;
		const item = fieldOf(field, value[name]);
		if (item === undefined) continue;
		// `defineProperty`, so a declared `__proto__` stays a key, not a prototype.
		Object.defineProperty(kept, name, {
			value: item,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return kept;
}

/** `value` stripped by `field`; returned as it is where `field` has no keys to keep. */
function fieldOf(field: BlueprintField | undefined, value: unknown): unknown {
	if (isBlueprintList(field)) {
		return Array.isArray(value)
			? value.map((item) => fieldOf(field.item, item))
			: value;
	}
	if (isBlueprint(field)) return collectionOf(field.properties, value);

	const record = recordFieldOf(field);
	if (record) {
		// An instance is kept: its keys were checked when it was made.
		return collectionOf(record.record.blueprint.properties, value);
	}

	return value;
}

/**
 * A copy of `value` without the keys `shape` does not declare, at any depth:
 * in nested blueprints, the items of `listOf`, `optionalOf` and the records
 * and entities held as fields. For a payload with more than the operation
 * reads, such as a webhook from another service, before it is parsed, since
 * parsing rejects an undeclared key (`undeclared_key`).
 *
 * It does not validate, never throws and does not change `value`: a value of
 * the wrong type, a property's value (even an object) and a record instance
 * come back as they are, for parsing to accept or reject.
 */
export function stripUndeclared(
	shape: AnyBlueprint | AnyRecordClass | BlueprintField,
	value: unknown,
): unknown {
	return fieldOf(shape as BlueprintField, value);
}
