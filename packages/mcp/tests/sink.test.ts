import { describe, expect, test } from "bun:test";
import { outputOf, StdStages } from "@afora/core";
import { stageDescriptionOf } from "@afora/core/experimental";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { blog, requireAuth } from "../../hono/tests/blog";
import { McpStages, type McpTools, mcpTools, stages } from "../src/index";

function build(
	options: Partial<Parameters<typeof mcpTools>[0]> = {},
	auth = false,
) {
	const { Users, Posts } = blog();
	return outputOf({
		name: "Blog",
		commands: [Users, Posts],
		statuses: { Unauthorized: 401, InvalidCredentials: 401 },
		pipe: [
			...(auth ? [requireAuth()] : []),
			mcpTools({
				name: "blog",
				version: "1.0.0",
				context: { authorization: "authorization", limit: "x-limit" },
				...options,
			}),
		],
	}).build() as McpTools;
}

const ana = {
	name: "Ana",
	email: "ana@example.com",
	plainPassword: "S3cret-pass!",
};
const parse = (result: { content: readonly { text: string }[] }) =>
	JSON.parse(result.content[0]?.text ?? "null");

describe("mcpTools sink", () => {
	test("lists one tool per operation with inline input schemas", () => {
		const { tools } = build({ prefix: "blog_" });
		expect(tools.map((tool) => tool.name)).toEqual([
			"blog_users_register",
			"blog_users_login",
			"blog_posts_publish",
			"blog_posts_list",
		]);
		for (const tool of tools) {
			expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
			expect(tool.inputSchema.type).toBe("object");
			expect(JSON.stringify(tool.inputSchema)).not.toContain("$ref");
		}
		const register = tools[0];
		expect(register?.description).toBe("Creates an account.");
		expect(register?.inputSchema.required).toEqual([
			"name",
			"email",
			"plainPassword",
		]);
		expect(
			build({ include: ["Posts.list"] }).tools.map((t) => t.operation),
		).toEqual(["Posts.list"]);
	});

	test("a call returns the masked response", async () => {
		const mcp = build();
		const result = await mcp.call("users_register", ana);
		expect(result.isError).toBeUndefined();
		const { user } = parse(result);
		expect(user.email).toBe("ana@example.com");
		expect(user.password).toBe("********");
		expect(result.content[0]?.text).not.toContain("argon2");
	});

	test("a declared error is a problem with isError", async () => {
		const mcp = build();
		const result = await mcp.call("users_login", {
			email: ana.email,
			plainPassword: "nope",
		});
		expect(result.isError).toBe(true);
		const problem = parse(result);
		expect(problem.title).toBe("InvalidCredentials");
		expect(problem.status).toBe(401);
	});

	test("invalid input is a 400 with issues; unknown tool is a 404", async () => {
		const mcp = build();
		const bad = await mcp.call("users_register", { name: "" });
		expect(bad.isError).toBe(true);
		const problem = parse(bad);
		expect(problem.status).toBe(400);
		expect(problem.issues.length).toBeGreaterThan(0);
		const missing = await mcp.call("nope", {});
		expect(missing.isError).toBe(true);
		expect(parse(missing).status).toBe(404);
	});

	test("context comes from extra.values through the mapping", async () => {
		const mcp = build({}, true);
		const denied = await mcp.call("posts_publish", { title: "Hi" });
		expect(denied.isError).toBe(true);
		expect(parse(denied).status).toBe(401);
		const ok = await mcp.call(
			"posts_publish",
			{ title: "Hi" },
			{ values: { authorization: "Bearer ana@example.com", "x-limit": "3" } },
		);
		expect(parse(ok).post.authorEmail).toBe("ana@example.com");
	});

	test("validates its options and exposes the catalog", () => {
		expect(() => mcpTools({ name: "", version: "1" })).toThrow();
		expect(() =>
			mcpTools({ name: "a", version: "1", prefix: "a b" }),
		).toThrow();
		expect(() =>
			mcpTools({ name: "a", version: "1", extra: 1 } as never),
		).toThrow();
		expect(() => build({ include: ["Nope.x"] })).toThrow();
		expect(
			stageDescriptionOf(mcpTools({ name: "a", version: "1" })),
		).toMatchObject({
			kind: "sink",
			name: "mcpTools",
		});
		expect(Object.keys(McpStages.stages)).toEqual(["mcpTools"]);
		expect(
			McpStages.resolve("mcpTools", { name: "a", version: "1" }).kind,
		).toBe("sink");
		expect(Object.keys(StdStages.stages)).not.toContain("mcpTools");
		expect(stages).toEqual([
			{
				name: "mcpTools",
				module: "@afora/mcp",
				export: "mcpTools",
				kind: "sink",
			},
		]);
	});

	test("end to end over the SDK in-memory transport", async () => {
		const server = build().server();
		const client = new Client({ name: "test", version: "1.0.0" });
		const [a, b] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(a), client.connect(b)]);

		const listed = await client.listTools();
		expect(listed.tools.map((tool) => tool.name)).toContain("users_register");

		const result = await client.callTool({
			name: "users_register",
			arguments: ana,
		});
		const content = result.content as { text: string }[];
		expect(JSON.parse(content[0]?.text ?? "").user.password).toBe("********");

		const failed = await client.callTool({
			name: "users_register",
			arguments: { name: "" },
		});
		expect(failed.isError).toBe(true);
		await client.close();
	});
});
