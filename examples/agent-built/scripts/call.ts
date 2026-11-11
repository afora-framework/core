/**
 * One MCP tool call (or resource read) on this project, appended to a log.
 * This is how the `runs/claude-code-1` run was made: a Claude Code session
 * called the afora MCP server one step at a time, and every step it took,
 * failed ones included, is in the log `scripts/replay.ts` replays.
 *
 *   bun scripts/call.ts --log runs/x/tool-calls.json afora_catalog
 *   bun scripts/call.ts --log runs/x/tool-calls.json afora_spec_upsert '{"kind":"entity",...}'
 *   bun scripts/call.ts --log runs/x/tool-calls.json --resource afora://spec/guide
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { connectMcp, type RecordedCall } from "./mcp.ts";

const { values, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		log: { type: "string" },
		resource: { type: "string" },
		project: { type: "string", default: "." },
	},
	allowPositionals: true,
});
if (!values.log) throw new Error("--log <file> is required.");

const log = resolve(values.log);
const calls: RecordedCall[] = existsSync(log)
	? JSON.parse(await readFile(log, "utf8"))
	: [];

const mcp = await connectMcp(resolve(values.project));
try {
	if (values.resource) {
		console.log(await mcp.readResource(values.resource));
		calls.push({ resource: values.resource });
	} else {
		const [tool, args = "{}"] = positionals;
		if (!tool) throw new Error("Give a tool name.");
		const parsed = JSON.parse(args) as Record<string, unknown>;
		const result = await mcp.callTool(tool, parsed);
		console.log(result.isError ? `ERROR: ${result.text}` : result.text);
		calls.push({ tool, arguments: parsed, isError: result.isError });
	}
} finally {
	await mcp.close();
}
await mkdir(dirname(log), { recursive: true });
await writeFile(log, `${JSON.stringify(calls, null, "\t")}\n`);
