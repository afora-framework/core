import type {
	BlueprintInput,
	BlueprintValue,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import type { Complete } from "../parse/parse";
import {
	AbstractRecord,
	runRecordEffects,
	storeRecordValue,
	vouchFor,
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
import type { ValidMakers } from "./trust";
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

/**
 * The milliseconds after `createdAt` at which the entities of a class
 * declared with `expires: { after }` expire, kept in `expiresAt`.
 *
 * @internal
 */
export const EntityLifetime = Symbol("entityLifetime");

/** The key the entities of a class declared with `expires: { after }` keep their expiry in. */
export const EXPIRES_AT = "expiresAt";

/** The key a versioned entity adds to its identity. */
export const ENTITY_VERSION_KEY = "version";

/**
 * The key of each stored row holding its schema version, for entities
 * declared with `schemaVersion`; it is never a key of the entity.
 */
export const SCHEMA_VERSION_KEY = "$v";

/** Whether `entityClass` was declared with `versioned: true`. */
export function isVersionedEntityClass(entityClass: unknown): boolean {
	if (typeof entityClass !== "function") return false;
	return (
		(entityClass as { readonly [EntitySettings]?: EntityStorageSettings })[
			EntitySettings
		]?.versioned === true
	);
}

/**
 * The identity keys of the entities of `entityClass`, which only the entity
 * changes: `ENTITY_IDENTITY_KEYS`, `version` when it is versioned, and
 * `expiresAt` when it expires `after` a duration.
 */
export function identityKeysOf(entityClass: unknown): readonly string[] {
	const keys: string[] = [...ENTITY_IDENTITY_KEYS];
	if (isVersionedEntityClass(entityClass)) keys.push(ENTITY_VERSION_KEY);
	if (
		typeof entityClass === "function" &&
		(entityClass as { readonly [EntityLifetime]?: number })[EntityLifetime] !==
			undefined
	) {
		keys.push(EXPIRES_AT);
	}
	return keys;
}

/** Whether `key` is an identity key of the entities of `Entity`, which only the entity changes. */
function isIdentityKey(Entity: unknown, key: string): boolean {
	return identityKeysOf(Entity).includes(key);
}

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
	/** When what the two above make is known to be valid (see `MakesValid`). */
	readonly makesValid?: ValidMakers;
}

/** The keys an entity may vouch for, in each combination. */
const ID_MADE: readonly string[] = Object.freeze(["id"]);
const CREATED_AT_MADE: readonly string[] = Object.freeze(["createdAt"]);
const BOTH_MADE: readonly string[] = Object.freeze(["id", "createdAt"]);
const CREATED_AT_EXPIRES: readonly string[] = Object.freeze([
	"createdAt",
	EXPIRES_AT,
]);
const BOTH_EXPIRES: readonly string[] = Object.freeze([
	"id",
	"createdAt",
	EXPIRES_AT,
]);

/**
 * Under this key, a class made by `entityOf` holds what makes its id, its
 * `createdAt` and its `expiresAt` once its value is known to be valid.
 *
 * @internal
 */
export const EntityComplete = Symbol("entityComplete");

/**
 * What an entity class does with the values its builder vouched for and left
 * out, after the rest of its value is known to be valid: `createdAt` first,
 * then `id`, as they were made before; and, for a class that expires, an
 * `expiresAt` `lifetime` milliseconds after `createdAt`, which is still
 * checked.
 */
export function completeOf(
	clock: { readonly generateId: () => string; readonly now: () => string },
	lifetime: number | undefined,
): Complete {
	return (handled) => {
		if (handled.createdAt === undefined) handled.createdAt = clock.now();
		if (handled.id === undefined) handled.id = clock.generateId();
		if (lifetime !== undefined && handled[EXPIRES_AT] === undefined) {
			const created = handled.createdAt;
			const start = typeof created === "string" ? Date.parse(created) : NaN;
			if (!Number.isNaN(start)) {
				handled[EXPIRES_AT] = new Date(start + lifetime).toISOString();
				return [EXPIRES_AT];
			}
		}
		return undefined;
	};
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
 * `value` with an `id` and a `createdAt` made by `clock` when it has none,
 * and, when the class expires `lifetime` milliseconds after `createdAt`, an
 * `expiresAt` when it has none; any other value as is, for the record to
 * reject. What `clock` vouches for is not made here but by `complete`, once
 * the record finds the rest of the value valid: invalid input pays for none
 * of it.
 */
function withIdentity(
	value: unknown,
	clock: EntityClockSettings,
	lifetime: number | undefined,
	versioned: boolean,
	complete: Complete,
): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return value;
	}
	const { id, createdAt, expiresAt, version } = value as {
		id?: unknown;
		createdAt?: unknown;
		expiresAt?: unknown;
		version?: unknown;
	};
	const expiring = lifetime !== undefined && expiresAt === undefined;
	const unversioned = versioned && version === undefined;
	if (id !== undefined && createdAt !== undefined && !expiring && !unversioned)
		return value;
	// What this entity makes with makers known to make it valid is not checked
	// by its record, and made only after the rest of the value is.
	const { makesValid } = clock;
	const idLater = id === undefined && makesValid?.id() === true;
	const createdAtLater =
		createdAt === undefined && makesValid?.createdAt() === true;
	// The expiry follows `createdAt`: with that one left for later, so is it.
	const expiresLater = expiring && createdAtLater;
	const vouched =
		idLater && createdAtLater
			? expiresLater
				? BOTH_EXPIRES
				: BOTH_MADE
			: createdAtLater
				? expiresLater
					? CREATED_AT_EXPIRES
					: CREATED_AT_MADE
				: idLater
					? ID_MADE
					: undefined;

	if (
		!unversioned &&
		!(expiring && !expiresLater) &&
		(id !== undefined || idLater) &&
		(createdAt !== undefined || createdAtLater)
	) {
		if (vouched !== undefined) vouchFor(vouched, complete);
		return value;
	}
	const created =
		createdAt === undefined && !createdAtLater ? clock.now() : createdAt;
	// `id` and `createdAt` come first, as in the blueprint of an entity, whose
	// keys the record then finds in their places; the spread may bring either
	// one as `undefined`, so both are set after it.
	const identity: Record<string, unknown> = {
		id: undefined,
		createdAt: undefined,
		...value,
	};
	identity.id = id === undefined && !idLater ? clock.generateId() : id;
	identity.createdAt = created;
	if (unversioned) identity[ENTITY_VERSION_KEY] = 1;
	if (expiring && !expiresLater) {
		const start = typeof created === "string" ? Date.parse(created) : NaN;
		if (!Number.isNaN(start)) {
			identity[EXPIRES_AT] = new Date(start + lifetime).toISOString();
		}
	}
	// Vouched for last, once nothing above can throw: a maker or a date that
	// throws must not leave the vouch to the next record built.
	if (vouched !== undefined) vouchFor(vouched, complete);
	return identity;
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
				(new.target as unknown as { readonly [EntityLifetime]?: number })[
					EntityLifetime
				],
				isVersionedEntityClass(new.target),
				(new.target as unknown as { readonly [EntityComplete]: Complete })[
					EntityComplete
				],
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
		if (isIdentityKey(this.constructor, name)) {
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
