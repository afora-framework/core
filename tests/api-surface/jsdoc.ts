/**
 * The two JSDoc checks, as functions: which exports have no JSDoc, and which
 * `@example` blocks do not type-check against the built declarations. Used by
 * `jsdoc.test.ts` (fails) and `jsdoc-report.ts` (prints, never fails).
 */
import {
	builtExports,
	checkVirtualModules,
	distPaths,
	examplesOf,
	type VirtualModule,
} from "./program";

export function undocumentedByEntry(): Record<string, string[]> {
	return Object.fromEntries(
		builtExports().map(({ entry, exports }) => [
			entry.specifier,
			exports.filter((info) => !info.documented).map((info) => info.name),
		]),
	);
}

export interface ExampleFailure {
	/** `Name (entry) example #n`. */
	id: string;
	diagnostics: string[];
}

/** Every `@example` of every export, type-checked in one program. */
export function exampleFailures(): {
	checked: number;
	failures: ExampleFailure[];
} {
	const modules: VirtualModule[] = [];
	for (const { entry, exports } of builtExports())
		for (const info of exports)
			for (const [index, code] of examplesOf(info).entries())
				modules.push({
					id: `${info.name} (${entry.specifier}) example #${index + 1}`,
					code,
				});
	return {
		checked: modules.length,
		failures: checkVirtualModules(modules, distPaths()),
	};
}

export function formatUndocumented(
	undocumented: Record<string, string[]>,
): string {
	return Object.entries(undocumented)
		.filter(([, names]) => names.length > 0)
		.map(
			([entry, names]) =>
				`${entry}: ${names.length} export(s) without JSDoc\n  ${names.join(", ")}`,
		)
		.join("\n");
}

export function formatExampleFailures(failures: ExampleFailure[]): string {
	return failures
		.map(
			(failure) =>
				`${failure.id}\n${failure.diagnostics.map((line) => `    ${line}`).join("\n")}`,
		)
		.join("\n");
}
