import type {
	SchemaChange,
	SchemaLock,
} from "../repository/types/schema.interface";
import type { ApplicationDescription } from "./types/application.interface";

/**
 * The lock of the entities of `description` (`app.describe()`): per entity,
 * its schema version, previous names, unique keys and fields, normalized so
 * equivalent applications give equal locks.
 */
export function schemaLockOf(_description: ApplicationDescription): SchemaLock {
	// Contract stub: implemented with the schema evolution work (#28).
	return { lockVersion: 1, entities: {} };
}

/**
 * The changes from `lock` to `current`, each classed as `automatic`,
 * `declared` or `check`, with whether the code declares what it needs.
 */
export function diffSchemas(
	_lock: SchemaLock,
	_current: SchemaLock,
): readonly SchemaChange[] {
	// Contract stub: implemented with the schema evolution work (#28).
	return [];
}
