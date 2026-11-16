/**
 * Builds the brief with Claude without afora, on the same footing as an afora
 * run: the same tool loop (scripts/loop.ts), model, effort and turns, with
 * tools to write and read the files of its project, type-check them and send
 * requests to its app (scripts/workspace.ts), in place of the afora MCP tools.
 * Each run is written to baseline/runs/<name>/: app.ts and any file it wrote,
 * transcript.jsonl, tool-calls.json, prompts.md and run.json.
 *
 *   bun scripts/build-baseline.ts [--runs 5] [--brief 2] [--db memory|sqlite] [--model claude-opus-5-5] [--effort high] [--max-turns 60]
 *
 * scripts/eval.ts runs it for N runs per model, brief and database.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import {
	type BriefVersion,
	CURRENT_BRIEF,
	isBriefVersion,
} from "../eval/invariants.ts";
import {
	clientOrExit,
	type ModelOptions,
	modelOptions,
	runNames,
	writeRunJson,
} from "./claude.ts";
import { toolLoop } from "./loop.ts";
import { baselineInstructions } from "./prompts.ts";
import { briefText, type Db, isDb } from "./storage.ts";
import { BASELINE_TOOL_DEFINITIONS, baselineTools } from "./workspace.ts";

const ROOT = resolve(import.meta.dir, "..");

/** One baseline run: the brief, database, model and turns it is built with. */
export interface BaselineRun {
	readonly options: ModelOptions;
	readonly brief: BriefVersion;
	readonly db: Db;
	readonly maxTurns: number;
}

/**
 * Runs the loop in `dir`. A run that ends without app.ts keeps its
 * directory, and the evaluation counts it as failing every invariant; an API
 * error is thrown.
 */
export async function buildBaselineRun(
	client: Anthropic,
	{ options, brief: version, db, maxTurns }: BaselineRun,
	dir: string,
): Promise<{ turns: number; calls: number; stop: string; wrote: boolean }> {
	await mkdir(dir, { recursive: true });
	// `check` type-checks the project with this tsconfig
	await writeFile(
		join(dir, "tsconfig.json"),
		`${JSON.stringify({ extends: "../../../tsconfig.json", include: ["**/*.ts"], exclude: ["node_modules"] }, null, "\t")}\n`,
	);
	const brief = await briefText(version, db);
	const system = baselineInstructions(db, version);
	await writeRunJson(dir, { brief: version, db, ...options });
	await writeFile(
		join(dir, "prompts.md"),
		`# Prompts\n\nModel \`${options.model}\`, effort \`${options.effort}\`, run by \`scripts/build-baseline.ts\`.\n\n## System\n\n${system}\n\n## Tools\n\n${BASELINE_TOOL_DEFINITIONS.map((tool) => `- \`${tool.name}\`: ${tool.description}`).join("\n")}\n\n## User\n\n${brief}\n`,
	);
	const result = await toolLoop({
		client,
		options,
		system,
		tools: BASELINE_TOOL_DEFINITIONS,
		brief,
		maxTurns,
		dir,
		call: baselineTools(dir, db),
	});
	const wrote = existsSync(join(dir, "app.ts"));
	await writeRunJson(dir, {
		brief: version,
		db,
		...options,
		stop: wrote ? result.stop : `${result.stop}, no app.ts`,
	});
	return { ...result, wrote };
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			runs: { type: "string", default: "5" },
			brief: { type: "string", default: String(CURRENT_BRIEF) },
			db: { type: "string", default: "memory" },
			model: { type: "string" },
			effort: { type: "string" },
			"max-turns": { type: "string", default: "60" },
		},
	});
	const client = clientOrExit("build-baseline");
	const maxTurns = Number(values["max-turns"]);
	const options = modelOptions(values);
	const count = Number(values.runs);
	const brief = Number(values.brief);
	if (!Number.isInteger(count) || count < 1)
		throw new Error("--runs must be a positive integer.");
	if (!isBriefVersion(brief)) throw new Error("--brief must be 1, 2 or 3.");
	if (!isDb(values.db)) throw new Error("--db must be memory or sqlite.");
	const db = values.db;

	for (const name of runNames(count)) {
		const dir = join(ROOT, "baseline/runs", name);
		console.log(
			`baseline/runs/${name}: asking ${options.model} (${options.effort}) for brief ${brief} (${db})...`,
		);
		try {
			const { stop, wrote } = await buildBaselineRun(
				client,
				{ options, brief, db, maxTurns },
				dir,
			);
			console.log(
				wrote
					? `baseline/runs/${name}: wrote app.ts.`
					: `baseline/runs/${name}: no app.ts (${stop}); see answer.md.`,
			);
		} catch (error) {
			if (error instanceof Anthropic.APIError) {
				console.error(
					`baseline/runs/${name}: API error ${error.status}: ${error.message}`,
				);
			}
			throw error;
		}
	}
	console.log("Done. Evaluate them with: bun run eval");
}
