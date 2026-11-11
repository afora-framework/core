import type { Issue } from "../../parse/types/parse.interface";

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
	/**
	 * The versions its `upgrade` has a step to, ascending; absent when none.
	 * `diffSchemas` reads it from the current side to tell whether a change
	 * that needs a step has one.
	 */
	readonly upgrade?: readonly number[];
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

/** What `app.migrate` takes. */
export interface SchemaMigrationOptions {
	/** The entities to walk, by name; every entity with a repository by default. */
	readonly entities?: readonly string[];
	/** `check` only reads and reports; `apply` rewrites the rows. */
	readonly mode: "check" | "apply";
	/**
	 * Remove the keys the blueprints no longer declare from the stored rows,
	 * and the rows under `previousNames` once moved. Default `false`.
	 */
	readonly destructive?: boolean;
	/** Rows read per page. Default 100. */
	readonly pageSize?: number;
	/**
	 * The committed lock (`afora.lock.json`): in `apply`, the changes of each
	 * entity from it to the code are the plan given to
	 * `IRepositoryProvider.migrate`. Without it the plan has no changes.
	 */
	readonly lock?: SchemaLock;
}

/** A row `app.migrate` cannot bring up to the current shape. */
export interface SchemaMigrationInvalidRow {
	readonly id: string;
	/** Why: the issues of the parse, or one for an error of the upgrade. */
	readonly issues: readonly Issue[];
}

/** What `app.migrate` found and did for one entity. */
export interface EntityMigrationReport {
	/** Rows read, under the current name and the previous ones. */
	readonly scanned: number;
	/** Rows that needed nothing. */
	readonly upToDate: number;
	/** Rows rewritten in the current shape (in `check`, that would be). */
	readonly upgraded: number;
	/**
	 * Rows whose only pending change is removing keys, left as they are
	 * without `destructive`.
	 */
	readonly removalPending: number;
	/** Rows the entity rejects once brought up, left as they are. */
	readonly invalid: readonly SchemaMigrationInvalidRow[];
	/** Rows moved from a previous name (in `check`, that would be). */
	readonly movedFromPreviousNames: number;
	/** Paths of the stored keys the blueprint no longer declares, sorted. */
	readonly removedKeys: readonly string[];
	/**
	 * Whether `provider.migrate` deferred the plan (`{ deferred: true }`, it
	 * wrote it to be run later): the rows were then not walked, and every
	 * count is 0. Run `app.migrate` again once the plan is applied.
	 */
	readonly deferred: boolean;
}

/** What `app.migrate` gives. */
export interface SchemaMigrationReport {
	readonly mode: "check" | "apply";
	readonly destructive: boolean;
	/** By entity name. */
	readonly entities: Readonly<Record<string, EntityMigrationReport>>;
}
