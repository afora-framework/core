/**
 * Replays the tool calls of a run through the afora MCP server into a fresh
 * directory: what the agent did, without the agent. The result is the
 * afora.json and src/domain the run produced, byte for byte.
 *
 *   bun scripts/replay.ts runs/claude-code-1/tool-calls.json .tmp/replayed
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { connectMcp, type RecordedCall } from "./mcp.ts";

export interface ReplayOptions {
	/** Run tsc after each `afora_generate`, as the agent did. Off by default: it does not change the files. */
	readonly typecheck?: boolean;
}

export async function readCalls(file: string): Promise<RecordedCall[]> {
	return JSON.parse(await readFile(file, "utf8")) as RecordedCall[];
}

/**
 * Replays `calls` into `dir`, emptied first. Throws when a call fails where
 * the run's call succeeded, or the other way round: the replay is the run.
 */
export async function replay(
	calls: readonly RecordedCall[],
	dir: string,
	options: ReplayOptions = {},
): Promise<void> {
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	const mcp = await connectMcp(dir);
	try {
		for (const [index, call] of calls.entries()) {
			if ("resource" in call) continue; // reading changes nothing
			const args =
				call.tool === "afora_generate" && options.typecheck !== true
					? { ...call.arguments, typecheck: false }
					: call.arguments;
			const result = await mcp.callTool(call.tool, args);
			if (result.isError !== call.isError) {
				throw new Error(
					`Call ${index} (${call.tool}) ${result.isError ? "failed" : "succeeded"} on replay but ${call.isError ? "failed" : "succeeded"} in the run: ${result.text.slice(0, 500)}`,
				);
			}
		}
	} finally {
		await mcp.close();
	}
}

if (import.meta.main) {
	const [file, out] = Bun.argv.slice(2);
	if (!file || !out) {
		throw new Error("Usage: bun scripts/replay.ts <tool-calls.json> <dir>");
	}
	await replay(await readCalls(resolve(file)), resolve(out));
	console.log(`Replayed ${file} into ${out}.`);
}
