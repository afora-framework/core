/**
 * Builds the brief with Claude without afora: the same brief and model, no
 * tools, asked for one Hono + Zod file. Each run is written to
 * baseline/runs/<name>/app.ts, with the prompt and the raw answer beside it.
 *
 *   bun scripts/build-baseline.ts [--runs 5] [--model claude-opus-5-5] [--effort high]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { CURRENT_BRIEF } from "../eval/invariants.ts";
import { baseParams, clientOrExit, modelOptions, runNames } from "./claude.ts";
import { BASELINE_INSTRUCTIONS } from "./prompts.ts";

const ROOT = resolve(import.meta.dir, "..");

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		runs: { type: "string", default: "5" },
		model: { type: "string" },
		effort: { type: "string" },
	},
});

/** The code of the first ```ts block of the answer. */
function codeOf(text: string): string | undefined {
	const match = /```(?:ts|typescript)\n([\s\S]*?)```/.exec(text);
	return match?.[1];
}

const client = clientOrExit("build-baseline");
const options = modelOptions(values);
const count = Number(values.runs);
if (!Number.isInteger(count) || count < 1)
	throw new Error("--runs must be a positive integer.");
const brief = await readFile(join(ROOT, "BRIEF.md"), "utf8");

for (const name of runNames(count)) {
	const dir = join(ROOT, "baseline/runs", name);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "run.json"),
		`${JSON.stringify({ brief: CURRENT_BRIEF })}\n`,
	);
	console.log(
		`baseline/runs/${name}: asking ${options.model} (${options.effort})...`,
	);
	await writeFile(
		join(dir, "prompts.md"),
		`# Prompts\n\nModel \`${options.model}\`, effort \`${options.effort}\`, run by \`scripts/build-baseline.ts\`.\n\n## System\n\n${BASELINE_INSTRUCTIONS}\n\n## User\n\n${brief}\n`,
	);
	let message: Anthropic.Beta.BetaMessage;
	try {
		message = await client.beta.messages
			.stream({
				...baseParams(options),
				system: BASELINE_INSTRUCTIONS,
				messages: [{ role: "user", content: brief }],
			})
			.finalMessage();
	} catch (error) {
		if (error instanceof Anthropic.APIError) {
			console.error(
				`baseline/runs/${name}: API error ${error.status}: ${error.message}`,
			);
		}
		throw error;
	}
	const text = message.content
		.filter(
			(block): block is Anthropic.Beta.BetaTextBlock => block.type === "text",
		)
		.map((block) => block.text)
		.join("\n");
	await writeFile(join(dir, "answer.md"), `${text}\n`);
	if (message.stop_reason !== "end_turn") {
		console.error(
			`baseline/runs/${name}: stopped on ${message.stop_reason}; see answer.md.`,
		);
		continue;
	}
	const code = codeOf(text);
	if (!code) {
		console.error(
			`baseline/runs/${name}: no code block in the answer; see answer.md.`,
		);
		continue;
	}
	await writeFile(join(dir, "app.ts"), code);
	console.log(`baseline/runs/${name}: wrote app.ts.`);
}
console.log("Done. Evaluate them with: bun run eval");
