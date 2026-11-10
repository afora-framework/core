import { createServer } from "@afora/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { stages } from "../catalogs.ts";

/** One step of a run: a tool call, or a resource the agent read. */
export type RecordedCall =
	| {
			readonly tool: string;
			readonly arguments: Record<string, unknown>;
			readonly isError: boolean;
	  }
	| { readonly resource: string };

/** The result of a tool call: its text and whether the server marked it as an error. */
export interface ToolResult {
	readonly isError: boolean;
	readonly text: string;
}

export interface McpSession {
	readonly client: Client;
	callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
	readResource(uri: string): Promise<string>;
	close(): Promise<void>;
}

/**
 * The afora MCP server for `project`, connected in memory to an MCP client:
 * the same server `afora-mcp` runs, with the Hono sink in its stages catalog.
 */
export async function connectMcp(project: string): Promise<McpSession> {
	const server = await createServer({ project, stages });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "agent-built", version: "1.0.0" });
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return {
		client,
		async callTool(name, args) {
			const result = await client.callTool({ name, arguments: args });
			const content = result.content as { type: string; text?: string }[];
			const text = content
				.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
				.join("\n");
			return { isError: result.isError === true, text };
		},
		async readResource(uri) {
			const { contents } = await client.readResource({ uri });
			return contents
				.map((content) => ("text" in content ? String(content.text) : ""))
				.join("\n");
		},
		async close() {
			await client.close();
			await server.close();
		},
	};
}
