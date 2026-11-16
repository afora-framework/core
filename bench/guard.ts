// `bun run.ts --guard` fails when afora `blueprint.safeParse` falls behind
// Zod 4 `safeParse` in a case. What is compared is the ratio between the two
// on the same machine, in the same process, so a limit does not depend on the
// hardware.
import { cpus } from "node:os";
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

/** Each case is timed this many times for each contender, in turns; the ratio of a case is the median of its rounds (`pairedRatio`). */
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

/** `rounds` holds the time of each round, in the order of the rounds. */
export type Timed = { name: string; best: number; rounds: number[] };
export type TimedCase = { scenario: string; kind: Kind; runs: Timed[] };

/**
 * The time of each round of each named contender on each case, and its best
 * round. Each contender is warmed up before its first round. The contenders
 * of a case take turns in every round, in the order given, so that whatever
 * slows the machine down for a moment slows them all; the guard divides the
 * times of a round by that of its reference, timed next to them, and takes
 * the median of these ratios (`pairedRatio`).
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
				rounds: [] as number[],
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
				const time = timeOf(run.call, run.batch);
				run.rounds.push(time);
				run.best = Math.min(run.best, time);
			}
		}
	}
	return timed.map(({ scenario, kind, runs }) => ({
		scenario,
		kind,
		runs: runs.map(({ name, best, rounds }) => ({ name, best, rounds })),
	}));
}

/**
 * The median, over the rounds, of the time of `run` divided by that of
 * `reference` in the same round. The two are timed back to back in each
 * round, so a moment the machine is slow weighs on both sides of one ratio,
 * where the best of each could come from two different moments.
 */
export function pairedRatio(run: Timed, reference: Timed): number {
	const ratios = run.rounds
		.map((time, round) => time / (reference.rounds[round] as number))
		.sort((a, b) => a - b);
	const middle = ratios.length >> 1;
	return ratios.length % 2
		? (ratios[middle] as number)
		: ((ratios[middle - 1] as number) + (ratios[middle] as number)) / 2;
}

/**
 * `BENCH_GUARD_SLOWDOWN=<n>` (a whole number) makes each call of
 * `blueprint.safeParse` and `Entity.safeParse` run `n` times: a regression of
 * `n`x, to check that the guard still fails on one
 * (`BENCH_GUARD_SLOWDOWN=2 bun run bench:guard -- --only no-transform`).
 */
const SLOWDOWN = Math.max(
	1,
	Math.floor(Number(process.env.BENCH_GUARD_SLOWDOWN ?? 1)) || 1,
);

function slowedDown(contender: Contender): Contender {
	if (SLOWDOWN === 1) return contender;
	return {
		...contender,
		make: (input) => {
			for (let index = 1; index < SLOWDOWN; index++)
				do_not_optimize(contender.make(input));
			return contender.make(input);
		},
	};
}

/**
 * The cost of one `Date.now()` here, in nanoseconds. An entity reads the clock
 * for its id and its time stamp, and what a read costs depends on the clock
 * source of the machine, not on afora; it is printed so that a log tells
 * which kind of runner it came from.
 */
function clockCost(): number {
	warmUp(() => do_not_optimize(Date.now()), 50);
	return timeOf(() => Date.now(), 200);
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
				return name === GUARDED || name === ENTITY
					? slowedDown(contender)
					: contender;
			}),
		})),
	);
	return timed.map(({ scenario, kind, runs }) => {
		const [guarded, reference, entity, watched] = runs as [
			Timed,
			Timed,
			Timed,
			Timed,
		];
		const limit = limitOf(scenario, kind);
		const ratio = pairedRatio(guarded, reference);
		const ok = ratio <= limit;
		const entityLimit = entityLimitOf(scenario, kind);
		const entityRatio = pairedRatio(entity, reference);
		const entityOk = entityRatio <= entityLimit;
		return {
			scenario,
			kind,
			passed: ok && entityOk,
			line: `${ok ? "ok  " : "FAIL"}  ${`${scenario} ${kind}`.padEnd(22)} afora ${fmtNs(guarded.best).padStart(8)}  zod ${fmtNs(reference.best).padStart(8)}  ratio ${ratio.toFixed(2)}  limit ${limit.toFixed(2)}  (Record.safeParse ${pairedRatio(watched, reference).toFixed(2)}, not guarded)`,
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
	// Each guarded call is timed right next to the reference, in every round:
	// `blueprint.safeParse` just before Zod 4, `Entity.safeParse` just after.
	const names = [GUARDED, REFERENCE, ENTITY, WATCHED];
	const cases = scenarios.flatMap((scenario) =>
		KINDS.map((kind) => ({ scenario, kind })),
	);

	console.log(
		`${GUARDED} against ${REFERENCE}, after a warm-up: the best of ${ROUNDS} rounds (ns per call), and the median of the ratios of the ${ROUNDS} rounds, each timing the two back to back`,
	);
	console.log(
		`${cpus()[0]?.model ?? "unknown CPU"}, ${cpus().length} cores; Date.now() ${clockCost().toFixed(1)} ns${SLOWDOWN > 1 ? `; BENCH_GUARD_SLOWDOWN=${SLOWDOWN}: ${GUARDED} and ${ENTITY} run ${SLOWDOWN} times per call` : ""}\n`,
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
