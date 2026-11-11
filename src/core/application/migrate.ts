import { migrateRepository } from "../repository/migrate";
import { findState, type RepositoryState } from "../repository/state";
import type {
	EntityMigrationReport,
	SchemaLock,
	SchemaMigrationOptions,
	SchemaMigrationReport,
} from "../repository/types/schema.interface";
import { InvalidSchemaMigration } from "./exceptions";
import { diffSchemas, schemaLockOf } from "./schema";
import type { ApplicationDescription } from "./types/application.interface";

/** What `app.migrate` reads from its application. */
export interface MigrationSource {
	readonly name: string;
	/** Its entities, by name. */
	readonly entities: ReadonlyMap<string, object>;
	/** Its bound repositories. */
	readonly repositories: readonly object[];
	describe(): ApplicationDescription;
}

/**
 * `app.migrate(options)`: for each entity with a repository (or those of
 * `options.entities`), the backfill of `migrateRepository` through the
 * provider of its first repository, one entity after the other.
 */
export async function migrateApplication(
	source: MigrationSource,
	options: SchemaMigrationOptions,
): Promise<SchemaMigrationReport> {
	const fail = (reason: string): never => {
		throw new InvalidSchemaMigration({
			source: source.name,
			details: { reason },
		});
	};
	if (typeof options !== "object" || options === null) {
		fail('Expected the options of migrate, e.g. { mode: "check" }.');
	}
	const { mode, destructive = false, pageSize = 100, lock } = options;
	if (mode !== "check" && mode !== "apply") {
		fail('Expected mode to be "check" or "apply".');
	}
	if (typeof destructive !== "boolean") {
		fail("Expected destructive to be a boolean.");
	}
	if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
		fail("Expected pageSize to be a positive integer.");
	}
	if (lock !== undefined && !isLock(lock)) {
		fail("Expected lock to be a schema lock ({ lockVersion: 1, entities }).");
	}

	const byEntity = new Map<object, RepositoryState>();
	for (const repository of source.repositories) {
		const state = findState(repository);
		if (state && !byEntity.has(state.entity)) byEntity.set(state.entity, state);
	}
	const names =
		options.entities ??
		[...source.entities]
			.filter(([, entity]) => byEntity.has(entity))
			.map(([name]) => name);
	if (!Array.isArray(names)) fail("Expected entities to be a list of names.");
	const targets: [string, RepositoryState][] = [];
	for (const name of names) {
		const entity = source.entities.get(name);
		if (entity === undefined) {
			fail(`"${name}" is not an entity of the application.`);
		}
		const state = byEntity.get(entity as object);
		if (state === undefined) {
			fail(`The entity "${name}" has no repository to migrate it through.`);
		}
		targets.push([name, state as RepositoryState]);
	}

	const changes =
		lock === undefined
			? []
			: diffSchemas(lock, schemaLockOf(source.describe()));
	const entities: Record<string, EntityMigrationReport> = {};
	for (const [name, state] of targets) {
		entities[name] = await migrateRepository(state, {
			mode,
			destructive,
			pageSize,
			plan: Object.freeze({
				entity: name,
				changes: changes.filter((change) => change.entity === name),
				destructive,
			}),
		});
	}
	return { mode, destructive, entities };
}

/** Whether `value` has the shape of a schema lock. */
export function isLock(value: unknown): value is SchemaLock {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { lockVersion?: unknown }).lockVersion === 1 &&
		typeof (value as { entities?: unknown }).entities === "object" &&
		(value as { entities?: unknown }).entities !== null
	);
}
