import { describe, expect, test } from "bun:test";
import { compileRoutes, type HttpRequest } from "../adapters";
import {
	type AnyCommand,
	applicationOf,
	blueprintOf,
	commandOf,
	entityOf,
	Integer,
	idOf,
	inMemoryProvider,
	Key,
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

describe("resourceOf, with other ids", () => {
	function serve(Blog: AnyCommand) {
		const Api = outputOf({ name: "Api", commands: [Blog] });
		const table = compileRoutes(
			Api.operations,
			{ basePath: "/api" },
			{ output: { name: "Api", statuses: Api.statuses } },
			{ source: "test" },
		);
		return async (
			index: number,
			given: { id?: string; body?: unknown },
		): Promise<{ status?: number; json: Record<string, never> }> => {
			const request: HttpRequest = {
				param: () => given.id,
				query: () => ({}),
				header: () => undefined,
				text: () => JSON.stringify(given.body ?? {}),
			};
			const result = await table.routes[index]?.handle(request);
			return {
				status: result?.status,
				json: JSON.parse(result?.body ?? "null"),
			};
		};
	}

	test("a natural key is part of the input of create", async () => {
		class Setting extends entityOf(
			blueprintOf((ctx) => ({ value: ctx.text })),
			{ id: Key, change: ["value"] },
		) {}
		const Settings = repositoryOf({
			entity: Setting,
			provider: inMemoryProvider(),
			actions: ["findById", "findPage", "create", "update", "delete"],
		});
		const Site = commandOf({
			name: "Site",
			useCases: resourceOf(Settings, { path: "/settings" }),
		});
		const { item } = await Site.run("create", { id: "seo", value: "on" });
		expect(item.id).toBe("seo");
		// @ts-expect-error the id of a natural key is required
		await Site.run("create", { value: "off" }).catch(() => {});
		expect((await Site.run("get", { id: "seo" })).item.value).toBe("on");
		await Site.run("update", { id: "seo", value: "off" });
		expect((await Site.run("get", { id: "seo" })).item.value).toBe("off");

		const call = serve(Site);
		expect(
			(await call(0, { body: { id: "profile", value: "x" } })).status,
		).toBe(201);
		expect((await call(0, { body: { value: "x" } })).status).toBe(400);
		expect((await call(1, { id: "profile" })).json.item).toMatchObject({
			id: "profile",
		});
		expect((await call(4, { id: "seo" })).status).toBe(200);
	});

	test("an integer id in the path is read as a number", async () => {
		let next = 0;
		class Ticket extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.text })),
			{ id: idOf(Integer, () => ++next), change: ["title"] },
		) {}
		const Tickets = repositoryOf({
			entity: Ticket,
			provider: inMemoryProvider(),
			actions: ["findById", "findPage", "create", "update", "delete"],
		});
		const Desk = commandOf({
			name: "Desk",
			useCases: resourceOf(Tickets, { path: "/tickets" }),
		});
		const call = serve(Desk);
		const created = await call(0, { body: { title: "First" } });
		expect(created.status).toBe(201);
		expect(created.json.item).toMatchObject({ id: 1, title: "First" });
		expect((await call(1, { id: "1" })).json.item).toMatchObject({ id: 1 });
		expect(
			(await call(3, { id: "1", body: { title: "Renamed" } })).json.item,
		).toMatchObject({ id: 1, title: "Renamed" });
		expect((await call(1, { id: "abc" })).status).toBe(400);
		expect((await call(4, { id: "1" })).status).toBe(200);
		expect((await call(1, { id: "1" })).status).toBe(404);
	});
});
