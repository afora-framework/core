/**
 * The tool-use loop both sides of the evaluation run: the same model, effort,
 * turns and stop rules, only the tools differ (the afora MCP server, or the
 * files, type check and smoke requests of a baseline). It writes
 * transcript.jsonl and tool-calls.json into the run directory.
 */
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { baseParams, type ModelOptions } from "./claude.ts";
import type { RecordedCall, ToolResult } from "./mcp.ts";

export interface LoopInput {
	readonly client: Anthropic;
	readonly options: ModelOptions;
	readonly system: string;
	readonly tools: Anthropic.Beta.BetaTool[];
	readonly brief: string;
	readonly maxTurns: number;
	readonly dir: string;
	readonly call: (
		name: string,
		args: Record<string, unknown>,
	) => Promise<ToolResult>;
}

export interface LoopResult {
	readonly turns: number;
	readonly calls: number;
	/** end_turn, max-turns, max_tokens, refusal... */
	readonly stop: string;
}

export async function toolLoop(input: LoopInput): Promise<LoopResult> {
	const { client, options, system, tools, brief, maxTurns, dir, call } = input;
	const calls: RecordedCall[] = [];
	const transcript = join(dir, "transcript.jsonl");
	const log = (entry: unknown) =>
		appendFile(transcript, `${JSON.stringify(entry)}\n`);
	const messages: Anthropic.Beta.BetaMessageParam[] = [
		{ role: "user", content: brief },
	];
	await log({ role: "user", content: brief });
	let stop = "max-turns";
	let turn = 0;
	try {
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
				const result = await call(use.name, args);
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
		return { turns: turn + 1, calls: calls.length, stop };
	} finally {
		await writeFile(
			join(dir, "tool-calls.json"),
			`${JSON.stringify(calls, null, "\t")}\n`,
		);
	}
}
