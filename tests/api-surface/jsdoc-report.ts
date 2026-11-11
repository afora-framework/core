/**
 * Prints the undocumented exports and the failing `@example` blocks without
 * failing: `bun tests/api-surface/jsdoc-report.ts` (needs `dist/`).
 */
import {
	exampleFailures,
	formatExampleFailures,
	formatUndocumented,
	undocumentedByEntry,
} from "./jsdoc";
import { builtExports } from "./program";

const undocumented = undocumentedByEntry();
for (const { entry, exports } of builtExports()) {
	const missing = undocumented[entry.specifier]?.length ?? 0;
	console.log(
		`${entry.specifier}: ${exports.length - missing}/${exports.length} documented`,
	);
}
console.log(
	`\n${formatUndocumented(undocumented) || "No undocumented exports."}`,
);
const { checked, failures } = exampleFailures();
console.log(
	`\nExamples: ${checked} checked, ${failures.length} failing${failures.length ? ":" : "."}`,
);
if (failures.length) console.log(formatExampleFailures(failures));
