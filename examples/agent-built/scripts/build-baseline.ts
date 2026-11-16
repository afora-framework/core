/**
 * Builds the brief with Claude without afora: the same brief and model, no
 * tools, asked for one Hono + Zod file (on bun:sqlite with `--db sqlite`).
 * Each run is written to baseline/runs/<name>/app.ts, with the prompt, the
 * raw answer and its run.json beside it.
 *
 *   bun scripts/build-baseline.ts [--runs 5] [--brief 2] [--db memory|sqlite] [--model claude-opus-5-5] [--effort high]
 *
 * scripts/eval.ts runs it for N runs per model, brief and database.
 */
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
	baseParams,
	clientOrExit,
	type ModelOptions,
	modelOptions,
	runNames,
	writeRunJson,
} from "./claude.ts";
import { baselineInstructions } from "./prompts.ts";
import { briefText, type Db, isDb } from "./storage.ts";

const ROOT = resolve(import.meta.dir, "..");

/** The code of the first ```ts block of the answer. */
export function codeOf(text: string): string | undefined {
	const match = /```(?:ts|typescript)\n([\s\S]*?)```/.exec(text);
	return match?.[1];
}

/** One baseline run: the brief, database and model it is built with. */
export interface BaselineRun {
	readonly options: ModelOptions;
	readonly brief: BriefVersion;
	readonly db: Db;
}

/**
 * Asks for the file and writes it. A run whose answer has no code (cut off,
 * refused, no block) keeps its directory without app.ts, and the evaluation
 * counts it as failing every invariant; an API error is thrown.
 */
export async function buildBaselineRun(
	client: Anthropic,
	{ options, brief: version, db }: BaselineRun,
	dir: string,
): Promise<{ stop: string; wrote: boolean }> {
	await mkdir(dir, { recursive: true });
	const brief = await briefText(version, db);
	const system = baselineInstructions(db);
	await writeRunJson(dir, { brief: version, db, ...options });
	await writeFile(
		join(dir, "prompts.md"),
		`# Prompts\n\nModel \`${options.model}\`, effort \`${options.effort}\`, run by \`scripts/build-baseline.ts\`.\n\n## System\n\n${system}\n\n## User\n\n${brief}\n`,
	);
	const message = await client.beta.messages
		.stream({
			...baseParams(options),
			system,
			messages: [{ role: "user", content: brief }],
		})
		.finalMessage();
	const text = message.content
		.filter(
			(block): block is Anthropic.Beta.BetaTextBlock => block.type === "text",
		)
		.map((block) => block.text)
		.join("\n");
	await writeFile(join(dir, "answer.md"), `${text}\n`);
	const code = message.stop_reason === "end_turn" ? codeOf(text) : undefined;
	const stop =
		message.stop_reason !== "end_turn"
			? (message.stop_reason ?? "unknown")
			: code
				? "end_turn"
				: "no code block";
	await writeRunJson(dir, { brief: version, db, ...options, stop });
	if (code) await writeFile(join(dir, "app.ts"), code);
	return { stop, wrote: code !== undefined };
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
		},
	});
	const client = clientOrExit("build-baseline");
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
				{ options, brief, db },
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
