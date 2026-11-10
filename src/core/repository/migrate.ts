import {
	EntitySettings,
	isVersionedEntityClass,
	SCHEMA_VERSION_KEY,
} from "../entity/abstract-entity";
import type { EntityStorageSettings } from "../entity/types/entity.interface";
import { Exception } from "../exception/exception";
import type { Issue } from "../parse/types/parse.interface";
import {
	InvalidRepositoryData,
	InvalidRepositoryDeclaration,
	RepositoryConcurrencyConflict,
} from "./exceptions";
import { resolveReferences } from "./references";
import { contextOf, type RepositoryState } from "./state";
import type { ProviderQuery } from "./types/query.interface";
import type {
	IRepositoryProvider,
	RepositoryContext,
	RepositoryData,
} from "./types/repository.interface";
import type {
	EntityMigrationReport,
	SchemaMigrationInvalidRow,
	SchemaPlan,
} from "./types/schema.interface";
import {
	fullUpcastPlanOf,
	type UpcastPlan,
	type UpcastReport,
	upcast,
} from "./upcast";

/** How `migrateRepository` walks one repository. */
export interface RepositoryMigration {
	readonly mode: "check" | "apply";
	readonly destructive: boolean;
	readonly pageSize: number;
	/** Given to `provider.migrate` in `apply`, before the rows are walked. */
	readonly plan: SchemaPlan;
}

/** The entity class `entity` as named `name`, for a provider that names tables by it. */
const aliases = new WeakMap<object, Map<string, object>>();
function aliasOf(entity: object, name: string): object {
	let byName = aliases.get(entity);
	if (!byName) {
		byName = new Map();
		aliases.set(entity, byName);
	}
	let alias = byName.get(name);
	if (!alias) {
		const Entity = entity as new (...args: never[]) => object;
		alias = class extends Entity {};
		Object.defineProperty(alias, "name", { value: name });
		Object.defineProperty(alias, "recordName", { value: name });
		byName.set(name, alias);
	}
	return alias;
}

/**
 * The context of the rows the entity of `context` stored under its previous
 * name `name`: named `<name>Repository`, its entity a subclass whose record
 * name is `name`, so a provider that finds tables by either reads them.
 */
function previousContextOf(
	context: RepositoryContext,
	name: string,
): RepositoryContext {
	return Object.freeze({
		...context,
		entity: aliasOf(context.entity, name) as RepositoryContext["entity"],
		name: `${name}Repository`,
	});
}

/**
 * Calls `visit` with each page of the rows of `context`, by id, deleted and
 * expired ones included: by `after` when the provider reads by cursor, by
 * `offset` otherwise. `visit` gives how many rows of its page it removed.
 */
async function walk(
	provider: IRepositoryProvider,
	context: RepositoryContext,
	pageSize: number,
	visit: (rows: readonly RepositoryData[]) => Promise<number>,
): Promise<void> {
	const keyset = provider.capabilities?.keyset === true;
	let after: readonly unknown[] | undefined;
	let offset = 0;
	for (;;) {
		const query: ProviderQuery = {
			orderBy: [{ key: "id", direction: "asc" }],
			withDeleted: true,
			...(context.expiry === undefined ? {} : { withExpired: true }),
			limit: pageSize,
			...(keyset
				? after === undefined
					? {}
					: { after }
				: offset === 0
					? {}
					: { offset }),
		};
		const rows = await provider.findMany(context, query);
		if (rows.length === 0) return;
		const removed = await visit(rows);
		after = [(rows.at(-1) as RepositoryData).id];
		offset += rows.length - removed;
		if (rows.length < pageSize) return;
	}
}

/** The issues of `error`, thrown while a row was brought up or parsed. */
function issuesOf(source: string, error: unknown): readonly Issue[] {
	const issues = (error as { details?: { issues?: unknown } })?.details?.issues;
	if (Array.isArray(issues)) return issues as Issue[];
	const cause =
		error instanceof Exception && error.is(InvalidRepositoryData)
			? (error.cause ?? error)
			: error;
	return [
		{
			code: "invalid_value",
			path: [],
			message: cause instanceof Error ? cause.message : String(cause),
			source,
			...(cause instanceof Exception ? { cause } : {}),
		},
	];
}

/** A row brought up, or why it cannot be. */
type Upcasted =
	| {
			readonly row: RepositoryData;
			readonly current: RepositoryData;
			readonly report: UpcastReport;
	  }
	| { readonly row: RepositoryData; readonly invalid: readonly Issue[] };

/**
 * `rows` in the current shape, each checked by the entity with the entities
 * it holds loaded: in one batch, or row by row when the batch fails, so one
 * missing reference names its row.
 */
async function upcastPage(
	state: RepositoryState,
	plan: UpcastPlan,
	rows: readonly RepositoryData[],
): Promise<readonly Upcasted[]> {
	const brought: Upcasted[] = rows.map((row) => {
		const report: UpcastReport = {
			from: 1,
			renamed: [],
			filled: [],
			removed: [],
		};
		try {
			return {
				row,
				current: upcast(state.name, plan, row, true, report),
				report,
			};
		} catch (error) {
			return { row, invalid: issuesOf(state.name, error) };
		}
	});
	const valid = brought.filter(
		(item): item is Extract<Upcasted, { current: RepositoryData }> =>
			"current" in item,
	);
	const parse = (data: RepositoryData) => state.entity.safeParse(data);
	const resolvedOf = async (
		items: readonly Extract<Upcasted, { current: RepositoryData }>[],
	) =>
		resolveReferences(
			state,
			items.map((item) => item.current),
			new Map(),
		);
	let resolved: readonly (RepositoryData | readonly Issue[])[];
	try {
		resolved = await resolvedOf(valid);
	} catch {
		resolved = await Promise.all(
			valid.map(async (item) => {
				try {
					return (await resolvedOf([item]))[0] as RepositoryData;
				} catch (error) {
					return issuesOf(state.name, error);
				}
			}),
		);
	}
	const checked = new Map<RepositoryData, readonly Issue[]>();
	valid.forEach((item, index) => {
		const data = resolved[index] as RepositoryData | readonly Issue[];
		if (Array.isArray(data)) {
			checked.set(item.row, data);
			return;
		}
		const parsed = parse(data as RepositoryData);
		if (parsed.issues) checked.set(item.row, parsed.issues);
	});
	return brought.map((item) => {
		const issues = checked.get(item.row);
		return issues === undefined ? item : { row: item.row, invalid: issues };
	});
}

interface Tally {
	scanned: number;
	upToDate: number;
	upgraded: number;
	removalPending: number;
	movedFromPreviousNames: number;
	readonly invalid: SchemaMigrationInvalidRow[];
	readonly removedKeys: Set<string>;
}

/** What is written for `item`: the current shape, its undeclared keys kept unless `destructive`. */
function writtenOf(
	state: RepositoryState,
	plan: UpcastPlan,
	item: Extract<Upcasted, { current: RepositoryData }>,
	destructive: boolean,
): RepositoryData {
	const data = destructive
		? item.current
		: upcast(state.name, plan, item.row, false);
	return plan.versioned
		? { ...data, [SCHEMA_VERSION_KEY]: plan.version }
		: data;
}

/**
 * Brings the stored rows of the repository of `state` up to the current
 * shape of its entity (see `app.migrate`): in `apply`, first gives
 * `options.plan` to `provider.migrate`, then rewrites the rows below the
 * current version or with a `renamedFrom` or `fill` pending, and moves the
 * rows of each previous name. Keys no longer declared, and the rows of the
 * previous names, are only removed when `destructive`. Idempotent: a second
 * run finds every valid row up to date.
 */
export async function migrateRepository(
	state: RepositoryState,
	options: RepositoryMigration,
): Promise<EntityMigrationReport> {
	const { mode, destructive, pageSize } = options;
	const apply = mode === "apply";
	const { provider } = state;
	const context = contextOf(state);
	const plan = fullUpcastPlanOf(state.entity);
	// Rewrites of an entity with optimistic concurrency expect the version read.
	const versioned =
		isVersionedEntityClass(state.entity) &&
		provider.capabilities?.versioning === true;
	const previousNames =
		(state.entity as { readonly [EntitySettings]?: EntityStorageSettings })[
			EntitySettings
		]?.previousNames ?? [];
	const needs: (keyof IRepositoryProvider)[] = ["findMany"];
	if (apply) needs.push("update");
	if (previousNames.length > 0) needs.push("findOne");
	if (apply && previousNames.length > 0) needs.push("insert");
	if (apply && destructive && previousNames.length > 0) needs.push("remove");
	for (const need of needs) {
		if (typeof provider[need] !== "function") {
			throw new InvalidRepositoryDeclaration({
				source: state.name,
				details: { reason: `The provider has no "${need}" to migrate.` },
			});
		}
	}

	const tally: Tally = {
		scanned: 0,
		upToDate: 0,
		upgraded: 0,
		removalPending: 0,
		movedFromPreviousNames: 0,
		invalid: [],
		removedKeys: new Set(),
	};
	if (apply) await provider.migrate?.(context, options.plan);

	await walk(provider, context, pageSize, async (rows) => {
		for (const item of await upcastPage(state, plan, rows)) {
			tally.scanned += 1;
			if ("invalid" in item) {
				tally.invalid.push({ id: String(item.row.id), issues: item.invalid });
				continue;
			}
			const { report } = item;
			for (const key of report.removed) tally.removedKeys.add(key);
			const pending =
				(plan.versioned && report.from < plan.version) ||
				report.renamed.length > 0 ||
				report.filled.length > 0;
			const removal = report.removed.length > 0;
			if (pending || (removal && destructive)) {
				tally.upgraded += 1;
				if (apply) {
					// A versioned row written in between is already current: kept.
					const expected = item.row.version;
					try {
						await provider.update(
							context,
							writtenOf(state, plan, item, destructive),
							versioned && typeof expected === "number"
								? { expectedVersion: expected }
								: undefined,
						);
					} catch (error) {
						if (
							!(error instanceof Exception) ||
							!error.is(RepositoryConcurrencyConflict)
						) {
							throw error;
						}
						tally.upgraded -= 1;
						tally.upToDate += 1;
					}
				}
			} else if (removal) {
				tally.removalPending += 1;
			} else {
				tally.upToDate += 1;
			}
		}
		return 0;
	});

	for (const previous of previousNames) {
		const old = previousContextOf(context, previous);
		await walk(provider, old, pageSize, async (rows) => {
			let removed = 0;
			for (const item of await upcastPage(state, plan, rows)) {
				tally.scanned += 1;
				if ("invalid" in item) {
					tally.invalid.push({
						id: String(item.row.id),
						issues: item.invalid,
					});
					continue;
				}
				for (const key of item.report.removed) tally.removedKeys.add(key);
				const id = String(item.row.id);
				const moved =
					(await provider.findOne(context, {
						where: { id },
						withDeleted: true,
						...(context.expiry === undefined ? {} : { withExpired: true }),
					})) !== undefined;
				if (!moved) {
					tally.movedFromPreviousNames += 1;
					if (apply) {
						await provider.insert(
							context,
							writtenOf(state, plan, item, destructive),
						);
					}
				}
				if (apply && destructive) {
					await provider.remove(old, id);
					removed += 1;
				}
			}
			return removed;
		});
	}

	return {
		scanned: tally.scanned,
		upToDate: tally.upToDate,
		upgraded: tally.upgraded,
		removalPending: tally.removalPending,
		invalid: tally.invalid,
		movedFromPreviousNames: tally.movedFromPreviousNames,
		removedKeys: [...tally.removedKeys].sort(),
	};
}
