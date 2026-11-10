import { blueprintFromProperties } from "../blueprint/blueprint";
import { isRecordClass } from "../blueprint/record-field";
import type {
	AnyBlueprint,
	AnyRecordClass,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { isProperty } from "../property/is-property";
import { IdentifiedRecord } from "../record/plugin";
import { declareRecord, pluginContextOf } from "../record/record";
import type {
	IRecordPluginCatalog,
	RecordPluginContext,
} from "../record/types/plugin.interface";
import {
	AbstractEntity,
	ENTITY_IDENTITY_KEYS,
	ENTITY_MEMBERS,
	ENTITY_VERSION_KEY,
	EntityClock,
	EntityLifetime,
	EntitySettings,
	EntityUniqueKeys,
	EXPIRES_AT,
	RESERVED_ENTITY_KEYS,
} from "./abstract-entity";
import {
	type AnyEntityClass,
	EntityClassBrand,
	EntityEventSettings,
} from "./event";
import {
	ImmutableEntityKey,
	InvalidEntityExpiry,
	ReservedEntityKey,
} from "./exceptions";
import type {
	EntityBuilder,
	EntityBuilderSettings,
	EntityDuration,
	EntityOptions,
	ExpiresAtField,
	IEntityIdentity,
} from "./types/entity.interface";
import { VersionIdentity } from "./version";

/**
 * An `entityOf` that gives every entity the `identity` fields, its ids made
 * by `generateId` and its timestamps by `now`, e.g. the `entityOf` of `std`;
 * `options.plugins` picks from the plugins of `plugins`, catalogs made by
 * `recordPluginCatalogOf`.
 */
export function entityBuilderOf<
	Identity extends IEntityIdentity,
	const Catalogs extends readonly IRecordPluginCatalog[] = [],
>({
	identity,
	generateId,
	now,
	expiresAt,
	plugins: catalogs,
}: EntityBuilderSettings<Identity, Catalogs>): EntityBuilder<
	Identity,
	RecordPluginContext<Catalogs>
> {
	const clock = Object.freeze({ generateId, now });
	const context = pluginContextOf(catalogs ?? []);

	return ((
		blueprint: AnyBlueprint,
		options: EntityOptions<IBlueprintCollection> = {},
	) => {
		const lifetime = lifetimeOf(blueprint, options);
		const expiring = lifetime !== undefined;
		const versioned = options.versioned === true;
		const added = [
			...(versioned ? [ENTITY_VERSION_KEY] : []),
			...(expiring ? [EXPIRES_AT] : []),
		];
		if (expiring && expiresAt === undefined) {
			throw new InvalidEntityExpiry({
				source: options.name ?? "entity",
				details: {
					reason:
						"the entity builder has no expiresAt field, which expires: { after } needs.",
				},
			});
		}
		for (const key of Object.keys(blueprint.properties)) {
			if (RESERVED_ENTITY_KEYS.includes(key) || added.includes(key)) {
				throw new ReservedEntityKey({ source: "entity", details: { key } });
			}
		}
		for (const key of options.change ?? []) {
			if (
				(ENTITY_IDENTITY_KEYS as readonly string[]).includes(key) ||
				added.includes(key)
			) {
				throw new ImmutableEntityKey({ source: "entity", details: { key } });
			}
		}

		const DeclaredEntity = declareRecord(
			AbstractEntity,
			identity.join(
				...(versioned ? [VersionIdentity] : []),
				...(expiring
					? [
							blueprintFromProperties([], {
								[EXPIRES_AT]: expiresAt as ExpiresAtField,
							}),
						]
					: []),
				blueprint,
			),
			{
				...withoutStorage(options),
				unique: ["id", ...(options.unique ?? [])],
			},
			"entity",
			ENTITY_MEMBERS,
			context,
		);
		Object.defineProperty(DeclaredEntity, IdentifiedRecord, { value: true });
		Object.defineProperty(DeclaredEntity, EntityClock, { value: clock });
		Object.defineProperty(DeclaredEntity, EntityClassBrand, { value: true });
		Object.defineProperty(DeclaredEntity, EntityUniqueKeys, {
			value: (
				DeclaredEntity as unknown as AnyRecordClass & {
					readonly options: { readonly unique: readonly string[] };
				}
			).options.unique,
		});

		Object.defineProperty(DeclaredEntity, EntityLifetime, { value: lifetime });
		Object.defineProperty(DeclaredEntity, EntitySettings, {
			value: Object.freeze({
				versioned,
				expires: options.expires,
				schemaVersioned: options.schemaVersion !== undefined,
				schemaVersion: options.schemaVersion ?? 1,
				upgrade: Object.freeze({ ...options.upgrade }),
				previousNames: Object.freeze([...(options.previousNames ?? [])]),
			}),
		});

		Object.defineProperty(DeclaredEntity, EntityEventSettings, {
			value: Object.freeze({
				onCreate: options.onCreate,
				onUpdate: options.onUpdate,
				onDelete: options.onDelete,
			}),
		});

		return DeclaredEntity;
	}) as unknown as EntityBuilder<Identity, RecordPluginContext<Catalogs>>;
}

/** Whether `value` is a class made by `entityOf`, or one extending it. */
export function isEntityClass(
	value: unknown,
): value is AnyRecordClass & AnyEntityClass {
	return isRecordClass(value) && value.prototype instanceof AbstractEntity;
}

/** Whether `value` is an entity, an instance of a class made by `entityOf`. */
export function isEntity(
	value: unknown,
): value is AbstractEntity<IBlueprintCollection> {
	return value instanceof AbstractEntity;
}

/** The record options of `options`, without the storage ones of an entity. */
function withoutStorage(
	options: EntityOptions<IBlueprintCollection>,
): EntityOptions<IBlueprintCollection> {
	const {
		versioned: _versioned,
		expires: _expires,
		schemaVersion: _schemaVersion,
		upgrade: _upgrade,
		previousNames: _previousNames,
		...rest
	} = options;
	return rest;
}

const DURATION_UNITS: Readonly<Record<keyof EntityDuration, number>> = {
	days: 86_400_000,
	hours: 3_600_000,
	minutes: 60_000,
	seconds: 1000,
};

/** Whether `field` holds a date, or a date and time, as an ISO 8601 string. */
function isDateField(field: unknown): boolean {
	if (!isProperty(field)) return false;
	const schema = (
		field as {
			readonly type: {
				readonly schema: { readonly type: { Type(): unknown } };
			};
		}
	).type.schema.type.Type() as {
		readonly type?: unknown;
		readonly format?: unknown;
	};
	return (
		schema.type === "string" &&
		(schema.format === "date-time" || schema.format === "date")
	);
}

/**
 * The milliseconds of `options.expires.after`, `undefined` without one;
 * throws `InvalidEntityExpiry` for an `expires` that is not a duration of
 * positive numbers, nor `at` a date key of `blueprint`.
 */
function lifetimeOf(
	blueprint: AnyBlueprint,
	options: EntityOptions<IBlueprintCollection>,
): number | undefined {
	const { expires } = options;
	if (expires === undefined) return undefined;
	const fail = (reason: string): never => {
		throw new InvalidEntityExpiry({
			source: options.name ?? "entity",
			details: { reason },
		});
	};
	const plain = (value: unknown): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value);
	if (!plain(expires) || Object.keys(expires).length !== 1)
		return fail("expected { after: duration } or { at: key }.");
	if ("at" in expires) {
		const { at } = expires;
		if (typeof at !== "string" || !Object.hasOwn(blueprint.properties, at))
			return fail(`"${String(at)}" is not a key of the blueprint.`);
		if (!isDateField(blueprint.properties[at]))
			return fail(`"${at}" does not hold a date.`);
		return undefined;
	}
	if (!("after" in expires)) {
		return fail("expected { after: duration } or { at: key }.");
	}
	const { after } = expires as { readonly after: unknown };
	if (!plain(after) || Object.keys(after).length === 0)
		return fail("after must be a non-empty duration, e.g. { days: 400 }.");
	let total = 0;
	for (const [unit, amount] of Object.entries(after)) {
		if (!Object.hasOwn(DURATION_UNITS, unit))
			return fail(
				`"${unit}" is not a unit of a duration (days, hours, minutes, seconds).`,
			);
		if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0)
			return fail(`${unit} must be a positive finite number.`);
		total += amount * DURATION_UNITS[unit as keyof EntityDuration];
	}
	return total;
}
