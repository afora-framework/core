import { checkImport, isImportObject } from "./provider";
import { issue } from "./scope";
import { isIdentifier, isObject } from "./spec/field";
import type { SpecIssue } from "./spec/types";

type Path = readonly (string | number)[];

/**
 * Checks the schema evolution options of an entity: `schemaVersion` a
 * positive integer, each key of `upgrade` an integer from 2 to it with a
 * `{ "import": ... }` step, `previousNames` identifiers other than `name`.
 */
export function checkEntitySchema(
	name: string,
	spec: Readonly<Record<string, unknown>>,
	path: Path,
	issues: SpecIssue[],
): void {
	const { schemaVersion, upgrade, previousNames } = spec;
	const version =
		typeof schemaVersion === "number" &&
		Number.isSafeInteger(schemaVersion) &&
		schemaVersion >= 1
			? schemaVersion
			: undefined;
	if (schemaVersion !== undefined && version === undefined) {
		issues.push(
			issue(
				[...path, "schemaVersion"],
				"invalid_option",
				"schemaVersion must be a positive integer.",
			),
		);
	}
	if (upgrade !== undefined) {
		if (!isObject(upgrade)) {
			issues.push(
				issue(
					[...path, "upgrade"],
					"invalid_option",
					'upgrade must be an object of steps by version: { "2": { "import": "./upgrades.ts#toV2" } }.',
				),
			);
		} else {
			for (const [key, step] of Object.entries(upgrade)) {
				const here = [...path, "upgrade", key];
				const reached = Number(key);
				if (
					!/^[1-9][0-9]*$/.test(key) ||
					reached < 2 ||
					reached > (version ?? 1)
				) {
					issues.push(
						issue(
							here,
							"invalid_option",
							`The step "${key}" must reach a version from 2 to the schemaVersion (${version ?? 1}).`,
						),
					);
				}
				if (isImportObject(step)) checkImport(step, here, issues);
				else {
					issues.push(
						issue(
							here,
							"invalid_import",
							'A step is written by hand: { "import": "./upgrades.ts#toV2" }.',
						),
					);
				}
			}
		}
	}
	if (previousNames !== undefined) {
		if (!Array.isArray(previousNames)) {
			issues.push(
				issue(
					[...path, "previousNames"],
					"invalid_option",
					"previousNames must be a list of names.",
				),
			);
			return;
		}
		for (const [index, previous] of previousNames.entries()) {
			if (
				typeof previous !== "string" ||
				!isIdentifier(previous) ||
				previous === name
			) {
				issues.push(
					issue(
						[...path, "previousNames", index],
						"invalid_option",
						`A previous name is an identifier other than "${name}".`,
					),
				);
			}
		}
	}
}

/** The schema evolution options of an entity in canonical form. */
export function canonicalEntitySchema(
	spec: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const { schemaVersion, upgrade, previousNames } = spec;
	const steps = isObject(upgrade)
		? Object.keys(upgrade)
				.sort((a, b) => Number(a) - Number(b))
				.filter((key) => isImportObject(upgrade[key]))
				.map(
					(key) =>
						[
							key,
							{ import: String((upgrade[key] as { import: unknown }).import) },
						] as const,
				)
		: [];
	const names = Array.isArray(previousNames)
		? [...new Set(previousNames.filter((n) => typeof n === "string"))].sort()
		: [];
	return {
		// Declared, even as 1, rows store the version: kept as written.
		...(typeof schemaVersion === "number" ? { schemaVersion } : {}),
		...(steps.length > 0 ? { upgrade: Object.fromEntries(steps) } : {}),
		...(names.length > 0 ? { previousNames: names } : {}),
	};
}
