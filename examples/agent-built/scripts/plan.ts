/**
 * The plan of a scripted evaluation: N runs per side, model, brief and
 * database, and a rough estimate of what it asks of the API. Nothing here
 * calls a model.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	type BriefVersion,
	CURRENT_BRIEF,
	isBriefVersion,
} from "../eval/invariants.ts";
import { DEFAULT_EFFORT, DEFAULT_MODEL, type ModelOptions } from "./claude.ts";
import type { Db } from "./storage.ts";
import { isDb } from "./storage.ts";

const ROOT = resolve(import.meta.dir, "..");

export type Side = "afora" | "baseline";
export const SIDES: readonly Side[] = ["afora", "baseline"];

export interface Plan {
	readonly runs: number;
	readonly models: readonly string[];
	readonly briefs: readonly BriefVersion[];
	readonly dbs: readonly Db[];
	readonly sides: readonly Side[];
	readonly effort: ModelOptions["effort"];
	readonly maxTurns: number;
	/** How many runs are made at the same time. */
	readonly parallel: number;
	readonly dryRun: boolean;
	/** Evaluate every run and write eval/RESULTS.md once the runs are made. */
	readonly evaluate: boolean;
}

/** One run to make. */
export interface Job {
	readonly side: Side;
	readonly model: string;
	readonly brief: BriefVersion;
	readonly db: Db;
	/** 1 to `runs`, within its side, model, brief and database. */
	readonly index: number;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const list = (value: string): string[] =>
	value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

function positive(name: string, value: string): number {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1) {
		throw new Error(`--${name} must be a positive integer, not "${value}".`);
	}
	return number;
}

export const USAGE = `Usage: bun scripts/eval.ts [--runs 20] [--models claude-opus-5-5,claude-sonnet-5-5] [--briefs 2,3] [--db memory|sqlite|memory,sqlite] [--sides afora,baseline] [--effort high] [--max-turns 60] [--parallel 4] [--dry-run] [--no-eval]`;

/**
 * The plan of `args` (the arguments after the script). Defaults: 20 runs,
 * the model of AFORA_EVAL_MODEL or claude-opus-5-5, brief 2, in memory,
 * both sides.
 */
export function planOf(
	args: readonly string[],
	env: Readonly<Record<string, string | undefined>> = process.env,
): Plan {
	const { values } = parseArgs({
		args: [...args],
		options: {
			runs: { type: "string", default: "20" },
			models: { type: "string" },
			model: { type: "string" },
			briefs: { type: "string", default: String(CURRENT_BRIEF) },
			db: { type: "string", default: "memory" },
			sides: { type: "string", default: SIDES.join(",") },
			effort: { type: "string" },
			"max-turns": { type: "string", default: "60" },
			parallel: { type: "string", default: "4" },
			"dry-run": { type: "boolean", default: false },
			"no-eval": { type: "boolean", default: false },
		},
		strict: true,
	});
	const models = list(
		values.models ??
			values.model ??
			env.AFORA_EVAL_MODELS ??
			env.AFORA_EVAL_MODEL ??
			DEFAULT_MODEL,
	);
	const briefs = list(values.briefs).map(Number);
	for (const brief of briefs) {
		if (!isBriefVersion(brief)) {
			throw new Error(`--briefs takes 1, 2 or 3, not "${brief}".`);
		}
	}
	const dbs = list(values.db);
	for (const db of dbs) {
		if (!isDb(db)) throw new Error(`--db takes memory or sqlite, not "${db}".`);
	}
	const sides = list(values.sides);
	for (const side of sides) {
		if (!SIDES.includes(side as Side)) {
			throw new Error(`--sides takes afora and baseline, not "${side}".`);
		}
	}
	const effort = values.effort ?? env.AFORA_EVAL_EFFORT ?? DEFAULT_EFFORT;
	if (!EFFORTS.includes(effort as ModelOptions["effort"])) {
		throw new Error(`Unknown effort "${effort}".`);
	}
	if (models.length === 0 || briefs.length === 0 || dbs.length === 0) {
		throw new Error("--models, --briefs and --db need at least one value.");
	}
	if (sides.length === 0) throw new Error("--sides needs at least one side.");
	const unique = <T>(items: readonly T[]) => [...new Set(items)];
	return {
		runs: positive("runs", values.runs),
		models: unique(models),
		briefs: unique(briefs as BriefVersion[]),
		dbs: unique(dbs as Db[]),
		sides: unique(sides as Side[]),
		effort: effort as ModelOptions["effort"],
		maxTurns: positive("max-turns", values["max-turns"]),
		parallel: positive("parallel", values.parallel),
		dryRun: values["dry-run"],
		evaluate: !values["no-eval"],
	};
}

/** Every run of the plan, by model, brief, database, side and index. */
export function jobsOf(plan: Plan): Job[] {
	const jobs: Job[] = [];
	for (const model of plan.models) {
		for (const brief of plan.briefs) {
			for (const db of plan.dbs) {
				for (const side of plan.sides) {
					for (let index = 1; index <= plan.runs; index++) {
						jobs.push({ side, model, brief, db, index });
					}
				}
			}
		}
	}
	return jobs;
}

/** The directory name of a job: `<stamp>-<model>-b<brief>-<db>-<index>`. */
export function jobName(job: Job, stamp: string): string {
	const model = job.model.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
	return `${stamp}-${model}-b${job.brief}-${job.db}-${job.index}`;
}

// --- the estimate ---

/** About 4 characters a token, for English and code. */
export const tokens = (text: string | number): number =>
	Math.ceil((typeof text === "number" ? text : text.length) / 4);

/** Assumed, not measured: what the model thinks before each tool call. */
export const THINKING_PER_TURN = 1_000;

/** What the estimate of one run is made from, in characters. */
export interface RunShape {
	/** System prompt, tool definitions and brief: sent with every request. */
	readonly fixed: number;
	/** Per turn: the tool call written, and its result read. */
	readonly turns: readonly { readonly call: number; readonly result: number }[];
}

export interface Estimate {
	readonly requests: number;
	/** Input tokens over every request, most of them cache reads. */
	readonly input: number;
	readonly output: number;
}

/**
 * The tokens of one run of this shape, on either side: one request per turn,
 * each with the fixed part and the turns before it (the conversation grows),
 * plus a last request that ends the run.
 */
export function estimateRun(shape: RunShape): Estimate {
	const fixed = tokens(shape.fixed);
	let input = 0;
	let output = 0;
	let history = 0;
	for (const turn of [...shape.turns, { call: 200, result: 0 }]) {
		input += fixed + history;
		const written = tokens(turn.call) + THINKING_PER_TURN;
		output += written;
		history += written + tokens(turn.result);
	}
	return { requests: shape.turns.length + 1, input, output };
}

/**
 * The turns of a baseline run, assumed (no scripted baseline run exists to
 * measure): write app.ts, check, smoke a few requests, then once more after a
 * fix. `answer` is the size of app.ts.
 */
export function baselineTurns(
	answer: number,
): { call: number; result: number }[] {
	const round = [
		{ call: answer, result: 100 },
		{ call: 50, result: 500 },
		{ call: 1_500, result: 4_000 },
	];
	return [...round, ...round];
}

/** The reference runs the shape of a run is measured on. */
export const REFERENCE = {
	afora: join(ROOT, "runs/claude-code-2/tool-calls.json"),
	baseline: join(ROOT, "baseline/runs/claude-code-2/app.ts"),
} as const;

export async function baselineAnswerChars(): Promise<number> {
	return (await readFile(REFERENCE.baseline, "utf8")).length;
}

const format = (value: number) => value.toLocaleString("en-US");

export interface PlanRow {
	readonly side: Side;
	readonly brief: BriefVersion;
	readonly db: Db;
	readonly runs: number;
	readonly estimate: Estimate;
}

/** The text --dry-run prints: what would be run, and roughly what it costs in tokens. */
export function planText(plan: Plan, rows: readonly PlanRow[]): string {
	const jobs = jobsOf(plan).length;
	const sum = (pick: (row: PlanRow) => number) =>
		rows.reduce((total, row) => total + pick(row) * row.runs, 0);
	const requests = sum((row) => row.estimate.requests);
	const input = sum((row) => row.estimate.input);
	const output = sum((row) => row.estimate.output);
	const table = [
		[
			"side",
			"brief",
			"db",
			"runs",
			"requests",
			"input tokens",
			"output tokens",
		],
		...rows.map((row) => [
			row.side,
			String(row.brief),
			row.db,
			format(row.runs),
			`~${format(row.estimate.requests * row.runs)}`,
			`~${format(row.estimate.input * row.runs)}`,
			`~${format(row.estimate.output * row.runs)}`,
		]),
		[
			"total",
			"",
			"",
			format(jobs),
			`~${format(requests)}`,
			`~${format(input)}`,
			`~${format(output)}`,
		],
	];
	const widths = (table[0] ?? []).map((_, column) =>
		Math.max(...table.map((row) => (row[column] ?? "").length)),
	);
	const lines = table.map((row) =>
		row
			.map((cell, column) =>
				column >= 3
					? cell.padStart(widths[column] ?? 0)
					: cell.padEnd(widths[column] ?? 0),
			)
			.join("  ")
			.trimEnd(),
	);
	return [
		`Plan: ${plan.runs} runs per side, model, brief and database: ${format(jobs)} runs.`,
		`  models   ${plan.models.join(", ")}`,
		`  briefs   ${plan.briefs.join(", ")}`,
		`  db       ${plan.dbs.join(", ")}`,
		`  sides    ${plan.sides.join(", ")}`,
		`  effort   ${plan.effort}, at most ${plan.maxTurns} turns per afora run, ${plan.parallel} runs at a time`,
		"",
		"By side, brief and database, over every model:",
		...lines.map((line) => `  ${line}`),
		"",
		`Rough: ~4 characters a token, prompts measured on this checkout, an afora run shaped like runs/claude-code-2 (its tool calls and results, replayed), a baseline run assumed to write a file like baseline/runs/claude-code-2/app.ts, check it and smoke it twice (6 tool calls), and assumed thinking (${format(THINKING_PER_TURN)} tokens per turn). Most input tokens are cache reads of the system prompt and the conversation so far.`,
	].join("\n");
}
