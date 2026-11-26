import { describe, expect, test } from "bun:test";
import { blueprintOf, commandOf, outputOf, useCaseOf } from "@afora/core";
import { Hono } from "hono";
import { type McpTools, mcpTools } from "../../mcp/src/index";
import { mountMcp } from "../src/index";

class Read extends useCaseOf({
	name: "Read",
	description: "Reads a note.",
	blueprint: blueprintOf((ctx) => ({ id: ctx.string })),
	response: blueprintOf((ctx) => ({ id: ctx.string })),
	route: { method: "get", path: "/notes/{id}" },
	access: { scopes: ["notes:read"] },
}) {
	override async execute() {
		return { id: this.input.id };
	}
}
const Notes = commandOf({ name: "Notes", useCases: { read: Read } });
const tools = outputOf({
	name: "Notes",
	commands: [Notes],
	pipe: [
		mcpTools(
			{ name: "notes", version: "1.0.0", requiredScopes: ["notes:read"] },
			{
				authenticator: ({ header }) =>
					header("x-scope")
						? { subject: "u1", scopes: [header("x-scope") ?? ""] }
						: null,
			},
		),
	],
}).build() as McpTools;

const app = mountMcp(new Hono(), "/api/mcp", tools);
app.get("/health", (c) => c.text("up"));
const post = (body: unknown, headers: Record<string, string> = {}) =>
	app.request("/api/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...headers,
		},
		body: JSON.stringify(body),
	});

describe("mountMcp", () => {
	test("serves tools/list and tools/call at a path of the same app", async () => {
		expect(await (await app.request("/health")).text()).toBe("up");
		const headers = { "x-scope": "notes:read" };
		const list = await post(
			{ jsonrpc: "2.0", id: 1, method: "tools/list" },
			headers,
		);
		const listed = (await list.json()) as {
			result: { tools: { name: string }[] };
		};
		expect(listed.result.tools.map((tool) => tool.name)).toEqual([
			"notes_read",
		]);
		const call = await post(
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "notes_read", arguments: { id: "n1" } },
			},
			headers,
		);
		const called = (await call.json()) as {
			result: { content: { text: string }[] };
		};
		expect(JSON.parse(called.result.content[0]?.text ?? "")).toEqual({
			id: "n1",
		});
	});

	test("401 without credentials, 403 without the scope, 405 for a GET", async () => {
		const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
		const none = await post(body);
		expect(none.status).toBe(401);
		expect(none.headers.get("www-authenticate")).toContain("Bearer");
		expect((await post(body, { "x-scope": "other" })).status).toBe(403);
		expect((await app.request("/api/mcp")).status).toBe(405);
	});
});
