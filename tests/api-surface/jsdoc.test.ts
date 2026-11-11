/**
 * Every export of the four entries carries JSDoc, and every `@example` in it
 * type-checks against the built declarations as a module (`@afora/core*`
 * resolve to `dist/`). Issue #92. To see the lists without failing, run
 * `bun tests/api-surface/jsdoc-report.ts`.
 *
 * Reads `dist/`: run through `bun run test:api`, which builds it first.
 */
import { expect, test } from "bun:test";
import {
	exampleFailures,
	formatExampleFailures,
	formatUndocumented,
	undocumentedByEntry,
} from "./jsdoc";

test("every export has JSDoc", () => {
	const undocumented = undocumentedByEntry();
	const message = formatUndocumented(undocumented);
	expect(message, `\n${message}\n`).toBe("");
});

test("every @example type-checks", () => {
	const { checked, failures } = exampleFailures();
	const message = formatExampleFailures(failures);
	expect(
		message,
		`\n${failures.length} of ${checked} examples fail:\n${message}\n`,
	).toBe("");
});
