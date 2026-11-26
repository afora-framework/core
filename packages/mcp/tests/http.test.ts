import { describe, expect, test } from "bun:test";
import { blueprintOf, commandOf, outputOf, useCaseOf } from "@afora/core";
import { jwtOf } from "@afora/core/adapters";
import { type McpTools, type McpToolsHooks, mcpTools } from "../src/index";

const secret = "a-secret-of-at-least-thirty-two-characters";
process.env.AFORA_MCP_HTTP_SECRET = secret;

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
const build = (
	options: Partial<Parameters<typeof mcpTools>[0]> = {},
	hooks?: McpToolsHooks,
) =>
	outputOf({
		name: "Notes",
		commands: [Notes],
		pipe: [mcpTools({ name: "notes", version: "1.0.0", ...options }, hooks)],
	}).build() as McpTools;

const auth = { jwt: { secret: { env: "AFORA_MCP_HTTP_SECRET" } } };
const token = (scopes: string[]) =>
	jwtOf({ secret }).sign({ subject: "u1", scopes });
const post = (body: unknown, headers: Record<string, string> = {}) =>
	new Request("http://localhost/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...headers,
		},
		body: JSON.stringify(body),
	});
const rpc = (method: string, params: unknown = {}) => ({
	jsonrpc: "2.0",
	id: 1,
	method,
	params,
});

describe("mcpTools sink: fetch", () => {
	test("tools/list and tools/call over HTTP", async () => {
		const mcp = build({ auth });
		const headers = {
			authorization: `Bearer ${await token(["notes:read"])}`,
		};
		const list = await mcp.fetch(post(rpc("tools/list"), headers));
		expect(list.status).toBe(200);
		const listed = (await list.json()) as {
			result: { tools: { name: string }[] };
		};
		expect(listed.result.tools.map((tool) => tool.name)).toEqual([
			"notes_read",
		]);

		const call = await mcp.fetch(
			post(
				rpc("tools/call", { name: "notes_read", arguments: { id: "n1" } }),
				headers,
			),
		);
		const called = (await call.json()) as {
			result: { content: { text: string }[]; isError?: boolean };
		};
		expect(called.result.isError).toBeUndefined();
		expect(JSON.parse(called.result.content[0]?.text ?? "")).toEqual({
			id: "n1",
		});
	});

	test("without a principal: 401 with WWW-Authenticate, before the handshake", async () => {
		const mcp = build({ auth });
		const response = await mcp.fetch(post(rpc("tools/list")));
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe(
			'Bearer realm="notes"',
		);
		const bad = await mcp.fetch(
			post(rpc("tools/list"), { authorization: "Bearer nope" }),
		);
		expect(bad.status).toBe(401);
		expect(bad.headers.get("www-authenticate")).toContain(
			'error="invalid_token"',
		);
	});

	test("a principal without the required scope: 403", async () => {
		const mcp = build({ auth, requiredScopes: ["notes:admin"] });
		const response = await mcp.fetch(
			post(rpc("tools/list"), {
				authorization: `Bearer ${await token(["notes:read"])}`,
			}),
		);
		expect(response.status).toBe(403);
		expect(response.headers.get("www-authenticate")).toContain(
			'error="insufficient_scope"',
		);
		const ok = await mcp.fetch(
			post(rpc("tools/list"), {
				authorization: `Bearer ${await token(["notes:admin"])}`,
			}),
		);
		expect(ok.status).toBe(200);
	});

	test("the authenticator hook is the one asked", async () => {
		const mcp = build(
			{},
			{
				authenticator: ({ header }) =>
					header("x-user") ? { subject: "u1", scopes: ["notes:read"] } : null,
			},
		);
		expect((await mcp.fetch(post(rpc("tools/list")))).status).toBe(401);
		const response = await mcp.fetch(
			post(rpc("tools/list"), { "x-user": "u1" }),
		);
		expect(response.status).toBe(200);
	});

	test("anything but POST is a 405", async () => {
		const mcp = build({ auth });
		for (const method of ["GET", "DELETE", "PUT"]) {
			const response = await mcp.fetch(
				new Request("http://localhost/mcp", { method }),
			);
			expect(response.status).toBe(405);
			expect(response.headers.get("allow")).toBe("POST");
		}
	});

	test("without an authenticator the endpoint is open; requiredScopes needs one", async () => {
		const response = await build().fetch(post(rpc("tools/list")));
		expect(response.status).toBe(200);
		expect(() => build({ requiredScopes: ["a"] })).toThrow();
	});
});
