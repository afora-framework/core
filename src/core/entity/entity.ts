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
	EntityClock,
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
		for (const key of Object.keys(blueprint.properties)) {
			if (RESERVED_ENTITY_KEYS.includes(key)) {
				throw new ReservedEntityKey({ source: "entity", details: { key } });
			}
		}
		for (const key of options.change ?? []) {
			if ((ENTITY_IDENTITY_KEYS as readonly string[]).includes(key)) {
				throw new ImmutableEntityKey({ source: "entity", details: { key } });
			}
		}

		const DeclaredEntity = declareRecord(
			AbstractEntity,
			identity.join(blueprint),
			{ ...options, unique: ["id", ...(options.unique ?? [])] },
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
