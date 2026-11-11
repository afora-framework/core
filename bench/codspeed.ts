// The cases of the guard for CodSpeed, which counts instructions on a
// simulated CPU instead of timing, so its numbers do not move with the load of
// the runner, and keeps their history per commit. Run on Node against a build
// of afora (the `codspeed` job of bench-compare.yml); outside CodSpeed it is a
// plain tinybench run.
import { withCodSpeed } from "@codspeed/tinybench-plugin";
import { Bench } from "tinybench";
import { ENTITY, GUARDED, REFERENCE, WATCHED } from "./contenders.ts";
import { inputOf, KINDS, loadScenarios } from "./harness.ts";

const bench = withCodSpeed(new Bench());
for (const scenario of await loadScenarios()) {
	for (const kind of KINDS) {
		for (const name of [GUARDED, WATCHED, ENTITY, REFERENCE]) {
			const contender = scenario.contenders.find(
				(candidate) => candidate.name === name,
			);
			if (!contender) throw new Error(`${scenario.id}: no "${name}"`);
			const input = inputOf(scenario, contender, kind);
			bench.add(`${scenario.id} ${kind}: ${name}`, () => {
				contender.make(input);
			});
		}
	}
}

await bench.run();
console.table(bench.table());
