// Loads the scenarios, checks every contender before it is timed, and times
// them with mitata. Runs on Bun (afora from source) and on Node (afora from
// the build in .dist/).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus } from "node:os";
import { bench, do_not_optimize, group, run } from "mitata";
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
	const scenarios = scenarioBuilders
		.map((build) => build(module))
		.filter((scenario) => only.length === 0 || only.includes(scenario.id));
	if (scenarios.length === 0) {
		throw new Error(`No scenario matches ${only.join(", ")}`);
	}
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

export async function measure(scenarios: Scenario[]): Promise<RuntimeReport> {
	const trials = new Map<
		string,
		{ scenario: Scenario; kind: Kind; contender: Contender }
	>();
	for (const scenario of scenarios) {
		for (const kind of KINDS) {
			group(`${scenario.id}, ${kind} input`, () => {
				for (const contender of scenario.contenders) {
					const input = inputOf(scenario, contender, kind);
					const alias = `${scenario.id} ${kind}: ${contender.name}`;
					trials.set(alias, { scenario, kind, contender });
					bench(alias, () => do_not_optimize(contender.make(input)));
				}
			});
		}
	}

	const { benchmarks } = await run({
		format: process.env.BENCH_QUIET ? "quiet" : "mitata",
	});

	const tables = new Map<string, Table>();
	for (const trial of benchmarks) {
		const meta = trials.get(trial.alias);
		const stats = trial.runs[0]?.stats;
		if (!meta || !stats) continue;
		const { scenario, kind, contender } = meta;
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
