/**
 * Builds the brief with Claude, through the afora MCP server only: a tool-use
 * loop whose tools are the server's tools, run in process. Each run gets a
 * fresh directory under runs/ with what it did and what it made:
 *
 *   transcript.jsonl   every message of the conversation, one per line
 *   tool-calls.json    the tool calls, in order (what scripts/replay.ts replays)
 *   prompts.md         the system prompt and the first message, as sent
 *   run.json           the brief, model, effort and database of the run
 *   afora.json, src/domain/   the spec and the generated code
 *
 *   bun scripts/build-with-agent.ts [--runs 5] [--brief 2] [--db memory|sqlite] [--model claude-opus-5-5] [--effort high] [--max-turns 60]
 *
 * scripts/eval.ts runs it for N runs per model, brief and database.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
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
import { connectMcp, type McpSession, type RecordedCall } from "./mcp.ts";
import { agentInstructions } from "./prompts.ts";
import { briefText, type Db, isDb, writeDbModule } from "./storage.ts";

const ROOT = resolve(import.meta.dir, "..");

/** The system prompt: the instructions, then the guide and the catalog of the server. */
export async function systemPrompt(
	mcp: McpSession,
	db: Db = "memory",
): Promise<string> {
	const guide = await mcp.readResource("afora://spec/guide");
	const catalog = await mcp.readResource("afora://catalog");
	return `${agentInstructions(db)}\n\n<resource uri="afora://spec/guide">\n${guide}\n</resource>\n\n<resource uri="afora://catalog">\n${catalog}\n</resource>`;
}

export async function toolsOf(
	mcp: McpSession,
): Promise<Anthropic.Beta.BetaTool[]> {
	const { tools } = await mcp.client.listTools();
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description ?? "",
		input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
		// inputs stream as generated; the MCP server validates each one against
		// its schema and answers an invalid one with an error result
		eager_input_streaming: true,
	}));
}

/** One afora run: the brief, database and model it is built with. */
export interface AgentRun {
	readonly options: ModelOptions;
	readonly brief: BriefVersion;
	readonly db: Db;
	readonly maxTurns: number;
}

export async function buildAgentRun(
	client: Anthropic,
	{ options, brief: version, db, maxTurns }: AgentRun,
	dir: string,
): Promise<{ turns: number; calls: number; stop: string }> {
	await mkdir(dir, { recursive: true });
	// afora_generate type-checks the project with this tsconfig
	await writeFile(
		join(dir, "tsconfig.json"),
		`${JSON.stringify({ extends: "../../tsconfig.json", include: ["src"] }, null, "\t")}\n`,
	);
	const brief = await briefText(version, db);
	await writeRunJson(dir, { brief: version, db, ...options });
	if (db === "sqlite") await writeDbModule(dir);
	const mcp = await connectMcp(dir, db);
	const calls: RecordedCall[] = [];
	const transcript = join(dir, "transcript.jsonl");
	const log = (entry: unknown) =>
		appendFile(transcript, `${JSON.stringify(entry)}\n`);
	try {
		const system = await systemPrompt(mcp, db);
		const tools = await toolsOf(mcp);
		await writeFile(
			join(dir, "prompts.md"),
			`# Prompts\n\nModel \`${options.model}\`, effort \`${options.effort}\`, run by \`scripts/build-with-agent.ts\`.\n\n## System\n\n${system}\n\n## User\n\n${brief}\n`,
		);
		const messages: Anthropic.Beta.BetaMessageParam[] = [
			{ role: "user", content: brief },
		];
		await log({ role: "user", content: brief });
		let stop = "max-turns";
		let turn = 0;
		for (; turn < maxTurns; turn++) {
			const message = await client.beta.messages
				.stream({ ...baseParams(options), system, tools, messages })
				.finalMessage();
			await log({
				role: "assistant",
				content: message.content,
				stop_reason: message.stop_reason,
				usage: message.usage,
			});
			if (message.stop_reason === "refusal") {
				stop = "refusal";
				break;
			}
			if (message.stop_reason === "max_tokens") {
				// a tool input cut off here can still parse; never run it
				stop = "max_tokens";
				break;
			}
			messages.push({ role: "assistant", content: message.content });
			if (message.stop_reason === "pause_turn") continue;
			const uses = message.content.filter(
				(block): block is Anthropic.Beta.BetaToolUseBlock =>
					block.type === "tool_use",
			);
			if (uses.length === 0) {
				stop = message.stop_reason ?? "end_turn";
				break;
			}
			const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
			for (const use of uses) {
				const args = (use.input ?? {}) as Record<string, unknown>;
				const result = await mcp.callTool(use.name, args);
				calls.push({
					tool: use.name,
					arguments: args,
					isError: result.isError,
				});
				results.push({
					type: "tool_result",
					tool_use_id: use.id,
					content: result.text,
					...(result.isError ? { is_error: true } : {}),
				});
			}
			messages.push({ role: "user", content: results });
			await log({ role: "user", content: results });
		}
		await writeRunJson(dir, { brief: version, db, ...options, stop });
		return { turns: turn + 1, calls: calls.length, stop };
	} finally {
		await mcp.close();
		await writeFile(
			join(dir, "tool-calls.json"),
			`${JSON.stringify(calls, null, "\t")}\n`,
		);
	}
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
	const client = clientOrExit("build-with-agent");
	const options = modelOptions(values);
	const count = Number(values.runs);
	const maxTurns = Number(values["max-turns"]);
	const brief = Number(values.brief);
	if (!Number.isInteger(count) || count < 1)
		throw new Error("--runs must be a positive integer.");
	if (!isBriefVersion(brief)) throw new Error("--brief must be 1, 2 or 3.");
	if (!isDb(values.db)) throw new Error("--db must be memory or sqlite.");
	const db = values.db;

	for (const name of runNames(count)) {
		const dir = join(ROOT, "runs", name);
		console.log(
			`runs/${name}: building brief ${brief} (${db}) with ${options.model} (${options.effort})...`,
		);
		try {
			const { turns, calls, stop } = await buildAgentRun(
				client,
				{ options, brief, db, maxTurns },
				dir,
			);
			console.log(
				`runs/${name}: ${calls} tool calls in ${turns} turns, stopped on ${stop}.`,
			);
		} catch (error) {
			if (error instanceof Anthropic.APIError) {
				console.error(
					`runs/${name}: API error ${error.status}: ${error.message}`,
				);
			}
			throw error;
		}
	}
	console.log("Done. Evaluate them with: bun run eval");
}
