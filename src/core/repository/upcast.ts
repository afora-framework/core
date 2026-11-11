import { fieldOf } from "../blueprint/callable";
import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { recordFieldOf } from "../blueprint/record-field";
import type {
	BlueprintField,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { EntitySettings, SCHEMA_VERSION_KEY } from "../entity/abstract-entity";
import { isEntityClass } from "../entity/entity";
import type {
	EntityStorageSettings,
	EntityUpgrades,
} from "../entity/types/entity.interface";
import { isProperty } from "../property/is-property";
import {
	InvalidRepositoryData,
	InvalidStoredSchemaVersion,
} from "./exceptions";
import type { RepositoryState } from "./state";
import type { RepositoryData } from "./types/repository.interface";

type Plain = Record<string, unknown>;

/** What happens to the value of one key of a collection. */
type FieldStep =
	| {
			readonly kind: "property";
			readonly fill?: unknown;
			readonly renamedFrom?: string;
	  }
	| { readonly kind: "collection"; readonly fields: CollectionSteps }
	| { readonly kind: "list"; readonly item: FieldStep }
	| { readonly kind: "opaque" };

/** The steps of the keys of a blueprint, and whether any of them does something. */
interface CollectionSteps {
	readonly fields: ReadonlyMap<string, FieldStep>;
}

/** How the rows of an entity are brought up to its current shape. */
export interface UpcastPlan {
	readonly versioned: boolean;
	readonly version: number;
	/** Whether the entity lists `previousNames`: its moved rows may hold old keys. */
	readonly renamed: boolean;
	readonly upgrade: EntityUpgrades;
	readonly fields: CollectionSteps;
}

/** What `upcast` did to a row, for `app.migrate`. */
export interface UpcastReport {
	/** The version the row was stored at (1 without the version key). */
	from: number;
	/** Paths of the keys moved from their `renamedFrom`. */
	readonly renamed: string[];
	/** Paths of the keys given their `fill`. */
	readonly filled: string[];
	/** Paths of the keys the blueprint no longer declares. */
	readonly removed: string[];
}

const isPlain = (value: unknown): value is Plain =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function stepOf(field: BlueprintField | undefined): FieldStep {
	if (field === undefined) return { kind: "opaque" };
	if (isBlueprintList(field)) return { kind: "list", item: stepOf(field.item) };
	if (isBlueprint(field)) {
		return { kind: "collection", fields: stepsOf(field.properties) };
	}
	const record = recordFieldOf(field);
	if (record) {
		// An entity is stored by its id: its rows are its own repository's.
		if (isEntityClass(record.record)) return { kind: "opaque" };
		return {
			kind: "collection",
			fields: stepsOf(
				(record.record as { blueprint: { properties: IBlueprintCollection } })
					.blueprint.properties,
			),
		};
	}
	const property = fieldOf(field);
	if (!isProperty(property)) return { kind: "opaque" };
	const { fill, renamedFrom } = property.type as {
		readonly fill?: unknown;
		readonly renamedFrom?: string;
	};
	return {
		kind: "property",
		...(fill === undefined ? {} : { fill }),
		...(renamedFrom === undefined ? {} : { renamedFrom }),
	};
}

function stepsOf(properties: IBlueprintCollection): CollectionSteps {
	return {
		fields: new Map(
			Object.entries(properties).map(([key, field]) => [key, stepOf(field)]),
		),
	};
}

/** Whether any key of `steps`, at any depth, has a `fill` or a `renamedFrom`. */
function declaresSteps(steps: CollectionSteps): boolean {
	const visit = (step: FieldStep): boolean => {
		switch (step.kind) {
			case "property":
				return step.fill !== undefined || step.renamedFrom !== undefined;
			case "collection":
				return declaresSteps(step.fields);
			case "list":
				return visit(step.item);
			case "opaque":
				return false;
		}
	};
	for (const step of steps.fields.values()) if (visit(step)) return true;
	return false;
}

const plans = new WeakMap<object, UpcastPlan | null>();

/**
 * How the rows of `entity` are brought up to its current shape, or
 * `undefined` when they are read as they are: it declares no
 * `schemaVersion`, no `previousNames` and no key with `fill` or
 * `renamedFrom`. Cached.
 */
function upcastPlanOf(entity: object): UpcastPlan | undefined {
	const cached = plans.get(entity);
	if (cached !== undefined) return cached ?? undefined;
	const plan = fullUpcastPlanOf(entity);
	const needed =
		plan.versioned || plan.renamed || declaresSteps(plan.fields) ? plan : null;
	plans.set(entity, needed);
	return needed ?? undefined;
}

/** The plan of `entity`, even when it changes nothing but the keys it no longer declares. */
export function fullUpcastPlanOf(entity: object): UpcastPlan {
	const settings = (
		entity as { readonly [EntitySettings]?: EntityStorageSettings }
	)[EntitySettings];
	return {
		versioned: settings?.schemaVersioned === true,
		version: settings?.schemaVersion ?? 1,
		renamed: (settings?.previousNames.length ?? 0) > 0,
		upgrade: settings?.upgrade ?? {},
		fields: stepsOf(
			(entity as { blueprint: { properties: IBlueprintCollection } }).blueprint
				.properties,
		),
	};
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

/** A copy of a fill value, so rows never share an object. */
const fillOf = (value: unknown) =>
	typeof value === "object" && value !== null ? structuredClone(value) : value;

/**
 * `value`, of a collection of `steps`: keys moved from their `renamedFrom`,
 * missing ones given their `fill`, and, with `drop`, those it no longer
 * declares left out. Nested blueprints and records are walked into.
 */
function applySteps(
	steps: CollectionSteps,
	value: Plain,
	drop: boolean,
	path: string,
	report: UpcastReport | undefined,
): Plain {
	const result: Plain = { ...value };
	for (const [key, step] of steps.fields) {
		if (step.kind !== "property" || step.renamedFrom === undefined) continue;
		const from = step.renamedFrom;
		if (result[key] === undefined && Object.hasOwn(result, from)) {
			result[key] = result[from];
			delete result[from];
			report?.renamed.push(join(path, key));
		}
	}
	for (const [key, step] of steps.fields) {
		const current = result[key];
		if (current === undefined || current === null) {
			if (
				step.kind === "property" &&
				step.fill !== undefined &&
				current === undefined
			) {
				result[key] = fillOf(step.fill);
				report?.filled.push(join(path, key));
			}
			continue;
		}
		result[key] = applyField(step, current, drop, join(path, key), report);
	}
	for (const key of Object.keys(result)) {
		if (steps.fields.has(key)) continue;
		if (result[key] !== undefined) report?.removed.push(join(path, key));
		if (drop) delete result[key];
	}
	return result;
}

function applyField(
	step: FieldStep,
	value: unknown,
	drop: boolean,
	path: string,
	report: UpcastReport | undefined,
): unknown {
	switch (step.kind) {
		case "collection":
			return isPlain(value)
				? applySteps(step.fields, value, drop, path, report)
				: value;
		case "list":
			return Array.isArray(value)
				? value.map((item) =>
						item === undefined || item === null
							? item
							: applyField(step.item, item, drop, `${path}[]`, report),
					)
				: value;
		default:
			return value;
	}
}

/** The schema version `data` was stored at: its version key, 1 without one. */
function storedVersionOf(data: RepositoryData): unknown {
	return Object.hasOwn(data, SCHEMA_VERSION_KEY) ? data[SCHEMA_VERSION_KEY] : 1;
}

/**
 * `data`, a row of an entity of `plan` as a provider gave it, in the current
 * shape: without the version key, through each `upgrade` step from the
 * version after the stored one up to `schemaVersion`, then the automatic
 * steps of the current blueprint (`renamedFrom`, `fill`, and, with `drop`,
 * leaving out keys it no longer declares). The steps run first because each
 * is written against the shape of the version before it, which the
 * automatic steps would already have changed. Throws
 * `InvalidStoredSchemaVersion` for a version that is not a positive integer
 * or is above `schemaVersion`.
 */
export function upcast(
	source: string,
	plan: UpcastPlan,
	data: RepositoryData,
	drop = true,
	report?: UpcastReport,
): RepositoryData {
	const stored = storedVersionOf(data);
	if (
		typeof stored !== "number" ||
		!Number.isSafeInteger(stored) ||
		stored < 1 ||
		stored > plan.version
	) {
		throw new InvalidStoredSchemaVersion({
			source,
			details: { id: String(data.id), stored, current: plan.version },
		});
	}
	if (report) report.from = stored;
	let value: Plain = { ...data };
	delete value[SCHEMA_VERSION_KEY];
	for (let version = stored + 1; version <= plan.version; version++) {
		const step = plan.upgrade[version];
		if (step === undefined) continue;
		const next = step(Object.freeze(value));
		if (!isPlain(next)) {
			throw new InvalidStoredSchemaVersion({
				source,
				details: {
					id: String(data.id),
					stored,
					current: plan.version,
					reason: `The upgrade step ${version} did not give an object.`,
				},
			});
		}
		value = { ...next };
		delete value[SCHEMA_VERSION_KEY];
	}
	return applySteps(plan.fields, value, drop, "", report);
}

/**
 * `rows` of `state`'s entity in its current shape (see `upcast`); `rows`
 * itself when the entity needs nothing. Throws `InvalidRepositoryData`
 * caused by `InvalidStoredSchemaVersion` for a row it cannot bring up.
 */
export function upcastRows(
	state: RepositoryState,
	rows: readonly RepositoryData[],
): readonly RepositoryData[] {
	const plan = upcastPlanOf(state.entity);
	if (plan === undefined) return rows;
	return rows.map((row) => {
		try {
			return upcast(state.name, plan, row);
		} catch (error) {
			throw new InvalidRepositoryData({ source: state.name, cause: error });
		}
	});
}

/** `data` with the version key of `state`'s entity, when it declares `schemaVersion`. */
export function withSchemaVersion(
	entity: object,
	data: RepositoryData,
): RepositoryData {
	const plan = upcastPlanOf(entity);
	return plan?.versioned
		? { ...data, [SCHEMA_VERSION_KEY]: plan.version }
		: data;
}
