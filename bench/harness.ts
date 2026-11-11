// Loads the scenarios, checks every contender before it is timed, and times
// them with mitata. Runs on Bun (afora from source) and on Node (afora from
// the build in .dist/).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus } from "node:os";
import { do_not_optimize, measure as sample } from "mitata";
import { type Contender, LIBRARIES, type Scenario } from "./contenders.ts";
import { scenarioBuilders } from "./scenarios/index.ts";

export const here = new URL(".", import.meta.url).pathname;
export const isBun =
	typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export type Kind = "valid" | "invalid";
export const KINDS: Kind[] = ["valid", "invalid"];

/** Times are nanoseconds per call. */
export type Row = {
	contender: string;
	library: string;
	note?: string;
	avg: number;
	min: number;
	p50: number;
	p75: number;
	p99: number;
	/** Half of the 95% confidence interval of the mean, as a fraction of it. */
	margin: number;
};
export type Table = {
	scenario: string;
	title: string;
	shape: string;
	case: Kind;
	rows: Row[];
};
export type RuntimeReport = {
	runtime: "bun" | "node";
	version: string;
	cpu: string;
	os: string;
	tables: Table[];
};

/** afora itself: the source on Bun, the build on Node, or the module at `path`. */
export async function loadAfora(path?: string) {
	if (path) return import(path);
	return isBun ? import("../src/index.ts") : import("./.dist/afora.js");
}

/** Every scenario (or those in `only`), with each contender checked once. */
export async function loadScenarios(
	only: string[] = [],
	// biome-ignore lint/suspicious/noExplicitAny: the afora module
	afora?: any,
): Promise<Scenario[]> {
	const module = afora ?? (await loadAfora());
	const unknown = only.filter((id) => !(id in scenarioBuilders));
	if (unknown.length > 0) {
		throw new Error(
			`No scenario named ${unknown.join(", ")}; there are ${Object.keys(scenarioBuilders).join(", ")}.`,
		);
	}
	const scenarios = Object.entries(scenarioBuilders)
		.filter(([id]) => only.length === 0 || only.includes(id))
		.map(([id, build]) => {
			const scenario = build(module);
			if (scenario.id !== id) throw new Error(`${id} is named ${scenario.id}`);
			return scenario;
		});
	for (const scenario of scenarios) verify(scenario);
	return scenarios;
}

/** The input a contender gets for a case. */
export function inputOf(scenario: Scenario, contender: Contender, kind: Kind) {
	if (kind === "invalid") return scenario.input.invalid;
	return contender.checksOnly
		? scenario.input.validClean
		: scenario.input.valid;
}

/**
 * A contender that is timed accepts the valid input, rejects the invalid one,
 * and rejects an undeclared key: a row that skipped a rule would be faster for
 * the wrong reason.
 */
function verify(scenario: Scenario) {
	for (const contender of scenario.contenders) {
		const fail = (what: string) => {
			throw new Error(`${scenario.id}: ${contender.name} ${what}`);
		};
		const valid = inputOf(scenario, contender, "valid");
		if (!contender.ok(contender.make(valid))) fail("rejects the valid input");
		if (contender.ok(contender.make(scenario.input.invalid))) {
			fail("accepts the invalid input");
		}
		const undeclared = { ...(valid as object), undeclaredKey: 1 };
		if (contender.ok(contender.make(undeclared))) {
			fail("accepts an undeclared key");
		}
	}
}

/** How long a row runs before it is sampled, in milliseconds. */
const WARM_UP_MS = Number(process.env.BENCH_WARM_UP_MS ?? 400);

/**
 * Runs `call` until the engine has had the time to optimize it. mitata's own
 * warm-up is two samples, after which Node at times is still running the
 * unoptimized code, and stays twice as slow for the whole measurement.
 */
function warmUp(call: () => unknown) {
	const end = performance.now() + WARM_UP_MS;
	while (performance.now() < end) {
		for (let index = 0; index < 100; index++) call();
	}
}

function marginOf(samples: number[], avg: number): number {
	if (samples.length < 2 || avg === 0) return 0;
	let sum = 0;
	for (const sample of samples) sum += (sample - avg) ** 2;
	const deviation = Math.sqrt(sum / (samples.length - 1));
	return (1.96 * deviation) / Math.sqrt(samples.length) / avg;
}

/** The note of a row: "no transforms" is only worth saying where the others transform. */
export function noteOf(scenario: Scenario, contender: Contender) {
	const notes = [
		contender.note,
		contender.checksOnly && scenario.transforms ? "no transforms" : undefined,
	].filter(Boolean);
	return notes.length > 0 ? notes.join("; ") : undefined;
}

/**
 * Times the contenders of `scenarios`; with `pick`, one contender on one case.
 * A published number comes from a process that timed nothing else (see
 * run.ts): code that ran before changes what the engine makes of code that
 * runs after, so a row would otherwise depend on the rows before it.
 */
export async function measure(
	scenarios: Scenario[],
	pick?: { kind: Kind; contender: number },
): Promise<RuntimeReport> {
	const tables = new Map<string, Table>();
	for (const scenario of scenarios) {
		for (const kind of KINDS) {
			if (pick && pick.kind !== kind) continue;
			for (const [index, contender] of scenario.contenders.entries()) {
				if (pick && pick.contender !== index) continue;
				const input = inputOf(scenario, contender, kind);
				// mitata's sampler by itself: `run` would also time four empty
				// functions first, three seconds that every process would repeat.
				const call = () => do_not_optimize(contender.make(input));
				warmUp(call);
				const stats = await sample(call);
				const key = `${scenario.id} ${kind}`;
				let table = tables.get(key);
				if (!table) {
					table = {
						scenario: scenario.id,
						title: scenario.title,
						shape: scenario.shape,
						case: kind,
						rows: [],
					};
					tables.set(key, table);
				}
				table.rows.push({
					contender: contender.name,
					library: contender.library,
					note: noteOf(scenario, contender),
					avg: stats.avg,
					min: stats.min,
					p50: stats.p50,
					p75: stats.p75,
					p99: stats.p99,
					margin: marginOf(stats.samples, stats.avg),
				});
			}
		}
	}

	return {
		runtime: isBun ? "bun" : "node",
		version: isBun
			? `Bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}`
			: `Node ${process.version}`,
		cpu: cpus()[0]?.model ?? "unknown",
		os: `${process.platform} ${process.arch}`,
		tables: [...tables.values()],
	};
}

/** The installed version of every library that is compared. */
export function libraryVersions(): Record<string, string> {
	const require = createRequire(import.meta.url);
	const versions: Record<string, string> = {};
	for (const [key, { package: name }] of Object.entries(LIBRARIES)) {
		const file =
			key === "afora"
				? `${here}../package.json`
				: require.resolve(`${name}/package.json`);
		versions[key] = JSON.parse(readFileSync(file, "utf8")).version;
	}
	return versions;
}
