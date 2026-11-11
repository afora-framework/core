import { describe, expect, test } from "bun:test";
import { compileRoutes, type HttpRequest } from "../adapters";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	entityOf,
	inMemoryProvider,
	outputOf,
	repositoryOf,
	resourceOf,
	UseCaseUnavailable,
} from "../index";

class Post extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.text, views: ctx.integer })),
	{ change: ["title"] },
) {}

function build() {
	const Posts = repositoryOf({
		entity: Post,
		provider: inMemoryProvider(),
		actions: ["findById", "findPage", "create", "update", "delete"],
	});
	const Blog = commandOf({
		name: "Blog",
		useCases: resourceOf(Posts, { path: "/posts" }),
	});
	return { Posts, Blog };
}

describe("resourceOf", () => {
	test("gives the standard use cases, with the routes of a resource", () => {
		const { Blog } = build();
		expect(
			Object.entries(Blog.useCases).map(([operation, UseCase]) => [
				operation,
				UseCase.useCaseName,
				UseCase.route,
			]),
		).toEqual([
			["create", "CreatePost", { method: "post", path: "/posts", status: 201 }],
			["get", "GetPost", { method: "get", path: "/posts/{id}" }],
			["list", "ListPost", { method: "get", path: "/posts" }],
			["update", "UpdatePost", { method: "patch", path: "/posts/{id}" }],
			["delete", "DeletePost", { method: "delete", path: "/posts/{id}" }],
		]);
	});

	test("the operations are typed by the repository", async () => {
		const { Blog } = build();
		const { item } = await Blog.run("create", { title: "Hello", views: 1 });
		const title: string = item.title;
		expect(title).toBe("Hello");
		const listed = await Blog.run("list", {});
		expect(listed.items.map((post) => post.id)).toEqual([item.id]);
		const updated = await Blog.run("update", { id: item.id, title: "Hi" });
		expect(updated.item.title).toBe("Hi");
		// @ts-expect-error views is not a change key
		await Blog.run("update", { id: item.id, views: 2 }).catch(() => {});
		expect((await Blog.run("get", { id: item.id })).item.views).toBe(1);
		await Blog.run("delete", { id: item.id });
		expect((await Blog.run("list", {})).total).toBe(0);
	});

	test("serves a CRUD API over HTTP", async () => {
		const { Blog } = build();
		const Api = outputOf({ name: "Api", commands: [Blog] });
		const table = compileRoutes(
			Api.operations,
			{ basePath: "/api" },
			{ output: { name: "Api", statuses: Api.statuses } },
			{ source: "test" },
		);
		expect(table.routes.map(({ method, path }) => `${method} ${path}`)).toEqual(
			[
				"post /api/posts",
				"get /api/posts/{id}",
				"get /api/posts",
				"patch /api/posts/{id}",
				"delete /api/posts/{id}",
			],
		);
		const call = async (
			index: number,
			given: { id?: string; body?: unknown; query?: Record<string, string> },
		) => {
			const request: HttpRequest = {
				param: () => given.id,
				query: () => given.query ?? {},
				header: () => undefined,
				text: () => JSON.stringify(given.body ?? {}),
			};
			const result = await table.routes[index]?.handle(request);
			return {
				status: result?.status,
				json: JSON.parse(result?.body ?? "null"),
			};
		};
		const created = await call(0, { body: { title: "Hello", views: 3 } });
		expect(created.status).toBe(201);
		const id = created.json.item.id as string;
		expect((await call(1, { id })).json.item.title).toBe("Hello");
		expect((await call(2, { query: { limit: "10" } })).json.total).toBe(1);
		expect((await call(3, { id, body: { title: "Hi" } })).json.item.title).toBe(
			"Hi",
		);
		expect((await call(4, { id })).status).toBe(200);
		expect((await call(1, { id })).status).toBe(404);
	});

	test("picks operations, and says who may call them", () => {
		const { Posts } = build();
		const Read = commandOf({
			name: "Read",
			useCases: resourceOf(Posts, {
				path: "/posts",
				actions: ["get", "list"],
				access: { public: true },
			}),
		});
		expect(Object.keys(Read.useCases)).toEqual(["get", "list"]);
		expect(Read.useCases.get.access).toEqual({ public: true });
		// @ts-expect-error create was not picked
		expect(Read.useCases.create).toBeUndefined();
		const Mixed = commandOf({
			name: "Mixed",
			useCases: (ctx) => ({
				...resourceOf(Posts, {
					path: "/posts",
					actions: ["create", "get"],
					access: { create: { scopes: ["posts:write"] } },
				})(ctx),
				remove: ctx.delete(Posts, { name: "RemovePost" }),
			}),
		});
		expect(Mixed.useCases.create.access).toEqual({ scopes: ["posts:write"] });
		expect(Mixed.useCases.get.access).toBeUndefined();
		expect(Object.keys(Mixed.useCases)).toEqual(["create", "get", "remove"]);
	});

	test("a repository that lacks an action cannot give the operation", () => {
		const Posts = repositoryOf({
			entity: Post,
			provider: inMemoryProvider(),
			actions: ["findById"],
		});
		expect(() =>
			commandOf({
				name: "Blog",
				useCases: resourceOf(Posts, { path: "/posts" }),
			}),
		).toThrow(UseCaseUnavailable);
	});

	test("an application describes it as a hand-written command", () => {
		const { Posts, Blog } = build();
		const app = applicationOf({
			name: "blog",
			entities: { Post },
			repositories: { Posts },
			commands: { Blog },
		});
		const described = app.describe();
		expect(Object.keys(described.commands.Blog?.operations ?? {})).toEqual([
			"create",
			"get",
			"list",
			"update",
			"delete",
		]);
		expect(described.useCases.CreatePost?.generic?.name).toBe("create");
		expect(described.useCases.CreatePost?.route).toEqual({
			method: "post",
			path: "/posts",
			status: 201,
		});
	});
});
