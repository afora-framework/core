import { isRecordClass } from "../blueprint/record-field";
import type {
	AnyBlueprint,
	AnyRecordClass,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
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
	EntitySettings,
	EntityUniqueKeys,
	RESERVED_ENTITY_KEYS,
} from "./abstract-entity";
import {
	type AnyEntityClass,
	EntityClassBrand,
	EntityEventSettings,
} from "./event";
import { ImmutableEntityKey, ReservedEntityKey } from "./exceptions";
import type {
	EntityBuilder,
	EntityBuilderSettings,
	EntityOptions,
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
		const versioned = options.versioned === true;
		const identityKeys: readonly string[] = versioned
			? [...ENTITY_IDENTITY_KEYS, ENTITY_VERSION_KEY]
			: ENTITY_IDENTITY_KEYS;
		for (const key of Object.keys(blueprint.properties)) {
			if (
				RESERVED_ENTITY_KEYS.includes(key) ||
				(versioned && key === ENTITY_VERSION_KEY)
			) {
				throw new ReservedEntityKey({ source: "entity", details: { key } });
			}
		}
		for (const key of options.change ?? []) {
			if (identityKeys.includes(key)) {
				throw new ImmutableEntityKey({ source: "entity", details: { key } });
			}
		}

		const DeclaredEntity = declareRecord(
			AbstractEntity,
			versioned
				? identity.join(VersionIdentity, blueprint)
				: identity.join(blueprint),
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

		Object.defineProperty(DeclaredEntity, EntitySettings, {
			value: Object.freeze({
				versioned,
				expires: options.expires,
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
	const { versioned: _versioned, expires: _expires, ...rest } = options;
	return rest;
}
