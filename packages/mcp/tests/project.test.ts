import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Connected, connect, makeProject, removeProject } from "./project";

const projects: string[] = [];
const clients: Connected[] = [];
afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
});
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

async function setup(
	files: Record<string, string> = {},
	options: { app?: string } = {},
) {
	const dir = await makeProject(files);
	projects.push(dir);
	const client = await connect({ project: dir, ...options });
	clients.push(client);
	return { dir, client };
}

// A project written by hand: no afora.json, a hand-written execute, decorators.
const APP_TS = `import {
	Access,
	applicationOf,
	blueprintOf,
	commandOf,
	entityOf,
	inMemoryProvider,
	openapi,
	outputOf,
	Route,
	repositoryOf,
	useCaseOf,
} from "@afora/core";

export class Post extends entityOf(
	blueprintOf((ctx) => ({ slug: ctx.slug, title: ctx.text })),
	{ unique: ["slug"] },
) {}
export const Posts = repositoryOf({
	entity: Post,
	actions: ["findBySlug", "create"],
});

@Route("GET", "/posts/{slug}")
export class GetPost extends useCaseOf({
	name: "GetPost",
	description: "One post, by slug.",
	blueprint: blueprintOf((ctx) => ({ slug: ctx.slug })),
	response: blueprintOf(() => ({ post: Post })),
	dependencies: { posts: Posts },
}) {
	override async execute() {
		const post = await this.dependencies.posts.findBySlug(this.input.slug);
		if (!post) throw new Error("missing");
		return { post };
	}
}

@Route("POST", "/posts", { status: 201 })
@Access({ scopes: ["posts:write"], context: { userId: "subject" } })
export class WritePost extends useCaseOf({
	name: "WritePost",
	blueprint: blueprintOf((ctx) => ({ slug: ctx.slug, title: ctx.text })),
	response: blueprintOf(() => ({ post: Post })),
	context: blueprintOf((ctx) => ({ userId: ctx.string })),
	dependencies: { posts: Posts },
}) {
	override async execute() {
		return { post: await this.dependencies.posts.create(new Post(this.input)) };
	}
}

export class Ping extends useCaseOf({
	name: "Ping",
	blueprint: blueprintOf(() => ({})),
	response: blueprintOf((ctx) => ({ ok: ctx.boolean })),
}) {
	override async execute() {
		return { ok: true };
	}
}

export const Blog = commandOf({
	name: "Blog",
	useCases: { getPost: GetPost, writePost: WritePost },
});
export const Health = commandOf({ name: "Health", useCases: { ping: Ping } });
export const Docs = outputOf({
	name: "Docs",
	commands: [Blog],
	pipe: [
		openapi({
			info: { title: "Blog", version: "1.0.0" },
			basePath: "/api",
			route: { "Blog.getPost": { path: "/articles/{slug}" } },
		}),
	],
});

export const App = applicationOf({
	name: "blog",
	entities: { Post },
	repositories: { Posts },
	useCases: { GetPost, WritePost, Ping },
	commands: { Blog, Health },
	outputs: { Docs },
	provider: inMemoryProvider(),
});
`;

describe("afora_project", () => {
	test("maps a project written in code, with no afora.json", async () => {
		const { client } = await setup(
			{ "src/app.ts": APP_TS },
			{ app: "src/app.ts#App" },
		);
		const { isError, data } = await client.call("afora_project");
		expect(isError, JSON.stringify(data)).toBe(false);
		expect(data.source).toBe("app");
		expect(data.name).toBe("blog");
		expect(data.entities).toEqual([
			{ name: "Post", fields: ["slug", "title"], plugins: [] },
		]);
		expect(data.repositories).toEqual([
			{ name: "Posts", entity: "Post", actions: ["findBySlug", "create"] },
		]);
		expect(
			data.operations.map((operation: Record<string, unknown>) => [
				operation.id,
				operation.implementation,
				operation.route,
				operation.access,
			]),
		).toEqual([
			[
				"Blog.getPost",
				"code",
				{ method: "get", path: "/posts/{slug}" },
				undefined,
			],
			[
				"Blog.writePost",
				"code",
				{ method: "post", path: "/posts", status: 201 },
				{ scopes: ["posts:write"], context: { userId: "subject" } },
			],
			["Health.ping", "code", undefined, undefined],
		]);
		expect(data.operations[0].description).toBe("One post, by slug.");
		expect(data.operations[0].input).toEqual(["slug"]);
		expect(data.outputs).toEqual([
			{
				name: "Docs",
				sink: "openapi",
				basePath: "/api",
				authentication:
					"not in the sink options (an authenticator hook is code)",
				routes: [
					{
						operation: "Blog.getPost",
						useCase: "GetPost",
						method: "get",
						path: "/api/articles/{slug}",
						status: 200,
						routedBy: "sink",
						access: "open",
					},
					{
						operation: "Blog.writePost",
						useCase: "WritePost",
						method: "post",
						path: "/api/posts",
						status: 201,
						routedBy: "use case",
						access: "scopes: posts:write",
					},
				],
			},
		]);
		expect(data.notes).toEqual([
			'Output "Docs": Blog.getPost declare no access beside operations that do; say { "public": true } where anyone may call.',
			"No output serves the command(s) Health: their operations run only in process.",
		]);
	});

	test("reads an application given to the tool, and refuses one outside the project", async () => {
		const { client } = await setup({ "src/app.ts": APP_TS });
		const given = await client.call("afora_project", {
			app: "src/app.ts#App",
		});
		expect(given.data.operations).toHaveLength(3);
		const outside = await client.call("afora_project", {
			app: "../outside.ts#App",
		});
		expect(outside.isError).toBe(true);
		expect(outside.data).toContain("outside the project");
		const none = await client.call("afora_project");
		expect(none.isError).toBe(true);
		expect(none.data).toContain("no afora.json");
	});

	test("maps an afora.json, with default routes and the notes on access", async () => {
		const { dir, client } = await setup();
		await writeFile(
			join(dir, "afora.json"),
			JSON.stringify({
				version: 1,
				name: "shop",
				entities: { Item: { fields: { name: "text" } } },
				repositories: {
					Items: { entity: "Item", actions: ["findById", "create", "delete"] },
				},
				useCases: {
					AddItem: {
						generic: "create",
						repository: "Items",
						access: { scopes: ["items:write"] },
					},
					RemoveItem: {
						generic: "delete",
						repository: "Items",
						route: { method: "delete", path: "/items/{id}", status: 204 },
						access: { public: true },
					},
				},
				commands: {
					Catalog: { useCases: { addItem: "AddItem", remove: "RemoveItem" } },
				},
				outputs: {
					Api: {
						commands: ["Catalog"],
						pipe: [
							{
								sink: "openapi",
								options: { info: { title: "Shop", version: "1" } },
							},
						],
					},
				},
			}),
		);
		const { data } = await client.call("afora_project");
		expect(data.source).toBe("file");
		expect(
			data.operations.map((o: { implementation: string }) => o.implementation),
		).toEqual(["standard:create", "standard:delete"]);
		expect(
			data.outputs[0].routes.map((route: Record<string, unknown>) => [
				route.method,
				route.path,
				route.status,
				route.routedBy,
				route.access,
			]),
		).toEqual([
			["post", "/catalog/add-item", 200, "default", "scopes: items:write"],
			["delete", "/items/{id}", 204, "use case", "public"],
		]);
		expect(data.notes).toEqual([]);
	});

	test("is listed as read-only, and the guide says when to leave steps", async () => {
		const { client } = await setup();
		const { tools } = await client.client.listTools();
		const tool = tools.find(({ name }) => name === "afora_project");
		expect(tool?.annotations?.readOnlyHint).toBe(true);
		const guide = (
			await client.client.readResource({ uri: "afora://spec/guide" })
		).contents[0] as { text: string };
		expect(guide.text).toContain("## Steps or code");
		expect(guide.text).toContain("## A project written in code");
		expect(guide.text).toContain("## Routes and access");
	});
});

describe("the project boundary", () => {
	const spec = (extra: Record<string, unknown>) => ({
		version: 1,
		blueprints: { A: { fields: { x: "text" } } },
		...extra,
	});

	test("an import that leaves the project is rejected, wherever it is", async () => {
		const { client } = await setup();
		const step = await client.call("afora_spec_write", {
			spec: spec({
				useCases: {
					Run: {
						input: "A",
						response: "A",
						implementation: {
							steps: [
								{
									run: "leak",
									fn: { import: "../../../../etc/secrets.ts#leak" },
									args: ["$input"],
									as: "out",
								},
								{ return: "$input" },
							],
						},
					},
				},
			}),
		});
		expect(step.data.written).toBe(false);
		expect(
			step.data.issues.map((issue: { code: string; path: string[] }) => [
				issue.code,
				issue.path.join("."),
			]),
		).toContainEqual([
			"outside_project",
			"useCases.Run.implementation.steps.0.fn.import",
		]);
		const handler = await client.call("afora_spec_write", {
			spec: spec({
				useCases: {
					Run: {
						input: "A",
						response: "A",
						implementation: { import: "/etc/handler.ts#Run" },
					},
				},
			}),
		});
		expect(handler.data.written).toBe(false);
		expect(handler.data.issues[0].code).toBe("outside_project");
		const url = await client.call("afora_spec_validate", {
			spec: spec({ provider: { import: "file:///etc/db.ts#provider" } }),
		});
		expect(
			url.data.issues.map((issue: { code: string }) => issue.code),
		).toContain("outside_project");
	});

	test("an import inside the project, or a package, is accepted", async () => {
		const { client } = await setup();
		const inside = await client.call("afora_spec_validate", {
			spec: spec({
				useCases: {
					Run: {
						input: "A",
						response: "A",
						implementation: { import: "../handlers/run#Run" },
					},
				},
				provider: { import: "@acme/db#provider" },
			}),
		});
		expect(
			inside.data.issues.filter(
				(issue: { code: string }) => issue.code === "outside_project",
			),
		).toEqual([]);
	});

	test("an extends that leaves the project is not followed", async () => {
		const { dir, client } = await setup();
		await writeFile(
			join(dir, "..", "outside-afora.json"),
			JSON.stringify({ version: 1, name: "outside" }),
		);
		const result = await client.call("afora_spec_write", {
			spec: spec({ extends: ["../outside-afora.json"] }),
		});
		expect(result.data.written).toBe(false);
		expect(result.data.issues[0]).toMatchObject({
			code: "outside_project",
			path: ["extends", 0],
		});
	});

	test("a spec edited by hand cannot make the generator import from outside", async () => {
		const { dir, client } = await setup();
		await writeFile(
			join(dir, "afora.json"),
			JSON.stringify(
				spec({
					useCases: {
						Run: {
							input: "A",
							response: "A",
							implementation: { import: "../../../outside#Run" },
						},
					},
				}),
			),
		);
		const generated = await client.call("afora_generate");
		expect(generated.data.generated).toBe(false);
		expect(await Bun.file(join(dir, "src/domain/index.ts")).exists()).toBe(
			false,
		);
	});
});
