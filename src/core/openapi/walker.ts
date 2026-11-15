import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { isRecordClass, recordFieldOf } from "../blueprint/record-field";
import type {
	AnyRecordClass,
	BlueprintField,
	BlueprintVariants,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { isBlueprintVariant } from "../blueprint/variant";
import { identityKeysOf } from "../entity/abstract-entity";
import { isEntityClass } from "../entity/entity";
import { isProperty } from "../property/is-property";
import { recordNameOf } from "../record/name";
import { rawTypeOf } from "../schema/schema";
import { InvalidOpenAPIModel } from "./exceptions";

/**
 * The walker behind `toOpenAPI` and `jsonSchemaOf`: the schema of any field,
 * in one of two dialects.
 * @internal
 */
export type Schema = Record<string, unknown>;

/**
 * What generating a schema needs: the dialect, the records named among the
 * models, and where they are.
 * - `"openapi"`: a variant names its key in a `discriminator`, and a record
 *   not named among the models is written inline.
 * - `"json-schema"`: no `discriminator` (not a JSON Schema keyword), a
 *   read-only key (the identity of an entity) is not `required`, and every
 *   record not named, and every schema of a property with an `$id`, is added
 *   to `defs` under its name, once, and referenced from there.
 * @internal
 */
export interface Scope {
	readonly dialect: "openapi" | "json-schema";
	readonly names: ReadonlyMap<AnyRecordClass, string>;
	readonly prefix: string;
	/**
	 * The definitions of `"json-schema"` so far: by record class, and by the
	 * `$id` of a schema (whose `$ref`s are rewritten to the definition once
	 * the walk is done, by `refsToDefs`).
	 */
	readonly defs?: Map<AnyRecordClass | string, Definition>;
}

/** Keys a record marks on its own: sensitive ones, and the identity of an entity. */
interface Marks {
	readonly writeOnly: readonly string[];
	readonly readOnly: readonly string[];
}

/** A definition under `$defs`: its name, and its schema once walked. */
export interface Definition {
	readonly name: string;
	schema?: Schema;
}

const NO_MARKS: Marks = { writeOnly: [], readOnly: [] };

/** Whether `value` is any blueprint field. */
export function isField(value: unknown): value is BlueprintField {
	return (
		isProperty(value) ||
		isBlueprint(value) ||
		isBlueprintList(value) ||
		isBlueprintVariant(value) ||
		recordFieldOf(value) !== undefined
	);
}

/** Whether `field`, as a key of a blueprint, accepts `undefined`. */
function isOptional(field: BlueprintField): boolean {
	if (isProperty(field)) return field.type.optional === true;
	if (
		isBlueprint(field) ||
		isBlueprintList(field) ||
		isBlueprintVariant(field)
	) {
		return field.optional;
	}
	return recordFieldOf(field)?.optional ?? false;
}

/**
 * A plain copy of a TypeBox schema, without its hidden `~` keys; a nested
 * schema with an `$id` (e.g. the JSON Schema meta-schema) becomes a `$ref` to it.
 */
export function plainOf(value: unknown, nested = false): unknown {
	if (Array.isArray(value)) return value.map((item) => plainOf(item, true));
	if (typeof value !== "object" || value === null) return value;

	const id = (value as { $id?: unknown }).$id;
	if (nested && typeof id === "string") return { $ref: id };

	const plain: Schema = {};
	for (const [key, item] of Object.entries(value)) {
		if (!key.startsWith("~")) plain[key] = plainOf(item, true);
	}
	return plain;
}

/** The object schema of `properties`, every key closed, as blueprints reject undeclared ones. */
function objectOf(
	properties: IBlueprintCollection,
	scope: Scope,
	marks: Marks,
): Schema {
	const shape: Record<string, Schema> = {};
	const required: string[] = [];

	for (const [key, field] of Object.entries(properties)) {
		const schema = schemaOf(field, scope);
		if (marks.readOnly.includes(key)) schema.readOnly = true;
		if (marks.writeOnly.includes(key)) schema.writeOnly = true;
		shape[key] = schema;
		// What the server sets is not asked of who writes the value.
		const readOnly = scope.dialect === "json-schema" && schema.readOnly;
		if (!isOptional(field) && !readOnly) required.push(key);
	}

	return {
		type: "object",
		properties: shape,
		...(required.length > 0 ? { required } : {}),
		additionalProperties: false,
	};
}

/** The schema of the blueprint of `record`, its sensitive keys write-only and an entity's identity read-only. */
export function recordSchemaOf(record: AnyRecordClass, scope: Scope): Schema {
	const { sensitive = [] } =
		(
			record as {
				readonly options?: { readonly sensitive?: readonly string[] };
			}
		).options ?? {};
	return objectOf(record.blueprint.properties, scope, {
		writeOnly: sensitive,
		readOnly: isEntityClass(record) ? identityKeysOf(record) : [],
	});
}

/**
 * The name `record` is defined under in `scope.defs`, adding it the first
 * time (a second record of the same name gets a number: `Name2`...);
 * `undefined` when the scope keeps no definitions.
 */
function defined(record: AnyRecordClass, scope: Scope): string | undefined {
	const { defs } = scope;
	if (defs === undefined) return undefined;
	return define(defs, record, recordNameOf(record), () =>
		recordSchemaOf(record, scope),
	);
}

/**
 * The name `key` is defined under in `defs`, adding it the first time with
 * the schema `walk` gives, under `base` or, when taken, `base2`...
 */
function define(
	defs: Map<AnyRecordClass | string, Definition>,
	key: AnyRecordClass | string,
	base: string,
	walk: () => Schema,
): string {
	const known = defs.get(key);
	if (known) return known.name;

	const taken = new Set([...defs.values()].map(({ name }) => name));
	let name = base;
	for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
	// Named before it is walked, so a schema that holds itself is a `$ref`.
	const entry: Definition = { name };
	defs.set(key, entry);
	entry.schema = walk();
	return name;
}

/** Whether `id` is a schema of JSON Schema itself, which every validator knows. */
function isMetaSchema(id: string): boolean {
	return /^https?:\/\/json-schema\.org\//.test(id);
}

/**
 * `plainOf` for `"json-schema"`: a schema with an `$id`, at any depth, is
 * defined once in `defs`, without its `$id`, and is a `$ref` to its `$id`
 * here, which `refsToDefs` points at the definition.
 */
function hoistedOf(
	value: unknown,
	defs: Map<AnyRecordClass | string, Definition>,
): unknown {
	if (Array.isArray(value)) return value.map((item) => hoistedOf(item, defs));
	if (typeof value !== "object" || value === null) return value;

	const id = (value as { $id?: unknown }).$id;
	if (typeof id === "string") {
		if (isMetaSchema(id)) return { $ref: id };
		define(defs, id, id.replace(/[^A-Za-z0-9_-]+/g, "_") || "Schema", () =>
			copyOf(value, defs, true),
		);
		return { $ref: id };
	}
	return copyOf(value, defs, false);
}

/** A plain copy of `value`, without its `~` keys, and without `$id` when `dropId`. */
function copyOf(
	value: object,
	defs: Map<AnyRecordClass | string, Definition>,
	dropId: boolean,
): Schema {
	const plain: Schema = {};
	for (const [key, item] of Object.entries(value)) {
		if (key.startsWith("~") || (dropId && key === "$id")) continue;
		plain[key] = hoistedOf(item, defs);
	}
	return plain;
}

/**
 * `schema` with every `$ref` to the `$id` of a definition in `defs` pointing
 * at it, as `prefix` and its name, in place.
 */
export function refsToDefs(
	schema: unknown,
	defs: ReadonlyMap<AnyRecordClass | string, Definition>,
	prefix: string,
): void {
	if (typeof schema !== "object" || schema === null) return;
	if (Array.isArray(schema)) {
		for (const item of schema) refsToDefs(item, defs, prefix);
		return;
	}
	const target = schema as Schema;
	if (typeof target.$ref === "string") {
		const definition = defs.get(target.$ref);
		if (definition) target.$ref = `${prefix}${definition.name}`;
	}
	for (const item of Object.values(target)) refsToDefs(item, defs, prefix);
}

/** The schema of `field`; a record named among the models is a `$ref`. */
export function schemaOf(field: BlueprintField, scope: Scope): Schema {
	if (isBlueprintList(field)) {
		const { item, minItems, maxItems } = field;
		return {
			type: "array",
			items: schemaOf(item, scope),
			...(minItems === undefined ? {} : { minItems }),
			...(maxItems === undefined ? {} : { maxItems }),
		};
	}
	if (isBlueprint(field)) return objectOf(field.properties, scope, NO_MARKS);
	if (isBlueprintVariant(field)) {
		// One object per variant, with the key first as its name, and the key
		// declared as what tells them apart.
		const variants: BlueprintVariants = field.variants;
		return {
			oneOf: Object.entries(variants).map(([tag, variant]) => {
				// A record class is written out here, not as a `$ref`: it has the key too.
				const object = (
					isRecordClass(variant)
						? recordSchemaOf(variant, scope)
						: objectOf(variant.properties, scope, NO_MARKS)
				) as {
					readonly properties: Record<string, Schema>;
					readonly required?: readonly string[];
				};
				return {
					...object,
					properties: { [field.key]: { const: tag }, ...object.properties },
					required: [field.key, ...(object.required ?? [])],
				};
			}),
			...(scope.dialect === "openapi"
				? { discriminator: { propertyName: field.key } }
				: {}),
		};
	}

	const record = recordFieldOf(field);
	if (record) {
		const name =
			scope.names.get(record.record) ?? defined(record.record, scope);
		return name === undefined
			? recordSchemaOf(record.record, scope)
			: { $ref: `${scope.prefix}${name}` };
	}

	if (!isProperty(field)) {
		throw new InvalidOpenAPIModel({
			source: "openapi",
			details: { name: String(field) },
		});
	}
	const raw = rawTypeOf(field.type.schema);
	const schema = (
		scope.defs === undefined ? plainOf(raw) : hoistedOf(raw, scope.defs)
	) as Schema;
	if (field.type.sensitive) schema.writeOnly = true;
	return schema;
}
