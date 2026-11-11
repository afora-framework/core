import { describe, expect, test } from "bun:test";
import { blueprintOf, commandOf, outputOf, useCaseOf } from "@afora/core";
import { jwtOf } from "@afora/core/experimental";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type McpTools, type McpToolsHooks, mcpTools } from "../src/index";

const secret = "a-secret-of-at-least-thirty-two-characters";
process.env.AFORA_MCP_TEST_SECRET = secret;

class Read extends useCaseOf({
	name: "Read",
	description: "Reads a note.",
	blueprint: blueprintOf((ctx) => ({ id: ctx.string })),
	response: blueprintOf((ctx) => ({ id: ctx.string })),
	route: { method: "get", path: "/notes/{id}" },
}) {
	override async execute() {
		return { id: this.input.id };
	}
}
class Remove extends useCaseOf({
	name: "Remove",
	blueprint: blueprintOf((ctx) => ({ id: ctx.string })),
	response: blueprintOf((ctx) => ({ by: ctx.string })),
	context: blueprintOf((ctx) => ({ userId: ctx.string })),
	route: { method: "delete", path: "/notes/{id}" },
	access: { scopes: ["notes:write"], context: { userId: "subject" } },
}) {
	override async execute() {
		return { by: this.context.userId };
	}
}
const Notes = commandOf({
	name: "Notes",
	useCases: { read: Read, remove: Remove },
});
const build = (
	options: Partial<Parameters<typeof mcpTools>[0]> = {},
	hooks?: McpToolsHooks,
) =>
	outputOf({
		name: "Notes",
		commands: [Notes],
		pipe: [mcpTools({ name: "notes", version: "1.0.0", ...options }, hooks)],
	}).build() as McpTools;
const parse = (result: { content: readonly { text: string }[] }) =>
	JSON.parse(result.content[0]?.text ?? "null");
const writer = { subject: "u1", scopes: ["notes:write"] };

describe("mcpTools sink: access", () => {
	test("a tool says what it requires, and hints what it does", () => {
		const { tools } = build();
		expect(
			tools.map(({ name, description, annotations }) => [
				name,
				description,
				annotations,
			]),
		).toEqual([
			[
				"notes_read",
				"Reads a note.",
				{ readOnlyHint: true, destructiveHint: false },
			],
			[
				"notes_remove",
				"Notes.remove Requires an authenticated caller with the scopes: notes:write.",
				{ readOnlyHint: false, destructiveHint: true },
			],
		]);
	});

	test("without a caller, a tool with an access is closed; the others run", async () => {
		const mcp = build();
		expect(parse(await mcp.call("notes_read", { id: "n1" }))).toEqual({
			id: "n1",
		});
		const closed = await mcp.call("notes_remove", { id: "n1" });
		expect(closed.isError).toBe(true);
		expect(parse(closed)).toMatchObject({
			title: "Unauthenticated",
			status: 401,
		});
	});

	test("the host may give the caller, or an authenticator find it", async () => {
		const given = await build().call(
			"notes_remove",
			{ id: "n1" },
			{ principal: writer },
		);
		expect(parse(given)).toEqual({ by: "u1" });
		const lacking = await build().call(
			"notes_remove",
			{ id: "n1" },
			{ principal: { subject: "u2", scopes: [] } },
		);
		expect(parse(lacking)).toMatchObject({ title: "Forbidden", status: 403 });
		const mcp = build(
			{},
			{
				authenticator: (request) =>
					request.header("x-user") === "ana" ? writer : null,
			},
		);
		expect(
			parse(
				await mcp.call(
					"notes_remove",
					{ id: "n1" },
					{ values: { "x-user": "ana" } },
				),
			),
		).toEqual({ by: "u1" });
		expect(
			parse(await mcp.call("notes_remove", { id: "n1" }, { values: {} }))
				.status,
		).toBe(401);
	});

	test("the auth option reads a token from the values of the call", async () => {
		const options = {
			auth: { jwt: { secret: { env: "AFORA_MCP_TEST_SECRET" } } },
		} as const;
		const token = await jwtOf({ secret }).sign(writer);
		const mcp = build(options);
		expect(
			parse(
				await mcp.call(
					"notes_remove",
					{ id: "n1" },
					{ values: { authorization: `Bearer ${token}` } },
				),
			),
		).toEqual({ by: "u1" });
		expect(
			parse(
				await mcp.call(
					"notes_remove",
					{ id: "n1" },
					{ values: { authorization: "Bearer nope" } },
				),
			).status,
		).toBe(401);
		expect(() => build({ auth: { jwt: { secret } } } as never)).toThrow();
		// Over the protocol, the token travels in the request _meta.
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test", version: "1.0.0" });
		await Promise.all([
			mcp.server().connect(serverTransport),
			client.connect(clientTransport),
		]);
		const listed = await client.listTools();
		expect(listed.tools[1]?.annotations?.destructiveHint).toBe(true);
		const result = await client.callTool({
			name: "notes_remove",
			arguments: { id: "n1" },
			_meta: { authorization: `Bearer ${token}` },
		});
		expect(parse(result as never)).toEqual({ by: "u1" });
		await client.close();
	});
});
