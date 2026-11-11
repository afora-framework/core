/**
 * What an editor pays per keystroke on afora code, and what it shows.
 *
 * - Edit cost: type instantiations of the checker TypeScript creates after an
 *   edit (deterministic, unlike time). `CEILING` keeps today's cost from
 *   growing; lower it whenever a change makes the types cheaper. Every case
 *   also stays under `TARGET`, what IntelliSense should cost.
 * - Experience: hovers, completions, signatures and diagnostics of every case,
 *   snapshotted per mode. A change to the types must keep them, or update the
 *   snapshot (`bun run test:type-perf -u`) as a reviewed, intended change.
 *
 * `package` mode reads `dist/`: run through `bun run test:type-perf`, which
 * builds it first.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cases } from "./cases";
import { type EditCost, experience, type Mode, measureEdit } from "./harness";

if (!existsSync(join(import.meta.dir, "../../dist/index.d.ts")))
	throw new Error("dist/ is missing: run `bun run test:type-perf`.");

/**
 * Instantiations per edit, the most of both modes (source mode). Raised on
 * 2026-11-11 with `variantOf` (#80): a new kind of field costs about 3% in
 * every case, most of it one more branch in the schema of a field, after the
 * branch it added to the optional fields of the context was moved last (it
 * cost 8% more where it was). Measured plus 1%.
 */
const CEILING: Record<string, number> = {
	"bare blueprint": 35_900,
	"quick start": 46_700,
	entity: 55_200,
	repository: 56_100,
	"use case": 56_600,
	queries: 53_700,
	"steps use case": 55_800,
	// Raised from 64_900 with the check of `return` against the response
	// (about 1,900 instantiations, 3%, only with `strictSteps`). Measured plus 1%.
	"strict steps use case": 66_900,
	"command and output": 66_700,
	"named providers": 52_700,
	// 2% under the target: the next kind of field has to be paid for elsewhere.
	"standard use cases": 99_000,
};

/** About 100 ms per edit: what IntelliSense should cost. */
const TARGET = 100_000;

const modes: readonly Mode[] = ["source", "package"];
const timeout = 60_000;

const costs = new Map<string, EditCost>();
function cost(name: string, code: string, mode: Mode) {
	const key = `${mode}: ${name}`;
	let measured = costs.get(key);
	if (!measured) {
		measured = measureEdit(code, mode);
		costs.set(key, measured);
	}
	return measured;
}

for (const mode of modes) {
	describe(`${mode} mode`, () => {
		describe("edit cost", () => {
			for (const { name, code } of cases.filter((c) => c.perf)) {
				const ceiling = CEILING[name];
				if (ceiling === undefined) throw new Error(`No ceiling for ${name}`);
				test(
					`${name} stays under its ceiling`,
					() => {
						expect(cost(name, code, mode).instantiations).toBeLessThanOrEqual(
							ceiling,
						);
					},
					timeout,
				);
				test(
					`${name} meets the target`,
					() => {
						expect(cost(name, code, mode).instantiations).toBeLessThanOrEqual(
							TARGET,
						);
					},
					timeout,
				);
			}
		});
		describe("experience", () => {
			for (const { name, code } of cases) {
				test(
					name,
					() => {
						expect(experience(code, mode).join("\n")).toMatchSnapshot();
					},
					timeout,
				);
			}
		});
	});
}

afterAll(() => {
	const rows = [...costs].map(
		([key, { instantiations, ms }]) =>
			`${key.padEnd(30)} ${String(instantiations).padStart(10)} inst ${String(Math.round(ms)).padStart(6)} ms`,
	);
	console.log(`\nEdit cost (target ${TARGET} inst)\n${rows.join("\n")}`);
});
