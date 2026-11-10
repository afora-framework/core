import type {
	BlueprintInput,
	BlueprintValue,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import {
	AbstractRecord,
	runRecordEffects,
	storeRecordValue,
} from "../record/abstract-record";
import { recordNameOf } from "../record/name";
import { Meta } from "../symbols/meta";
import {
	type EntityEvent,
	type EventDefinition,
	enqueueEvent,
	enqueueLifecycle,
	pullEntityEvents,
} from "./event";
import { DeletedEntity, ImmutableEntityKey } from "./exceptions";
import type {
	EntityIdentityKey,
	EntityStorageSettings,
} from "./types/entity.interface";

/** The keys every entity has, which only the entity itself changes. */
export const ENTITY_IDENTITY_KEYS: readonly EntityIdentityKey[] = Object.freeze(
	["id", "createdAt", "updatedAt", "deletedAt"] as const,
);

/** The members an entity adds to a record, which no key of its blueprint can take. */
export const ENTITY_MEMBERS: readonly string[] = Object.freeze([
	"destroy",
	"isDeleted",
	"equals",
	"onDestroy",
	"emit",
	"pullEvents",
]);

/** The names no key of the blueprint of an entity can take: its identity and its members. */
export const RESERVED_ENTITY_KEYS: readonly string[] = Object.freeze([
	...ENTITY_IDENTITY_KEYS,
	...ENTITY_MEMBERS,
]);

/** How the entities of a class make their id and timestamps, set by `entityOf`. */
export const EntityClock = Symbol("entityClock");

/** The unique keys of a class made by `entityOf`, as `options.unique` lists them. */
export const EntityUniqueKeys = Symbol("entityUniqueKeys");
/** The storage options of an entity class (`versioned`, `expires`). */
export const EntitySettings = Symbol("entitySettings");

/** The key a versioned entity adds to its identity. */
export const ENTITY_VERSION_KEY = "version";

/** The storage settings of an entity class; `undefined` for any other value. */
function entitySettingsOf(
	entityClass: unknown,
): EntityStorageSettings | undefined {
	if (typeof entityClass !== "function") return undefined;
	return (entityClass as { readonly [EntitySettings]?: EntityStorageSettings })[
		EntitySettings
	];
}

/** Whether `entityClass` was declared with `versioned: true`. */
export function isVersionedEntityClass(entityClass: unknown): boolean {
	return entitySettingsOf(entityClass)?.versioned === true;
}

/**
 * The identity keys of `entityClass`: `ENTITY_IDENTITY_KEYS`, and `version`
 * when it is versioned.
 */
export function identityKeysOf(entityClass: unknown): readonly string[] {
	return isVersionedEntityClass(entityClass)
		? VERSIONED_IDENTITY_KEYS
		: ENTITY_IDENTITY_KEYS;
}

const VERSIONED_IDENTITY_KEYS: readonly string[] = Object.freeze([
	...ENTITY_IDENTITY_KEYS,
	ENTITY_VERSION_KEY,
]);

/**
 * Stores `version` as the version of `entity`, as its repository does once
 * a write succeeded. @internal
 */
export function storeEntityVersion(entity: object, version: number): void {
	storeRecordValue(
		entity as AbstractEntity<IBlueprintCollection>,
		ENTITY_VERSION_KEY,
		version,
	);
}

/** What the statics of a class made by `entityOf` hold under `EntityClock`. */
interface EntityClockSettings {
	readonly generateId: () => string;
	readonly now: () => string;
}

/** The identity of `entity`, as its members expose it. */
function identityOf(entity: object): {
	readonly id: string;
	readonly deletedAt?: string;
} {
	return entity as { readonly id: string; readonly deletedAt?: string };
}

/** How the class of `entity` makes its id and timestamps. */
function clockOf(entity: object): EntityClockSettings {
	return (entity.constructor as unknown as Clocked)[EntityClock];
}

type Clocked = { readonly [EntityClock]: EntityClockSettings };

/** Throws `DeletedEntity` when `entity` was destroyed. */
function assertAlive(entity: { readonly isDeleted: boolean }): void {
	if (entity.isDeleted) {
		throw new DeletedEntity({
			source: recordNameOf(entity.constructor),
			details: { id: identityOf(entity).id },
		});
	}
}

/**
 * `value` with an `id` and a `createdAt` made by `clock` when it has none; any
 * other value as is, for the record to reject.
 */
function withIdentity(
	value: unknown,
	clock: EntityClockSettings,
	versioned: boolean,
): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return value;
	}
	const { id, createdAt, version } = value as {
		id?: unknown;
		createdAt?: unknown;
		version?: unknown;
	};
	const missingVersion = versioned && version === undefined;
	if (id !== undefined && createdAt !== undefined && !missingVersion) {
		return value;
	}
	return {
		...value,
		id: id === undefined ? clock.generateId() : id,
		createdAt: createdAt === undefined ? clock.now() : createdAt,
		...(missingVersion ? { version: 1 } : {}),
	};
}

/**
 * A record with identity: an `id` and a `createdAt`, made when it is built
 * and never changed after, an `updatedAt` set by each change, and a
 * `deletedAt` set by `destroy`, after which it no longer changes. A versioned
 * entity also has a `version`, 1 when built, which only its repository changes.
 */
export abstract class AbstractEntity<
	Properties extends IBlueprintCollection,
	Sensitive extends string = never,
> extends AbstractRecord<Properties, Sensitive> {
	constructor(value: BlueprintInput<Properties>) {
		super(
			withIdentity(
				value,
				(new.target as unknown as Clocked)[EntityClock],
				isVersionedEntityClass(new.target),
			) as BlueprintInput<Properties>,
		);
		const input = value as { id?: unknown; createdAt?: unknown };
		if (input.id === undefined && input.createdAt === undefined) {
			enqueueLifecycle(this, "onCreate");
		}
	}

	/** Queues an event for this entity without running its handler. */
	protected emit(event: EventDefinition): void {
		enqueueEvent(this, event);
	}

	/** Drains the queue immediately, in emission order. */
	pullEvents(): EntityEvent<this>[] {
		return pullEntityEvents(this);
	}

	/** Whether `destroy` was called, so that `deletedAt` is set. */
	get isDeleted(): boolean {
		return identityOf(this).deletedAt !== undefined;
	}

	/** Whether `other` is an entity of the same declaration, with the same `id`. */
	equals(other: unknown): boolean {
		return (
			other instanceof AbstractEntity &&
			other[Meta].blueprint === this[Meta].blueprint &&
			identityOf(other).id === identityOf(this).id
		);
	}

	/**
	 * Sets `deletedAt` to now, then runs `onDestroy`; the entity no longer
	 * changes. Throws `DeletedEntity` when it was already destroyed.
	 */
	destroy(): this {
		assertAlive(this);
		storeRecordValue(this, "deletedAt", clockOf(this).now());
		enqueueLifecycle(this, "onDelete");
		this.onDestroy();
		return this;
	}

	/**
	 * Validates `value` and stores it under `key`, sets `updatedAt` to now, then
	 * runs `onSetAll` and the effect of `key` in `onSet`. Throws
	 * `ImmutableEntityKey` for a key of the identity, and `DeletedEntity` once
	 * the entity is destroyed.
	 */
	protected override set<Key extends keyof BlueprintValue<Properties>>(
		key: Key,
		value: BlueprintValue<Properties>[Key],
	): this {
		const name = String(key);
		if (identityKeysOf(this.constructor).includes(name)) {
			throw new ImmutableEntityKey({
				source: recordNameOf(this.constructor),
				details: { key: name },
			});
		}
		assertAlive(this);

		const { next, previous } = storeRecordValue(this, name, value);
		storeRecordValue(this, "updatedAt", clockOf(this).now());
		enqueueLifecycle(this, "onUpdate");
		return runRecordEffects(this, key, next, previous);
	}

	/** The side effect of `destroy`: runs after `deletedAt` is set. */
	protected onDestroy(): void {}
}
