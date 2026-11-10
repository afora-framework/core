import type {
	SchemaChange,
	SchemaChangeClass,
	SchemaChangeKind,
	SchemaLock,
	SchemaLockEntity,
	SchemaLockField,
} from "../repository/types/schema.interface";
import type {
	ApplicationDescription,
	FieldDescription,
	FieldsDescription,
	PropertyDescription,
	PropertyReference,
	RecordDescription,
} from "./types/application.interface";

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** `value` with the keys of every object sorted, and TypeBox's hidden ones (`~kind`) left out. */
function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	if (!isObject(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.filter((key) => !key.startsWith("~") && value[key] !== undefined)
			.sort()
			.map((key) => [key, sorted(value[key])]),
	);
}

/** The keys of a property's lineage that `with` sets for schema evolution. */
interface Evolution {
	fill?: unknown;
	renamedFrom?: string;
}

/** `fill` and `renamedFrom` of a property: the last `with` that set each wins. */
function evolutionOf(
	property: PropertyReference | undefined,
	description: ApplicationDescription,
	found: Evolution = {},
	depth = 0,
): Evolution {
	if (property === undefined || depth > 64) return found;
	const resolved: PropertyDescription | undefined =
		"ref" in property ? description.properties[property.ref] : property;
	const lineage = resolved?.lineage;
	if (lineage === undefined || lineage.kind === "factory") return found;
	if (lineage.kind === "refined") {
		const { fill, renamedFrom } = lineage.options as Evolution;
		if (!("fill" in found) && fill !== undefined) found.fill = fill;
		if (found.renamedFrom === undefined && typeof renamedFrom === "string") {
			found.renamedFrom = renamedFrom;
		}
	}
	return evolutionOf(lineage.base, description, found, depth + 1);
}

/** The fields of a registered record, blueprint or inline one. */
function fieldsOf(
	fields: FieldsDescription | undefined,
	description: ApplicationDescription,
): Readonly<Record<string, SchemaLockField>> | undefined {
	if (fields === undefined) return undefined;
	return Object.fromEntries(
		Object.keys(fields)
			.sort()
			.map((key) => [
				key,
				lockFieldOf(fields[key] as FieldDescription, description),
			]),
	);
}

function lockFieldOf(
	field: FieldDescription,
	description: ApplicationDescription,
): SchemaLockField {
	switch (field.kind) {
		case "property": {
			const property: PropertyDescription | undefined =
				"ref" in field ? description.properties[field.ref] : field;
			const evolution = evolutionOf(
				"ref" in field ? { ref: field.ref } : field,
				description,
			);
			return {
				schema: sorted(property?.schema ?? {}) as Json,
				optional: field.optional,
				...(property?.unique ? { unique: true } : {}),
				...("fill" in evolution ? { fill: sorted(evolution.fill) } : {}),
				...(evolution.renamedFrom === undefined
					? {}
					: { renamedFrom: evolution.renamedFrom }),
			};
		}
		case "list": {
			const item = lockFieldOf(field.item, description);
			return {
				schema: sorted({
					type: "array",
					items: item.schema,
					minItems: field.minItems,
					maxItems: field.maxItems,
				}) as Json,
				optional: field.optional,
				...(item.fields === undefined ? {} : { fields: item.fields }),
			};
		}
		case "blueprint": {
			const fields =
				"ref" in field
					? description.blueprints[field.ref]?.fields
					: field.fields;
			return {
				schema: { type: "object" },
				optional: field.optional,
				fields: fieldsOf(fields, description) ?? {},
			};
		}
		case "record": {
			const fields = description.records[field.ref]?.fields;
			return {
				schema: { type: "object" },
				optional: field.optional,
				fields: fieldsOf(fields, description) ?? {},
			};
		}
		case "entity":
			// Stored as the id of the entity it holds.
			return {
				schema: { entity: field.ref, type: "string" },
				optional: field.optional,
			};
	}
}

function lockEntityOf(
	entity: RecordDescription,
	description: ApplicationDescription,
): SchemaLockEntity {
	const declared = fieldsOf(entity.fields, description) ?? {};
	const unique = new Set(entity.options.unique.filter((key) => key !== "id"));
	for (const [key, field] of Object.entries(declared)) {
		if (field.unique) unique.add(key);
	}
	// A key is unique the same way whether its property or the options say so.
	const fields = Object.fromEntries(
		Object.entries(declared).map(([key, field]) => [
			key,
			unique.has(key) ? { ...field, unique: true } : field,
		]),
	);
	return {
		schemaVersion: entity.schemaVersion ?? 1,
		previousNames: [...(entity.previousNames ?? [])].sort(),
		unique: [...unique].sort(),
		fields,
		...(entity.upgrade === undefined || entity.upgrade.length === 0
			? {}
			: { upgrade: [...entity.upgrade].sort((a, b) => a - b) }),
	};
}

/**
 * The lock of the entities of `description` (`app.describe()`): per entity,
 * its schema version, previous names, unique keys and fields (each with its
 * JSON Schema, whether it is optional or unique, its `fill` and
 * `renamedFrom`, and the fields of a nested blueprint or record), with
 * registered properties, blueprints and records resolved and every key
 * sorted, so equivalent applications give equal locks. The identity keys
 * and the keys of record plugins are left out.
 */
export function schemaLockOf(description: ApplicationDescription): SchemaLock {
	return {
		lockVersion: 1,
		entities: sorted(
			Object.fromEntries(
				Object.keys(description.entities).map((name) => [
					name,
					lockEntityOf(
						description.entities[name] as RecordDescription,
						description,
					),
				]),
			),
		) as SchemaLock["entities"],
	};
}

/** Schema keywords that only document a value. */
const METADATA = new Set([
	"title",
	"description",
	"examples",
	"default",
	"deprecated",
	"readOnly",
	"writeOnly",
	"$comment",
]);

/** Keywords whose larger value accepts more. */
const UPPER = new Set([
	"maximum",
	"exclusiveMaximum",
	"maxLength",
	"maxItems",
	"maxProperties",
]);
/** Keywords whose smaller value accepts more. */
const LOWER = new Set([
	"minimum",
	"exclusiveMinimum",
	"minLength",
	"minItems",
	"minProperties",
]);
/** Keywords whose absence accepts more, and whose other values cannot be compared. */
const NARROWING = new Set([
	"pattern",
	"format",
	"multipleOf",
	"allOf",
	"const",
]);

const same = (a: unknown, b: unknown) =>
	JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** The values a schema accepts as an `enum` or a union of `const`s, if it is one. */
function literalsOf(schema: Json): readonly string[] | undefined {
	if (Array.isArray(schema.enum)) {
		return schema.enum.map((value) => JSON.stringify(value));
	}
	if (
		Array.isArray(schema.anyOf) &&
		schema.anyOf.every((item) => isObject(item) && "const" in item)
	) {
		return schema.anyOf.map((item) => JSON.stringify((item as Json).const));
	}
	return undefined;
}

/**
 * How `next` compares to `previous`: `same`, only `metadata`, `loosened`
 * (accepts at least every value it accepted), `tightened` (the same type,
 * accepting fewer values) or `type-changed` (anything else).
 */
function compareSchemas(
	previous: Json,
	next: Json,
): "same" | "metadata" | "loosened" | "tightened" | "type-changed" {
	if (same(previous, next)) return "same";
	const strip = (schema: Json) =>
		Object.fromEntries(
			Object.entries(schema).filter(([key]) => !METADATA.has(key)),
		);
	const [a, b] = [strip(previous), strip(next)];
	if (same(a, b)) return "metadata";
	if (!same(a.type, b.type) || !same(a.entity, b.entity)) return "type-changed";
	const [before, after] = [literalsOf(a), literalsOf(b)];
	let loosened = false;
	let tightened = false;
	if (before !== undefined || after !== undefined) {
		if (before === undefined || after === undefined) return "type-changed";
		const kept = before.every((value) => after.includes(value));
		const gained = after.some((value) => !before.includes(value));
		if (!kept) tightened = true;
		if (gained) loosened = true;
	}
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) {
		if (["type", "entity", "enum", "anyOf"].includes(key)) continue;
		if (same(a[key], b[key])) continue;
		const [x, y] = [a[key], b[key]];
		if (key === "items") {
			const items = compareSchemas(isObject(x) ? x : {}, isObject(y) ? y : {});
			if (items === "type-changed") return "type-changed";
			if (items === "tightened") tightened = true;
			if (items === "loosened") loosened = true;
		} else if (UPPER.has(key) || LOWER.has(key)) {
			if (x === undefined) tightened = true;
			else if (y === undefined) loosened = true;
			else if (typeof x !== "number" || typeof y !== "number")
				return "type-changed";
			else if (UPPER.has(key) ? y > x : y < x) loosened = true;
			else tightened = true;
		} else if (NARROWING.has(key)) {
			if (y === undefined) loosened = true;
			else tightened = true;
		} else {
			return "type-changed";
		}
	}
	if (tightened) return "tightened";
	return loosened ? "loosened" : "metadata";
}

/** What a field or an entity needs to be satisfied. */
interface Context {
	readonly entity: string;
	readonly from: SchemaLockEntity;
	readonly to: SchemaLockEntity;
	/** Whether `to` has an `upgrade` step to a version above that of `from`. */
	readonly stepped: boolean;
	readonly changes: SchemaChange[];
}

function push(
	context: Context,
	change: SchemaChangeKind,
	klass: SchemaChangeClass,
	satisfied: boolean,
	extra: Partial<
		Pick<SchemaChange, "key" | "from" | "detail" | "destructive">
	> = {},
): void {
	context.changes.push({
		entity: context.entity,
		...(extra.key === undefined ? {} : { key: extra.key }),
		change,
		class: klass,
		satisfied,
		destructive: extra.destructive ?? false,
		...(extra.from === undefined ? {} : { from: extra.from }),
		...(extra.detail === undefined ? {} : { detail: extra.detail }),
	});
}

const STEP = "an upgrade step (bump schemaVersion and add upgrade[n])";

/** The changes from the fields `previous` to `next`, keys prefixed by `path`. */
function diffFields(
	context: Context,
	previous: Readonly<Record<string, SchemaLockField>>,
	next: Readonly<Record<string, SchemaLockField>>,
	path: string,
): void {
	const join = (key: string) => (path ? `${path}.${key}` : key);
	const renamedFrom = new Map<string, string>();
	for (const [key, field] of Object.entries(next)) {
		const from = field.renamedFrom;
		if (
			from !== undefined &&
			!(key in previous) &&
			from in previous &&
			!(from in next)
		) {
			renamedFrom.set(key, from);
		}
	}
	const moved = new Set(renamedFrom.values());
	const keys = [...new Set([...Object.keys(previous), ...Object.keys(next)])]
		.filter((key) => !moved.has(key))
		.sort();
	for (const key of keys) {
		const was = previous[key];
		const is = next[key];
		if (is === undefined) {
			push(context, "removed", "automatic", true, {
				key: join(key),
				destructive: true,
				detail:
					"Left out on read; a backfill removes it only with destructive: true. Rename it with renamedFrom to keep the data.",
			});
			continue;
		}
		const from = renamedFrom.get(key);
		if (from !== undefined) {
			push(context, "renamed", "declared", true, {
				key: join(key),
				from: join(from),
			});
			diffField(context, previous[from] as SchemaLockField, is, join(key));
			continue;
		}
		if (was === undefined) {
			if (is.optional) {
				push(context, "added-optional", "automatic", true, { key: join(key) });
			} else {
				const satisfied = "fill" in is || context.stepped;
				push(context, "added-required", "declared", satisfied, {
					key: join(key),
					...(satisfied
						? {}
						: {
								detail: `Needs a fill (.with({ fill })) or ${STEP} that sets it.`,
							}),
				});
			}
			continue;
		}
		diffField(context, was, is, join(key));
	}
}

/** The changes of one key from `was` to `is`. */
function diffField(
	context: Context,
	was: SchemaLockField,
	is: SchemaLockField,
	key: string,
): void {
	const compared = compareSchemas(was.schema, is.schema);
	if (compared === "type-changed") {
		push(context, "type-changed", "declared", context.stepped, {
			key,
			...(context.stepped
				? {}
				: { detail: `Needs ${STEP} that converts the stored values.` }),
		});
	} else if (compared === "tightened") {
		const satisfied = context.stepped || "fill" in is;
		push(context, "tightened", "declared", satisfied, {
			key,
			detail: satisfied
				? "Run app.migrate({ mode: 'check' }) to list the rows that violate it."
				: `Needs ${STEP} or a fill; app.migrate({ mode: 'check' }) lists the rows that violate it.`,
		});
	} else if (compared === "loosened") {
		push(context, "loosened", "automatic", true, { key });
	} else if (compared === "metadata") {
		push(context, "metadata", "automatic", true, { key });
	}
	if (was.optional && !is.optional) {
		const satisfied = context.stepped || "fill" in is;
		push(context, "made-required", "declared", satisfied, {
			key,
			...(satisfied
				? {}
				: {
						detail: `Needs a fill (.with({ fill })) or ${STEP} for the rows without it.`,
					}),
		});
	} else if (!was.optional && is.optional) {
		push(context, "made-optional", "automatic", true, { key });
	}
	if (!was.unique && is.unique) {
		push(context, "unique-added", "check", true, {
			key,
			detail:
				"Run app.migrate({ mode: 'check' }) and look for duplicates before it is enforced.",
		});
	} else if (was.unique && !is.unique) {
		push(context, "unique-removed", "automatic", true, { key });
	}
	if (was.fields !== undefined || is.fields !== undefined) {
		diffFields(context, was.fields ?? {}, is.fields ?? {}, key);
	}
}

/** The changes of one entity, `from` its lock entry `to` the current one. */
function diffEntity(
	entity: string,
	from: SchemaLockEntity,
	to: SchemaLockEntity,
	changes: SchemaChange[],
): void {
	const stepped =
		to.schemaVersion > from.schemaVersion &&
		(to.upgrade ?? []).some(
			(version) => version > from.schemaVersion && version <= to.schemaVersion,
		);
	const context: Context = { entity, from, to, stepped, changes };
	// Unique keys are marked on their fields, so the fields tell their changes.
	diffFields(context, from.fields, to.fields, "");
}

/**
 * The changes from `lock` to `current` (both made by `schemaLockOf`), each
 * classed as `automatic` (afora handles it: an optional key added, a key
 * removed, a constraint loosened, metadata), `declared` (it needs a `fill`,
 * a `renamedFrom`, `previousNames` or an `upgrade` step to a version above
 * the lock's; `satisfied` says whether the code has it) or `check` (a new
 * unique key: the stored rows must be checked first). `destructive` marks
 * what deletes stored data once applied: a removed key, the rows of a
 * previous name, a removed entity. Nested blueprints and records are
 * compared key by key. Ordered by entity name, then key.
 */
export function diffSchemas(
	lock: SchemaLock,
	current: SchemaLock,
): readonly SchemaChange[] {
	const changes: SchemaChange[] = [];
	const claimed = new Set<string>();
	for (const name of Object.keys(current.entities).sort()) {
		const to = current.entities[name] as SchemaLockEntity;
		let from = lock.entities[name];
		if (from === undefined) {
			const previous = to.previousNames.find(
				(old) => lock.entities[old] !== undefined && !current.entities[old],
			);
			if (previous === undefined) {
				changes.push({
					entity: name,
					change: "entity-added",
					class: "automatic",
					satisfied: true,
					destructive: false,
				});
				continue;
			}
			claimed.add(previous);
			from = lock.entities[previous] as SchemaLockEntity;
			changes.push({
				entity: name,
				change: "entity-renamed",
				class: "declared",
				satisfied: true,
				destructive: true,
				from: previous,
				detail:
					"app.migrate moves its rows; it removes them from the previous name only with destructive: true.",
			});
		}
		diffEntity(name, from, to, changes);
	}
	for (const name of Object.keys(lock.entities).sort()) {
		if (current.entities[name] !== undefined || claimed.has(name)) continue;
		changes.push({
			entity: name,
			change: "entity-removed",
			class: "declared",
			satisfied: false,
			destructive: true,
			detail: `No entity is named "${name}": list it in the previousNames of the entity that replaces it, or remove it from the lock if it is gone.`,
		});
	}
	return changes;
}

/**
 * Why the code cannot run over the stores `lock` describes: an entity of
 * the lock that no entity is named, or lists in its `previousNames`, or an
 * entity whose `schemaVersion` is lower than the lock's. Empty when it can.
 */
export function schemaLockProblemsOf(
	lock: SchemaLock,
	current: SchemaLock,
): readonly string[] {
	const problems: string[] = [];
	const renamed = new Map<string, string>();
	for (const [name, entity] of Object.entries(current.entities)) {
		for (const old of entity.previousNames) {
			if (!renamed.has(old)) renamed.set(old, name);
		}
	}
	for (const name of Object.keys(lock.entities).sort()) {
		const locked = lock.entities[name] as SchemaLockEntity;
		const now = current.entities[name] === undefined ? renamed.get(name) : name;
		const entity = now === undefined ? undefined : current.entities[now];
		if (entity === undefined) {
			problems.push(
				`The lock holds the entity "${name}", which no entity is named or lists in previousNames.`,
			);
		} else if (entity.schemaVersion < locked.schemaVersion) {
			problems.push(
				`The schemaVersion of "${now}" (${entity.schemaVersion}) is lower than the lock's (${locked.schemaVersion}).`,
			);
		}
	}
	return problems;
}
