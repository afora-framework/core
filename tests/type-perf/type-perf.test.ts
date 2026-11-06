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
 * Instantiations per edit, the most of both modes (source mode), as measured
 * on 2026-11-05, plus 2%.
 */
const CEILING: Record<string, number> = {
	"bare blueprint": 34_500,
	"quick start": 44_900,
	entity: 53_000,
	repository: 53_900,
	"use case": 54_300,
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
			`${key.padEnd(28)} ${String(instantiations).padStart(10)} inst ${String(Math.round(ms)).padStart(6)} ms`,
	);
	console.log(`\nEdit cost (target ${TARGET} inst)\n${rows.join("\n")}`);
});
