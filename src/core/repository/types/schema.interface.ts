/**
 * Schema evolution: the lock of the stored shapes, the changes between two of
 * them, and the plan a provider applies (`IRepositoryProvider.migrate`).
 */

/** What a change between two shapes is. */
export type SchemaChangeKind =
	| "added-required"
	| "added-optional"
	| "removed"
	| "renamed"
	| "type-changed"
	| "tightened"
	| "loosened"
	| "made-optional"
	| "made-required"
	| "metadata"
	| "unique-added"
	| "unique-removed"
	| "entity-added"
	| "entity-removed"
	| "entity-renamed";

/**
 * Whether afora handles a change alone (`automatic`), needs it declared
 * (`fill`, `renamedFrom`, `previousNames`, an `upgrade` step: `declared`), or
 * needs the stored rows checked before it holds (`check`).
 */
export type SchemaChangeClass = "automatic" | "declared" | "check";

/** One change of an entity between the lock and the code. */
export interface SchemaChange {
	/** The entity, by its current name (its previous one when removed). */
	readonly entity: string;
	/** The path of the key, dot separated for nested blueprints; absent for the entity itself. */
	readonly key?: string;
	readonly change: SchemaChangeKind;
	readonly class: SchemaChangeClass;
	/** Whether the code declares what the change needs (always true when `automatic`). */
	readonly satisfied: boolean;
	/** Whether applying it deletes stored data (a removed key, the rows of an old name). */
	readonly destructive: boolean;
	/** For `renamed` and `entity-renamed`, the old name. */
	readonly from?: string;
	/** What is missing or what to check, for messages and stubs. */
	readonly detail?: string;
}

/** A key of an entity in the lock. */
export interface SchemaLockField {
	/** The JSON Schema of the value. */
	readonly schema: Readonly<Record<string, unknown>>;
	readonly optional: boolean;
	readonly unique?: boolean;
	readonly fill?: unknown;
	readonly renamedFrom?: string;
	/** The keys of a nested blueprint or record. */
	readonly fields?: Readonly<Record<string, SchemaLockField>>;
}

/** An entity in the lock. */
export interface SchemaLockEntity {
	readonly schemaVersion: number;
	readonly previousNames: readonly string[];
	readonly unique: readonly string[];
	readonly fields: Readonly<Record<string, SchemaLockField>>;
}

/** `afora.lock.json`: the stored shapes, by entity name, normalized. */
export interface SchemaLock {
	readonly lockVersion: 1;
	readonly entities: Readonly<Record<string, SchemaLockEntity>>;
}

/** What `IRepositoryProvider.migrate` gets: the changes of one entity. */
export interface SchemaPlan {
	/** The entity, by its current name. */
	readonly entity: string;
	readonly changes: readonly SchemaChange[];
	/** Whether destructive changes may be applied (`app.migrate({ destructive })`). */
	readonly destructive: boolean;
}
