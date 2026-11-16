/**
 * Evaluates every run: each afora run under `runs/*` (its tool calls replayed
 * through the MCP server into a fresh directory, then the generated API) and
 * each baseline under `baseline/runs/*` (its `app.ts`). Each run is checked
 * against the version of the brief its `run.json` names, on the database it
 * names. Writes eval/RESULTS.md from what the checks gave, nothing else.
 *
 *   bun eval/run.ts            # writes eval/RESULTS.md
 *   bun eval/run.ts --check    # also exits 1 when an afora run fails an invariant
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readCalls, replay } from "../scripts/replay.ts";
import { type Db, isDb } from "../scripts/storage.ts";
import {
	type BriefVersion,
	type Check,
	type Evaluation,
	INVARIANT_IDS,
	INVARIANTS,
	type Invariant,
	invariantsOf,
	isBriefVersion,
} from "./invariants.ts";
import { formatRate, type Rate, wilson } from "./stats.ts";

const ROOT = resolve(import.meta.dir, "..");

export type Implementation = "afora" | "baseline";

/** What a run's `run.json` says about how it was made. */
export interface RunMeta {
	/** The version of the brief the run was built from, and is checked against. */
	readonly brief: BriefVersion;
	/** Where the run keeps its data: `memory` unless it says `sqlite`. */
	readonly db: Db;
	/** The model that made the run, when it says. */
	readonly model?: string;
	readonly effort?: string;
	/** Made by scripts/eval.ts (the Claude API), not by a Claude Code session. */
	readonly scripted: boolean;
	/** Why the making of the run failed, other than an API error (the run fails every invariant). */
	readonly failure?: string;
}

export interface RunResult extends RunMeta {
	readonly implementation: Implementation;
	readonly run: string;
	/** Why the run could not be evaluated (no app, replay, generation or start failed). */
	readonly error?: string;
	readonly checks: readonly Check[];
	readonly passed: Readonly<Partial<Record<Invariant, boolean>>>;
}

/**
 * The `run.json` of a run: `{ "brief": 1 | 2 | 3, "db"?: "memory" | "sqlite",
 * "model"?, "effort"?, "scripted"?: boolean }`.
 */
export async function metaOf(dir: string): Promise<RunMeta> {
	const file = join(dir, "run.json");
	if (!existsSync(file)) {
		throw new Error(`${file} is missing: it names the version of the brief.`);
	}
	const json = JSON.parse(await readFile(file, "utf8")) as Record<
		string,
		unknown
	>;
	if (!isBriefVersion(json.brief)) {
		throw new Error(`${file}: "brief" must be 1, 2 or 3.`);
	}
	const db = json.db ?? "memory";
	if (!isDb(db)) throw new Error(`${file}: "db" must be memory or sqlite.`);
	return {
		brief: json.brief,
		db,
		...(typeof json.model === "string" ? { model: json.model } : {}),
		...(typeof json.effort === "string" ? { effort: json.effort } : {}),
		scripted: json.scripted === true,
		...(typeof json.error === "string" ? { failure: json.error } : {}),
	};
}

/** The version of the brief a run names in its `run.json`. */
export async function briefOf(dir: string): Promise<BriefVersion> {
	return (await metaOf(dir)).brief;
}

async function runDirs(parent: string): Promise<string[]> {
	if (!existsSync(parent)) return [];
	const entries = await readdir(parent, { withFileTypes: true });
	return entries
		.filter(
			(entry) =>
				entry.isDirectory() && existsSync(join(parent, entry.name, "run.json")),
		)
		.map((entry) => entry.name)
		.sort();
}

/** A fresh SQLite file for one run, so runs never share data. */
async function databaseFor(kind: Implementation, run: string): Promise<string> {
	const dir = join(ROOT, ".tmp/eval-db");
	await mkdir(dir, { recursive: true });
	const file = join(dir, `${kind}-${run}.sqlite`);
	for (const suffix of ["", "-wal", "-shm"]) {
		await rm(`${file}${suffix}`, { force: true });
	}
	return file;
}

/** How long the evaluation of one run may take, replay included; past it the run fails. */
export const EVAL_TIMEOUT_MS = Number(
	process.env.AFORA_EVAL_TIMEOUT_MS ?? 120_000,
);

/** `work`, or an error once `ms` have passed. */
async function within<T>(
	ms: number,
	what: string,
	work: Promise<T>,
): Promise<T> {
	let timer: Timer | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${what} timed out after ${ms / 1000} seconds.`)),
			ms,
		);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Runs eval/check.ts in its own process: runs never share module state. */
async function checkInProcess(
	kind: Implementation,
	target: string,
	meta: RunMeta,
	run: string,
	timeoutMs: number,
): Promise<Evaluation> {
	const env: Record<string, string | undefined> = { ...process.env };
	delete env.DATABASE_PATH;
	if (meta.db === "sqlite") env.DATABASE_PATH = await databaseFor(kind, run);
	const child = Bun.spawn(
		["bun", "eval/check.ts", kind, target, String(meta.brief), meta.db],
		{ cwd: ROOT, env, stdout: "pipe", stderr: "pipe" },
	);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, timeoutMs);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(timer);
	if (timedOut) {
		throw new Error(
			`The evaluation timed out after ${timeoutMs / 1000} seconds.`,
		);
	}
	if (code !== 0) {
		const reason = stderr.trim().split("\n").find(Boolean) ?? `exit ${code}`;
		throw new Error(reason);
	}
	const last = stdout.trim().split("\n").at(-1) ?? "";
	return JSON.parse(last) as Evaluation;
}

const UNKNOWN_META: RunMeta = { brief: 2, db: "memory", scripted: false };

const failed = (
	implementation: Implementation,
	run: string,
	meta: RunMeta,
	error: unknown,
): RunResult => ({
	implementation,
	run,
	...meta,
	error: error instanceof Error ? error.message : String(error),
	checks: [],
	passed: Object.fromEntries(
		invariantsOf(meta.brief).map((id) => [id, false]),
	) as Partial<Record<Invariant, boolean>>,
});

/** Where an evaluation reads runs from, and how long one may take (tests change both). */
export interface EvalSettings {
	readonly root?: string;
	readonly timeoutMs?: number;
}

const madeOk = (meta: RunMeta) => {
	if (meta.failure) {
		throw new Error(`The run failed while it was made: ${meta.failure}`);
	}
};

export async function evaluateAfora(
	run: string,
	{ root = ROOT, timeoutMs = EVAL_TIMEOUT_MS }: EvalSettings = {},
): Promise<RunResult> {
	const source = join(root, "runs", run);
	const dir = join(ROOT, ".tmp/eval", run);
	let meta = UNKNOWN_META;
	try {
		meta = await metaOf(source);
		madeOk(meta);
		const calls = join(source, "tool-calls.json");
		if (!existsSync(calls)) throw new Error("The run has no tool-calls.json.");
		const started = Date.now();
		await within(
			timeoutMs,
			"The replay",
			replay(await readCalls(calls), dir, { db: meta.db }),
		);
		const left = Math.max(1_000, timeoutMs - (Date.now() - started));
		const { checks, passed } = await checkInProcess(
			"afora",
			dir,
			meta,
			run,
			left,
		);
		return { implementation: "afora", run, ...meta, checks, passed };
	} catch (error) {
		return failed("afora", run, meta, error);
	}
}

export async function evaluateBaseline(
	run: string,
	{ root = ROOT, timeoutMs = EVAL_TIMEOUT_MS }: EvalSettings = {},
): Promise<RunResult> {
	const source = join(root, "baseline/runs", run);
	let meta = UNKNOWN_META;
	try {
		meta = await metaOf(source);
		madeOk(meta);
		if (!existsSync(join(source, "app.ts"))) {
			throw new Error("The run has no app.ts.");
		}
		const { checks, passed } = await checkInProcess(
			"baseline",
			join(source, "app.ts"),
			meta,
			run,
			timeoutMs,
		);
		return { implementation: "baseline", run, ...meta, checks, passed };
	} catch (error) {
		return failed("baseline", run, meta, error);
	}
}

/** Evaluates every run, afora first, in the order of their names. */
export async function runEval(): Promise<RunResult[]> {
	const results: RunResult[] = [];
	for (const run of await runDirs(join(ROOT, "runs"))) {
		results.push(await evaluateAfora(run));
	}
	for (const run of await runDirs(join(ROOT, "baseline/runs"))) {
		results.push(await evaluateBaseline(run));
	}
	return results;
}

function cell(result: RunResult, invariant: Invariant): string {
	if (!invariantsOf(result.brief).includes(invariant)) return "not in brief";
	if (result.error) return "not run";
	const checks = result.checks.filter((c) => c.invariant === invariant);
	const ok = checks.filter((c) => c.ok).length;
	return `${result.passed[invariant] ? "pass" : "**FAIL**"} (${ok}/${checks.length})`;
}

/** Whether a run holds every invariant of its brief. */
export const holdsAll = (result: RunResult): boolean =>
	invariantsOf(result.brief).every((id) => result.passed[id] === true);

/** The runs of one model, brief, database and side. */
export interface Group {
	readonly scripted: boolean;
	readonly model: string;
	readonly effort: string;
	readonly brief: BriefVersion;
	readonly db: Db;
	readonly implementation: Implementation;
	readonly runs: readonly RunResult[];
}

const IMPLEMENTATIONS: readonly Implementation[] = ["afora", "baseline"];

/** The runs grouped by model, brief, database and side, in that order. */
export function groupsOf(results: readonly RunResult[]): Group[] {
	const groups = new Map<string, Group & { runs: RunResult[] }>();
	for (const result of results) {
		const model = result.model ?? "unknown";
		const effort = result.effort ?? "unknown";
		const key = JSON.stringify([
			result.scripted,
			model,
			effort,
			result.brief,
			result.db,
			result.implementation,
		]);
		const group = groups.get(key) ?? {
			scripted: result.scripted,
			model,
			effort,
			brief: result.brief,
			db: result.db,
			implementation: result.implementation,
			runs: [],
		};
		group.runs.push(result);
		groups.set(key, group);
	}
	return [...groups.values()].sort(
		(a, b) =>
			a.model.localeCompare(b.model) ||
			a.effort.localeCompare(b.effort) ||
			a.brief - b.brief ||
			a.db.localeCompare(b.db) ||
			IMPLEMENTATIONS.indexOf(a.implementation) -
				IMPLEMENTATIONS.indexOf(b.implementation),
	);
}

/** The share of the runs of a group that hold `invariant` (or every invariant). */
export function rateOf(
	runs: readonly RunResult[],
	invariant: Invariant | "all",
): Rate {
	const checked =
		invariant === "all"
			? runs
			: runs.filter((r) => invariantsOf(r.brief).includes(invariant));
	const passed = checked.filter((r) =>
		invariant === "all" ? holdsAll(r) : r.passed[invariant] === true,
	).length;
	return wilson(passed, checked.length);
}

function rateTable(groups: readonly Group[]): string[] {
	const lines = [
		`| Model | Effort | Brief | DB | Side | Runs | ${INVARIANT_IDS.map((id) => INVARIANTS[id]).join(" | ")} | Every invariant |`,
		`| --- | --- | --- | --- | --- | --- | ${INVARIANT_IDS.map(() => "---").join(" | ")} | --- |`,
	];
	for (const group of groups) {
		lines.push(
			`| ${group.model} | ${group.effort} | ${group.brief} | ${group.db} | ${group.implementation} | ${group.runs.length} | ${INVARIANT_IDS.map((id) => formatRate(rateOf(group.runs, id))).join(" | ")} | ${formatRate(rateOf(group.runs, "all"))} |`,
		);
	}
	return lines;
}

/** The markdown of eval/RESULTS.md: deterministic, so it can be compared with the committed one. */
export function resultsMarkdown(results: readonly RunResult[]): string {
	const groups = groupsOf(results);
	const scripted = groups.filter((g) => g.scripted);
	const sessions = groups.filter((g) => !g.scripted);
	const lines: string[] = [
		"# Results",
		"",
		"Generated by `bun run eval` (`eval/run.ts`) from the runs committed under `runs/` and `baseline/runs/`. Do not edit: run the evaluation again.",
		"",
		"A run is checked against the version of the brief it was built from ([1](../BRIEF.v1.md), [2](../BRIEF.md), [3](../BRIEF.v3.md)) and on the database it was built for (`memory` or `sqlite`); version 1 has no owners, so its runs are not checked for ownership. The checks are in [invariants.ts](invariants.ts). A pass rate is the runs in which every check of the invariant passed over the runs checked for it, with its 95% Wilson interval; a run that could not be evaluated (it failed while it was made, has no app, its replay or start failed, or its evaluation passed the timeout, 120 seconds by default) fails every invariant of its brief. Rates are grouped by model, effort, brief, database and side.",
		"",
		"## Scripted runs",
		"",
	];
	if (scripted.length === 0) {
		lines.push(
			"None yet: no run of `scripts/eval.ts` (the Claude API, N runs per model, brief and side) has been committed. See [Running the evaluation](../README.md#running-the-evaluation).",
		);
	} else {
		lines.push(...rateTable(scripted));
	}
	lines.push(
		"",
		"## Runs not made by the scripts",
		"",
		"Claude Code sessions that called the MCP server (afora) or wrote the file (baseline) by hand, one run per brief, with the repository open. They are not a sample: the rates below count one run each.",
		"",
	);
	if (sessions.length === 0) lines.push("None.");
	else lines.push(...rateTable(sessions));

	lines.push(
		"",
		"## Every run",
		"",
		"Each cell is whether every check of the invariant passed, with the checks passed over the checks run.",
		"",
		`| Implementation | Run | Scripted | Model | Effort | Brief | DB | ${INVARIANT_IDS.map((id) => INVARIANTS[id]).join(" | ")} |`,
		`| --- | --- | --- | --- | --- | --- | --- | ${INVARIANT_IDS.map(() => "---").join(" | ")} |`,
	);
	for (const result of results) {
		lines.push(
			`| ${result.implementation} | ${result.run} | ${result.scripted ? "yes" : "no"} | ${result.model ?? "unknown"} | ${result.effort ?? "unknown"} | ${result.brief} | ${result.db} | ${INVARIANT_IDS.map((id) => cell(result, id)).join(" | ")} |`,
		);
	}
	const problems = results.filter(
		(r) => r.error || r.checks.some((c) => !c.ok),
	);
	lines.push("", "## Failures", "");
	if (problems.length === 0) {
		lines.push("None: every check of every run passed.");
	}
	for (const result of problems) {
		lines.push(`### ${result.implementation} / ${result.run}`, "");
		if (result.error) lines.push(`- Not evaluated: ${result.error}`);
		for (const c of result.checks.filter((c) => !c.ok)) {
			lines.push(`- ${INVARIANTS[c.invariant]}: ${c.name}. ${c.detail ?? ""}`);
		}
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/** Evaluates every run and writes eval/RESULTS.md; gives the results. */
export async function writeResults(): Promise<RunResult[]> {
	const results = await runEval();
	await writeFile(join(ROOT, "eval/RESULTS.md"), resultsMarkdown(results));
	return results;
}

if (import.meta.main) {
	const results = await writeResults();
	console.log(resultsMarkdown(results));
	const aforaFailed = results.some(
		(r) => r.implementation === "afora" && !holdsAll(r),
	);
	if (Bun.argv.includes("--check") && aforaFailed) {
		console.error("An afora run fails an invariant.");
		process.exit(1);
	}
}
