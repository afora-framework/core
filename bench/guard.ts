// `bun run.ts --guard` fails when afora `blueprint.safeParse` falls behind
// Zod 4 `safeParse` in a case. What is compared is the ratio between the two
// on the same machine, in the same process, so a limit does not depend on the
// hardware.
import { do_not_optimize } from "mitata";
import {
	type Contender,
	ENTITY,
	GUARDED,
	REFERENCE,
	type Scenario,
	WATCHED,
} from "./contenders.ts";
import {
	ENTITY_DEFAULT,
	ENTITY_LIMITS,
	GUARD_DEFAULT,
	GUARD_LIMITS,
} from "./guard.limits.ts";
import { inputOf, KINDS, type Kind, warmUp } from "./harness.ts";

/** Each case is timed this many times for each contender; the best one counts. */
const ROUNDS = 9;
/** How long one timing of one contender runs, in milliseconds. */
const ROUND_MS = 150;

export const limitOf = (scenario: string, kind: Kind) =>
	GUARD_LIMITS[`${scenario} ${kind}`]?.limit ?? GUARD_DEFAULT;

export const entityLimitOf = (scenario: string, kind: Kind) =>
	ENTITY_LIMITS[`${scenario} ${kind}`]?.limit ?? ENTITY_DEFAULT;

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
 * The best time of each named contender on each case. Each contender is
 * warmed up before its first round. The contenders of a case take turns in
 * every round, so that whatever slows the machine down for a moment slows
 * them all, and the best round of each is the one with the least of it.
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
				// Before its first timing, a contender runs long enough for the
				// engine to optimize it (see `warmUp`): sampled too early, a
				// function can stay unoptimized, and slow, for every round.
				if (round === 0) warmUp(() => do_not_optimize(run.call()));
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

type Checked = {
	scenario: string;
	kind: Kind;
	line: string;
	entityLine: string;
	passed: boolean;
};

/** Times the cases and compares each one with its limits. */
function check(
	cases: Array<{ scenario: Scenario; kind: Kind }>,
	names: string[],
): Checked[] {
	const timed = timeCases(
		cases.map(({ scenario, kind }) => ({
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
	);
	return timed.map(({ scenario, kind, runs }) => {
		const [reference, guarded, watched, entity] = runs as [
			Timed,
			Timed,
			Timed,
			Timed,
		];
		const limit = limitOf(scenario, kind);
		const ratio = guarded.best / reference.best;
		const ok = ratio <= limit;
		const entityLimit = entityLimitOf(scenario, kind);
		const entityRatio = entity.best / reference.best;
		const entityOk = entityRatio <= entityLimit;
		return {
			scenario,
			kind,
			passed: ok && entityOk,
			line: `${ok ? "ok  " : "FAIL"}  ${`${scenario} ${kind}`.padEnd(22)} afora ${fmtNs(guarded.best).padStart(8)}  zod ${fmtNs(reference.best).padStart(8)}  ratio ${ratio.toFixed(2)}  limit ${limit.toFixed(2)}  (Record.safeParse ${(watched.best / reference.best).toFixed(2)}, not guarded)`,
			entityLine: `${entityOk ? "ok  " : "FAIL"}  ${`${scenario} ${kind}`.padEnd(22)} Entity.safeParse ${fmtNs(entity.best).padStart(8)}  ratio ${entityRatio.toFixed(2)}  limit ${entityLimit.toFixed(2)}`,
		};
	});
}

/**
 * How many more times a case over its limit is timed before the guard fails.
 * A shared CI runner can be slow for a whole case (a fast case like
 * `no-transform valid` is a few hundred nanoseconds, so a slow moment moves
 * the ratio a lot); a regression stays over the limit every time.
 */
const RETRIES = 2;

export function guard(scenarios: Scenario[]): boolean {
	const names = [REFERENCE, GUARDED, WATCHED, ENTITY];
	const cases = scenarios.flatMap((scenario) =>
		KINDS.map((kind) => ({ scenario, kind })),
	);

	console.log(
		`${GUARDED} against ${REFERENCE}, best of ${ROUNDS} rounds after a warm-up (ns per call)\n`,
	);
	let results = check(cases, names);
	for (const { line, entityLine } of results) {
		console.log(line);
		console.log(entityLine);
	}

	for (let retry = 1; retry <= RETRIES; retry++) {
		const failed = results.filter(({ passed }) => !passed);
		if (failed.length === 0) break;
		console.log(
			`\nTiming again what is over its limit, to rule out noise (${retry} of ${RETRIES}):\n`,
		);
		results = check(
			cases.filter(({ scenario, kind }) =>
				failed.some(
					(result) => result.scenario === scenario.id && result.kind === kind,
				),
			),
			names,
		);
		for (const { line, entityLine } of results) {
			console.log(line);
			console.log(entityLine);
		}
	}

	const passed = results.every((result) => result.passed);
	console.log(
		passed
			? "\nEvery case is within its limit."
			: `\nA case is over its limit ${RETRIES + 1} times in a row: validation got slower. Find what the change costs (CONTRIBUTING.md); a limit in bench/guard.limits.ts is only raised for a cost that is wanted, with the reason.`,
	);
	return passed;
}
