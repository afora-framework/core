/**
 * The scripted evaluation: N runs per side (afora, baseline), per model, per
 * brief and per database, made with the Claude API, then every run evaluated
 * into eval/RESULTS.md.
 *
 *   bun scripts/eval.ts --runs 20 --models claude-opus-5-5,claude-sonnet-5-5 --briefs 2,3 [--db sqlite]
 *   bun scripts/eval.ts ... --dry-run    # prints the plan and a token estimate, calls nothing
 *
 * Without ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) it exits 1 before any
 * run, unless --dry-run. A run that hits an API error is retried from scratch
 * (its directory removed) up to 3 times, then left out and reported; a run
 * that fails for any other reason, or ends without a working app, stays and
 * fails the evaluation.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { holdsAll, writeResults } from "../eval/run.ts";
import { buildBaselineRun } from "./build-baseline.ts";
import { buildAgentRun, systemPrompt, toolsOf } from "./build-with-agent.ts";
import { clientOrExit, stampOf } from "./claude.ts";
import { connectMcp } from "./mcp.ts";
import {
	baselineAnswerChars,
	baselineTurns,
	estimateRun,
	type Job,
	jobName,
	jobsOf,
	type Plan,
	type PlanRow,
	planOf,
	planText,
	REFERENCE,
	type RunShape,
	USAGE,
} from "./plan.ts";
import { baselineInstructions } from "./prompts.ts";
import { readCalls, replay } from "./replay.ts";
import { briefText, type Db } from "./storage.ts";
import { BASELINE_TOOL_DEFINITIONS } from "./workspace.ts";

const ROOT = resolve(import.meta.dir, "..");
const ATTEMPTS = 3;

/** The shape of each run of the plan, measured without calling a model. */
async function rowsOf(plan: Plan): Promise<PlanRow[]> {
	// the turns of an afora run: the reference run's calls, replayed for their results
	const turns: { call: number; result: number }[] = [];
	if (plan.sides.includes("afora")) {
		const dir = join(ROOT, ".tmp/estimate");
		await replay(await readCalls(REFERENCE.afora), dir, {
			onResult: (call, result) => {
				turns.push({
					call: "tool" in call ? JSON.stringify(call.arguments).length : 0,
					result: result.text.length,
				});
			},
		});
		await rm(dir, { recursive: true, force: true });
	}
	const answer = await baselineAnswerChars();
	const baselineToolsChars = JSON.stringify(BASELINE_TOOL_DEFINITIONS).length;
	const fixedAfora = new Map<Db, number>();
	for (const db of plan.dbs) {
		if (!plan.sides.includes("afora")) break;
		const dir = await mkdtemp(join(tmpdir(), "afora-estimate-"));
		const mcp = await connectMcp(dir, db);
		try {
			// brief 2 instructions: brief 3 ones are a sentence shorter
			const system = await systemPrompt(mcp, db);
			const tools = JSON.stringify(await toolsOf(mcp));
			fixedAfora.set(db, system.length + tools.length);
		} finally {
			await mcp.close();
			await rm(dir, { recursive: true, force: true });
		}
	}
	const rows: PlanRow[] = [];
	for (const brief of plan.briefs) {
		for (const db of plan.dbs) {
			const text = await briefText(brief, db);
			for (const side of plan.sides) {
				const shape: RunShape =
					side === "afora"
						? { fixed: (fixedAfora.get(db) ?? 0) + text.length, turns }
						: {
								fixed:
									baselineInstructions(db, brief).length +
									baselineToolsChars +
									text.length,
								turns: baselineTurns(answer),
							};
				rows.push({
					side,
					brief,
					db,
					runs: plan.runs * plan.models.length,
					estimate: estimateRun(shape),
				});
			}
		}
	}
	return rows;
}

/** Where runs are written, and how long to wait between attempts (tests change both). */
export interface MakeRunSettings {
	readonly root?: string;
	readonly backoffMs?: number;
}

/** Whether an error comes from the Claude API (or the network on the way to it). */
export const isApiError = (error: unknown): boolean =>
	error instanceof Anthropic.APIError;

/** Adds `"error"` to the run.json of a run that failed for another reason than the API. */
async function markFailed(dir: string, reason: string): Promise<void> {
	const file = join(dir, "run.json");
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(await readFile(file, "utf8"));
	} catch {}
	await mkdir(dir, { recursive: true });
	await writeFile(file, `${JSON.stringify({ ...json, error: reason })}\n`);
}

/**
 * Makes one run. An API error (the API answered with an error, or could not
 * be reached) starts it again from scratch, up to ATTEMPTS times, then the
 * run is left out (undefined). Any other failure keeps the run, with the
 * error in its run.json: it is a run that failed, counted as failing every
 * invariant, not one to make again.
 */
export async function makeRun(
	client: Anthropic,
	plan: Pick<Plan, "effort" | "maxTurns">,
	job: Job,
	name: string,
	{ root = ROOT, backoffMs = 5_000 }: MakeRunSettings = {},
): Promise<string | undefined> {
	const parent = job.side === "afora" ? "runs" : "baseline/runs";
	const dir = join(root, parent, name);
	const options = { model: job.model, effort: plan.effort };
	const run = {
		options,
		brief: job.brief,
		db: job.db,
		maxTurns: plan.maxTurns,
	};
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		try {
			if (job.side === "afora") {
				const { calls, turns, stop } = await buildAgentRun(client, run, dir);
				return `${calls} tool calls in ${turns} turns, stopped on ${stop}`;
			}
			const { calls, turns, stop, wrote } = await buildBaselineRun(
				client,
				run,
				dir,
			);
			return `${calls} tool calls in ${turns} turns, stopped on ${stop}${wrote ? "" : " (no app.ts)"}`;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (!isApiError(error)) {
				await markFailed(dir, reason);
				console.error(
					`${parent}/${name}: failed, kept as a failing run: ${reason}`,
				);
				return `failed: ${reason}`;
			}
			await rm(dir, { recursive: true, force: true });
			console.error(
				`${parent}/${name}: attempt ${attempt}/${ATTEMPTS}: API error ${(error as { status?: number }).status ?? "(no status)"}: ${reason}`,
			);
			if (attempt < ATTEMPTS) await Bun.sleep(backoffMs * attempt);
		}
	}
	return undefined;
}

async function main(): Promise<void> {
	let plan: Plan;
	try {
		plan = planOf(Bun.argv.slice(2));
	} catch (error) {
		console.error(
			`${error instanceof Error ? error.message : error}\n${USAGE}`,
		);
		process.exit(2);
	}
	if (plan.dryRun) {
		console.log(planText(plan, await rowsOf(plan)));
		console.log("\nDry run: no model was called and nothing was written.");
		return;
	}
	const client = clientOrExit("eval");
	const stamp = stampOf();
	const jobs = jobsOf(plan);
	const missing: string[] = [];
	let next = 0;
	let done = 0;
	const worker = async () => {
		while (next < jobs.length) {
			const job = jobs[next++] as Job;
			const name = jobName(job, stamp);
			const label = `${job.side === "afora" ? "runs" : "baseline/runs"}/${name}`;
			console.log(`${label}: started`);
			const outcome = await makeRun(client, plan, job, name);
			done++;
			if (outcome === undefined) missing.push(label);
			console.log(
				`[${done}/${jobs.length}] ${label}: ${outcome ?? "left out after API errors"}`,
			);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(plan.parallel, jobs.length) }, worker),
	);
	if (missing.length > 0) {
		console.error(
			`${missing.length} run(s) were left out after ${ATTEMPTS} API errors each; run them again to complete the sample:\n${missing.join("\n")}`,
		);
	}
	if (!plan.evaluate) {
		console.log("Done. Evaluate the runs with: bun run eval");
		return;
	}
	console.log("Evaluating every run into eval/RESULTS.md...");
	const results = await writeResults();
	const made = new Set(jobs.map((job) => jobName(job, stamp)));
	const mine = results.filter((r) => made.has(r.run));
	for (const side of plan.sides) {
		const runs = mine.filter((r) => r.implementation === side);
		console.log(
			`${side}: ${runs.filter(holdsAll).length}/${runs.length} new runs hold every invariant.`,
		);
	}
	console.log(
		"Commit runs/, baseline/runs/ and eval/RESULTS.md together; see eval/RESULTS.md.",
	);
}

if (import.meta.main) await main();
