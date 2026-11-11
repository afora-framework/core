/**
 * Evaluates every run: each afora run under `runs/*` (its tool calls replayed
 * through the MCP server into a fresh directory, then the generated API) and
 * each baseline under `baseline/runs/*` (its `app.ts`). Each run is checked
 * against the version of the brief its `run.json` names. Writes
 * eval/RESULTS.md from what the checks gave, nothing else.
 *
 *   bun eval/run.ts            # writes eval/RESULTS.md
 *   bun eval/run.ts --check    # also exits 1 when an afora run fails an invariant
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readCalls, replay } from "../scripts/replay.ts";
import {
	type BriefVersion,
	type Check,
	type Evaluation,
	INVARIANT_IDS,
	INVARIANTS,
	type Invariant,
	invariantsOf,
} from "./invariants.ts";

const ROOT = resolve(import.meta.dir, "..");

export type Implementation = "afora" | "baseline";

export interface RunResult {
	readonly implementation: Implementation;
	readonly run: string;
	/** The version of the brief the run was built from, and is checked against. */
	readonly brief: BriefVersion;
	/** Why the run could not be evaluated (replay, generation or start failed). */
	readonly error?: string;
	readonly checks: readonly Check[];
	readonly passed: Readonly<Partial<Record<Invariant, boolean>>>;
}

/** The version of the brief a run names in its `run.json`: `{ "brief": 1 | 2 }`. */
export async function briefOf(dir: string): Promise<BriefVersion> {
	const file = join(dir, "run.json");
	if (!existsSync(file)) {
		throw new Error(`${file} is missing: it names the version of the brief.`);
	}
	const { brief } = JSON.parse(await readFile(file, "utf8")) as {
		brief?: unknown;
	};
	if (brief !== 1 && brief !== 2) {
		throw new Error(`${file}: "brief" must be 1 or 2.`);
	}
	return brief;
}

async function dirsWith(parent: string, file: string): Promise<string[]> {
	if (!existsSync(parent)) return [];
	const entries = await readdir(parent, { withFileTypes: true });
	return entries
		.filter(
			(entry) =>
				entry.isDirectory() && existsSync(join(parent, entry.name, file)),
		)
		.map((entry) => entry.name)
		.sort();
}

/** Runs eval/check.ts in its own process: runs never share module state. */
async function checkInProcess(
	kind: Implementation,
	target: string,
	brief: BriefVersion,
): Promise<Evaluation> {
	const child = Bun.spawn(
		["bun", "eval/check.ts", kind, target, String(brief)],
		{
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) {
		const reason = stderr.trim().split("\n").find(Boolean) ?? `exit ${code}`;
		throw new Error(reason);
	}
	const last = stdout.trim().split("\n").at(-1) ?? "";
	return JSON.parse(last) as Evaluation;
}

const failed = (
	implementation: Implementation,
	run: string,
	brief: BriefVersion,
	error: unknown,
): RunResult => ({
	implementation,
	run,
	brief,
	error: error instanceof Error ? error.message : String(error),
	checks: [],
	passed: Object.fromEntries(
		invariantsOf(brief).map((id) => [id, false]),
	) as Partial<Record<Invariant, boolean>>,
});

async function evaluateAfora(run: string): Promise<RunResult> {
	const dir = join(ROOT, ".tmp/eval", run);
	let brief: BriefVersion = 2;
	try {
		brief = await briefOf(join(ROOT, "runs", run));
		await replay(
			await readCalls(join(ROOT, "runs", run, "tool-calls.json")),
			dir,
		);
		const evaluation = await checkInProcess("afora", dir, brief);
		return { implementation: "afora", run, ...evaluation };
	} catch (error) {
		return failed("afora", run, brief, error);
	}
}

async function evaluateBaseline(run: string): Promise<RunResult> {
	let brief: BriefVersion = 2;
	try {
		brief = await briefOf(join(ROOT, "baseline/runs", run));
		const evaluation = await checkInProcess(
			"baseline",
			join("baseline/runs", run, "app.ts"),
			brief,
		);
		return { implementation: "baseline", run, ...evaluation };
	} catch (error) {
		return failed("baseline", run, brief, error);
	}
}

/** Evaluates every run, afora first, in the order of their names. */
export async function runEval(): Promise<RunResult[]> {
	const results: RunResult[] = [];
	for (const run of await dirsWith(join(ROOT, "runs"), "tool-calls.json")) {
		results.push(await evaluateAfora(run));
	}
	for (const run of await dirsWith(join(ROOT, "baseline/runs"), "app.ts")) {
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

/** The markdown of eval/RESULTS.md: deterministic, so it can be compared with the committed one. */
export function resultsMarkdown(results: readonly RunResult[]): string {
	const lines: string[] = [
		"# Results",
		"",
		"Generated by `bun run eval` (`eval/run.ts`) from the runs committed under `runs/` and `baseline/runs/`. Do not edit: run the evaluation again.",
		"",
		"Each cell is whether every check of the invariant passed, with the checks passed over the checks run. The checks are in [invariants.ts](invariants.ts). A run is checked against the version of the brief it was built from ([1](../BRIEF.v1.md), [2](../BRIEF.md)); version 1 has no owners, so its runs are not checked for ownership.",
		"",
		`| Implementation | Run | Brief | ${INVARIANT_IDS.map((id) => INVARIANTS[id]).join(" | ")} |`,
		`| --- | --- | --- | ${INVARIANT_IDS.map(() => "---").join(" | ")} |`,
	];
	for (const result of results) {
		lines.push(
			`| ${result.implementation} | ${result.run} | ${result.brief} | ${INVARIANT_IDS.map((id) => cell(result, id)).join(" | ")} |`,
		);
	}
	lines.push("", "## Aggregate", "");
	lines.push(
		`| Implementation | Runs | ${INVARIANT_IDS.map((id) => INVARIANTS[id]).join(" | ")} |`,
		`| --- | --- | ${INVARIANT_IDS.map(() => "---").join(" | ")} |`,
	);
	for (const implementation of ["afora", "baseline"] as const) {
		const runs = results.filter((r) => r.implementation === implementation);
		if (runs.length === 0) continue;
		lines.push(
			`| ${implementation} | ${runs.length} | ${INVARIANT_IDS.map((id) => {
				const checked = runs.filter((r) => invariantsOf(r.brief).includes(id));
				return `${checked.filter((r) => r.passed[id]).length}/${checked.length} runs`;
			}).join(" | ")} |`,
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

if (import.meta.main) {
	const results = await runEval();
	const markdown = resultsMarkdown(results);
	await writeFile(join(ROOT, "eval/RESULTS.md"), markdown);
	console.log(markdown);
	const aforaFailed = results.some(
		(r) =>
			r.implementation === "afora" &&
			invariantsOf(r.brief).some((id) => !r.passed[id]),
	);
	if (Bun.argv.includes("--check") && aforaFailed) {
		console.error("An afora run fails an invariant.");
		process.exit(1);
	}
}
