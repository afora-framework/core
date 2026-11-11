import {
	diffSchemas,
	type SchemaChange,
	type SchemaLock,
	schemaLockOf,
	schemaLockProblemsOf,
} from "@afora/core/adapters";

/** Changes an `upgrade` step can satisfy, when they have no `fill` or other declaration. */
const STEPPED = new Set<SchemaChange["change"]>([
	"type-changed",
	"tightened",
	"made-required",
	"added-required",
]);

/** An entity whose changes need an upgrade step it does not have. */
export interface MissingStep {
	readonly entity: string;
	/** The version in the lock and in the code. */
	readonly locked: number;
	readonly current: number;
	/** Whether the code's `schemaVersion` must go up for the step. */
	readonly bump: boolean;
	readonly changes: readonly SchemaChange[];
}

/** What `schema check` and `schema lock` find between a lock and the code. */
export interface SchemaCheck {
	readonly changes: readonly SchemaChange[];
	readonly unsatisfied: readonly SchemaChange[];
	readonly problems: readonly string[];
	readonly missingSteps: readonly MissingStep[];
}

/** Compares `lock` to `current` (both made by `schemaLockOf`). */
export function schemaCheckOf(
	lock: SchemaLock,
	current: SchemaLock,
): SchemaCheck {
	const changes = diffSchemas(lock, current);
	const unsatisfied = changes.filter((change) => !change.satisfied);
	const missingSteps: MissingStep[] = [];
	for (const [name, entity] of Object.entries(current.entities)) {
		const stepped = unsatisfied.filter(
			(change) => change.entity === name && STEPPED.has(change.change),
		);
		if (stepped.length === 0) continue;
		const previous =
			lock.entities[name] ??
			entity.previousNames
				.map((old) => lock.entities[old])
				.find((found) => found !== undefined);
		if (previous === undefined) continue;
		missingSteps.push({
			entity: name,
			locked: previous.schemaVersion,
			current: entity.schemaVersion,
			bump: entity.schemaVersion <= previous.schemaVersion,
			changes: stepped,
		});
	}
	return {
		changes,
		unsatisfied,
		problems: schemaLockProblemsOf(lock, current),
		missingSteps,
	};
}

/** The lock of an application, from its `describe()`. */
export function lockOfApplication(app: {
	describe(): Parameters<typeof schemaLockOf>[0];
}): SchemaLock {
	return schemaLockOf(app.describe());
}

/** One line for `change`: `Entry.locale: added-required (declared, unsatisfied) ...`. */
export function changeLine(change: SchemaChange): string {
	const where = change.key ? `${change.entity}.${change.key}` : change.entity;
	const flags = [
		change.class,
		change.satisfied ? "satisfied" : "unsatisfied",
		...(change.destructive ? ["destructive"] : []),
	].join(", ");
	return `${where}: ${change.change}${change.from ? ` from ${change.from}` : ""} (${flags})${change.detail ? ` ${change.detail}` : ""}`;
}

/** What each change asks of the step, as a comment. */
function hintOf(change: SchemaChange): string {
	const key = change.key ?? "";
	switch (change.change) {
		case "added-required":
			return `${key}: ...`;
		case "type-changed":
			return `${key}: convert data.${key}`;
		case "made-required":
			return `${key}: data.${key} ?? ...`;
		default:
			return `${key}: fit data.${key} to the new constraint`;
	}
}

/** The `schemaVersion` and `upgrade` to add to an entity for its missing step. */
export function stubOf(missing: MissingStep): string {
	const version = missing.bump ? missing.locked + 1 : missing.current;
	const hints = missing.changes.map(hintOf).join(", ");
	return [
		`${missing.entity}:`,
		...(missing.bump ? [`\tschemaVersion: ${version},`] : []),
		"\tupgrade: {",
		`\t\t${version}: (data) => ({ ...data /* ${hints} */ }),`,
		"\t},",
	].join("\n");
}
