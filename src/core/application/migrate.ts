import { currentTime } from "../clock";
import { migrateRepository } from "../repository/migrate";
import { findState, type RepositoryState } from "../repository/state";
import type {
	EntityMigrationReport,
	MigrationJournal,
	SchemaLock,
	SchemaLockEntity,
	SchemaMigrationOptions,
	SchemaMigrationReport,
	SchemaPlan,
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
 * provider of its first repository, one entity after the other. In `apply`,
 * a provider with a `journal` is asked whether a plan with changes was
 * applied (by its checksum), and records it once applied and not deferred.
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

	const current =
		lock === undefined ? undefined : schemaLockOf(source.describe());
	const changes =
		lock === undefined || current === undefined
			? []
			: diffSchemas(lock, current);
	const entities: Record<string, EntityMigrationReport> = {};
	for (const [name, state] of targets) {
		const plan: SchemaPlan = Object.freeze({
			entity: name,
			changes: changes.filter((change) => change.entity === name),
			destructive,
		});
		const journal =
			mode === "apply" && plan.changes.length > 0
				? journalOf(state.provider, fail)
				: undefined;
		const checksum = journal
			? await checksumOf(plan, startingEntryOf(lock, current, name))
			: "";
		const alreadyApplied = journal
			? (await journal.applied(name, checksum)) === true
			: false;
		const report = await migrateRepository(state, {
			mode,
			destructive,
			pageSize,
			plan,
			alreadyApplied,
		});
		if (journal && !alreadyApplied && !report.deferred) {
			await journal.record(
				Object.freeze({
					entity: name,
					plan,
					checksum,
					appliedAt: new Date(currentTime()).toISOString(),
				}),
			);
		}
		entities[name] = report;
	}
	return { mode, destructive, entities };
}

/** The journal of `provider`, when it has one. */
function journalOf(
	provider: object,
	fail: (reason: string) => never,
): MigrationJournal | undefined {
	const journal = (provider as { readonly journal?: unknown }).journal;
	if (journal === undefined || journal === null) return undefined;
	const { applied, record } = journal as Partial<MigrationJournal>;
	if (typeof applied !== "function" || typeof record !== "function") {
		return fail(
			"Expected the journal of the provider to have applied and record.",
		);
	}
	return journal as MigrationJournal;
}

/** `value` as JSON with the keys of every object sorted. */
function canonicalJsonOf(value: unknown): string {
	const sorted = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(sorted);
		if (typeof item !== "object" || item === null) return item;
		return Object.fromEntries(
			Object.keys(item)
				.sort()
				.map((key) => [key, sorted((item as Record<string, unknown>)[key])]),
		);
	};
	return JSON.stringify(sorted(value));
}

/**
 * The entry of the lock a plan of `name` starts from: the entity under its
 * name, or under the first of its previous names the lock holds; `null`
 * when the lock has neither.
 */
function startingEntryOf(
	lock: SchemaLock | undefined,
	current: SchemaLock | undefined,
	name: string,
): SchemaLockEntity | null {
	if (lock === undefined) return null;
	const names = [name, ...(current?.entities[name]?.previousNames ?? [])];
	for (const candidate of names) {
		if (Object.hasOwn(lock.entities, candidate)) {
			return lock.entities[candidate] as SchemaLockEntity;
		}
	}
	return null;
}

/**
 * The checksum of `plan` in a journal: the SHA-256, in lowercase hex and
 * through `crypto.subtle` (Bun, Node >= 22, browsers), of the canonical
 * JSON (keys sorted) of `{ from, plan }`, `from` being the entry of the
 * lock the plan was diffed from (`null` for none): the same changes from
 * another starting shape are another plan.
 */
export async function checksumOf(
	plan: SchemaPlan,
	from: SchemaLockEntity | null = null,
): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalJsonOf({ from, plan }));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
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
