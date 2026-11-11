// `bun run.ts --guard` fails when afora `blueprint.safeParse` falls behind
// Zod 4 `safeParse` in a case. What is compared is the ratio between the two
// on the same machine, in the same process, so a limit does not depend on the
// hardware.
import { do_not_optimize } from "mitata";
import {
	type Contender,
	GUARDED,
	REFERENCE,
	type Scenario,
	WATCHED,
} from "./contenders.ts";
import { GUARD_DEFAULT, GUARD_LIMITS } from "./guard.limits.ts";
import { inputOf, KINDS, type Kind } from "./harness.ts";

/** Each case is timed this many times for each contender; the best one counts. */
const ROUNDS = 9;
/** How long one timing of one contender runs, in milliseconds. */
const ROUND_MS = 150;

export const limitOf = (scenario: string, kind: Kind) =>
	GUARD_LIMITS[`${scenario} ${kind}`]?.limit ?? GUARD_DEFAULT;

/** The mean time of one call of `fn`, in nanoseconds, over about `ROUND_MS`. */
function timeOf(fn: () => unknown, batch: number): number {
	const start = performance.now();
	const end = start + ROUND_MS;
	let calls = 0;
	while (performance.now() < end) {
		for (let index = 0; index < batch; index++) do_not_optimize(fn());
		calls += batch;
	}
	return ((performance.now() - start) * 1e6) / calls;
}

export type Timed = { name: string; best: number };
export type TimedCase = { scenario: string; kind: Kind; runs: Timed[] };

/**
 * The best time of each named contender on each case. The contenders of a
 * case take turns in every round, so that whatever slows the machine down for
 * a moment slows them all, and the best round of each is the one with the
 * least of it.
 */
export function timeCases(
	cases: Array<{
		scenario: Scenario;
		kind: Kind;
		contenders: Contender[];
	}>,
): TimedCase[] {
	const timed = cases.map(({ scenario, kind, contenders }) => ({
		scenario: scenario.id,
		kind,
		runs: contenders.map((contender) => {
			const input = inputOf(scenario, contender, kind);
			const call = () => contender.make(input);
			// A slow call (a list of 1,000 items) is not repeated 200 times between two looks at the clock.
			const started = performance.now();
			call();
			const batch = performance.now() - started > 0.05 ? 5 : 200;
			return {
				name: contender.name,
				best: Number.POSITIVE_INFINITY,
				call,
				batch,
			};
		}),
	}));
	for (let round = 0; round < ROUNDS; round++) {
		for (const { runs } of timed) {
			for (const run of runs) {
				run.best = Math.min(run.best, timeOf(run.call, run.batch));
			}
		}
	}
	return timed.map(({ scenario, kind, runs }) => ({
		scenario,
		kind,
		runs: runs.map(({ name, best }) => ({ name, best })),
	}));
}

export const fmtNs = (ns: number) =>
	ns >= 1000 ? ns.toFixed(0) : ns.toFixed(1);

export function guard(scenarios: Scenario[]): boolean {
	const names = [REFERENCE, GUARDED, WATCHED];
	const timed = timeCases(
		scenarios.flatMap((scenario) =>
			KINDS.map((kind) => ({
				scenario,
				kind,
				contenders: names.map((name) => {
					const contender = scenario.contenders.find(
						(candidate) => candidate.name === name,
					);
					if (!contender) throw new Error(`${scenario.id}: no "${name}"`);
					return contender;
				}),
			})),
		),
	);

	let passed = true;
	console.log(
		`${GUARDED} against ${REFERENCE}, best of ${ROUNDS} rounds (ns per call)\n`,
	);
	for (const { scenario, kind, runs } of timed) {
		const [reference, guarded, watched] = runs as [Timed, Timed, Timed];
		const limit = limitOf(scenario, kind);
		const ratio = guarded.best / reference.best;
		const ok = ratio <= limit;
		if (!ok) passed = false;
		console.log(
			`${ok ? "ok  " : "FAIL"}  ${`${scenario} ${kind}`.padEnd(22)} afora ${fmtNs(guarded.best).padStart(8)}  zod ${fmtNs(reference.best).padStart(8)}  ratio ${ratio.toFixed(2)}  limit ${limit.toFixed(2)}  (Record.safeParse ${(watched.best / reference.best).toFixed(2)}, not guarded)`,
		);
	}
	console.log(
		passed
			? "\nEvery case is within its limit."
			: "\nA case is over its limit: validation got slower. Run it again to rule out noise, then find what the change costs (CONTRIBUTING.md); a limit in bench/guard.limits.ts is only raised for a cost that is wanted, with the reason.",
	);
	return passed;
}
