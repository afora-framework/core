import { describe, expect, test } from "bun:test";
import {
	type Authenticator,
	compileRoutes,
	type HttpOptions,
	type HttpRequest,
	httpOptionsIssue,
	PROBLEM_MEDIA_TYPE,
} from "../../adapters";
import {
	blueprintOf,
	commandOf,
	ExceptionLayers,
	exceptionOf,
	InvalidOutputStage,
	listOf,
	outputOf,
	Route,
	recordOf,
	Unauthenticated,
	useCaseOf,
} from "../../index";

const Seen = blueprintOf((ctx) => ({
	slug: ctx.optional.string,
	page: ctx.optional.integer,
	locale: ctx.optional.string,
	session: ctx.optional.string,
	title: ctx.optional.string,
	secret: ctx.optional.password,
	caller: ctx.optional.string,
	lang: ctx.optional.string,
}));
const Nope = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "Nope",
	message: "nope",
});

@Route("PUT", "/posts/{slug}", {
	status: 201,
	query: ["page"],
	headers: { locale: "Accept-Language" },
	cookie: { session: "sid" },
})
class Change extends useCaseOf({
	name: "Change",
	blueprint: blueprintOf((ctx) => ({
		slug: ctx.string,
		page: ctx.integer,
		locale: ctx.optional.string,
		session: ctx.optional.string,
		title: ctx.string,
	})),
	response: Seen,
	context: blueprintOf((ctx) => ({
		caller: ctx.optional.string,
		lang: ctx.optional.string,
	})),
	errors: [Nope],
}) {
	override async execute() {
		if (this.input.title === "nope") throw new Nope({ source: "Change" });
		if (this.input.title === "boom") throw new Error("database password");
		return { ...this.input, ...this.context };
	}
}
class List extends useCaseOf({
	name: "List",
	blueprint: blueprintOf((ctx) => ({ page: ctx.integer })),
	response: Seen,
	route: { method: "get", path: "/posts" },
}) {
	override async execute() {
		return { page: this.input.page };
	}
}
class Remove extends useCaseOf({
	name: "Remove",
	blueprint: blueprintOf((ctx) => ({ slug: ctx.string })),
	response: blueprintOf(() => ({})),
	route: { method: "delete", path: "/posts/{slug}", status: 204 },
	access: { scopes: ["posts:write"] },
}) {
	override async execute() {
		return {};
	}
}

const Posts = commandOf({
	name: "Posts",
	useCases: { change: Change, list: List, remove: Remove },
});
const output = outputOf({
	name: "Api",
	commands: [Posts],
	statuses: { Nope: 418 },
});
const stage = { output: { name: "Api", statuses: output.statuses } };

const table = (options: HttpOptions = {}, authenticator?: Authenticator) =>
	compileRoutes(output.operations, options, stage, {
		source: "test",
		...(authenticator ? { authenticator } : {}),
	});
const request = (given: {
	params?: Record<string, string>;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	body?: unknown;
	variables?: Record<string, unknown>;
}): HttpRequest => ({
	param: (name) => given.params?.[name],
	query: () => given.query ?? {},
	header: (name) => given.headers?.[name],
	text: () =>
		typeof given.body === "string"
			? given.body
			: JSON.stringify(given.body ?? {}),
	variable: (name) => given.variables?.[name],
});
const routeOf = (routes: ReturnType<typeof table>, id: string) => {
	const found = routes.routes.find(({ operation }) => operation.id === id);
	if (!found) throw new Error(id);
	return found;
};

describe("compileRoutes", () => {
	test("gives each operation its method, path and parameters", () => {
		expect(
			table({ basePath: "/api" }).routes.map(({ method, path, parameters }) => [
				method,
				path,
				parameters,
			]),
		).toEqual([
			["put", "/api/posts/{slug}", ["slug"]],
			["get", "/api/posts", []],
			["delete", "/api/posts/{slug}", ["slug"]],
		]);
	});

	test("reads each key where the route places it, over the body", async () => {
		const result = await routeOf(table(), "Posts.change").handle(
			request({
				params: { slug: "from-path" },
				query: { page: "3", title: "from-query" },
				headers: {
					"accept-language": "pt-BR",
					cookie: 'other=1; sid="s%201"; sid=second',
				},
				body: { slug: "from-body", title: "T", page: 9 },
			}),
		);
		expect(result.status).toBe(201);
		expect(result.headers).toEqual({ "content-type": "application/json" });
		expect(result.cookies).toEqual([]);
		expect(JSON.parse(result.body as string)).toEqual({
			slug: "from-path",
			page: 3,
			locale: "pt-BR",
			session: "s 1",
			title: "T",
		});
	});

	test("a key read from a header, a cookie or the route query never comes from the body", async () => {
		const result = await routeOf(table(), "Posts.change").handle(
			request({
				params: { slug: "a" },
				query: { page: "1" },
				body: { title: "T", locale: "evil", session: "evil", page: 9 },
			}),
		);
		expect(result.status).toBe(201);
		expect(JSON.parse(result.body as string)).toEqual({
			slug: "a",
			page: 1,
			title: "T",
		});
		const missing = await routeOf(table(), "Posts.change").handle(
			request({ params: { slug: "a" }, body: { title: "T", page: 9 } }),
		);
		expect(missing.status).toBe(400);
		expect(
			JSON.parse(missing.body as string).issues.map(
				(issue: { path: unknown[] }) => issue.path,
			),
		).toEqual([["page"]]);
	});

	test("a get reads the query, coerced; a 204 has no body", async () => {
		const listed = await routeOf(table(), "Posts.list").handle(
			request({ query: { page: "2" } }),
		);
		expect(JSON.parse(listed.body as string)).toEqual({ page: 2 });
		const removed = await routeOf(
			table({}, () => ({ subject: "u", scopes: ["posts:write"] })),
			"Posts.remove",
		).handle(request({ params: { slug: "a" } }));
		expect(removed).toMatchObject({ status: 204, body: null, headers: {} });
	});

	test("fills the context from headers and variables", async () => {
		const result = await routeOf(
			table({
				context: {
					headers: { lang: "X-Lang" },
					variables: { caller: "user" },
				},
			}),
			"Posts.change",
		).handle(
			request({
				params: { slug: "a" },
				query: { page: "1" },
				headers: { "x-lang": "en" },
				variables: { user: "ana" },
				body: { title: "T" },
			}),
		);
		expect(JSON.parse(result.body as string)).toMatchObject({
			caller: "ana",
			lang: "en",
		});
	});

	test("errors are problems with the status of the output", async () => {
		const change = routeOf(table(), "Posts.change");
		const call = (body: unknown) =>
			change.handle(
				request({ params: { slug: "a" }, query: { page: "1" }, body }),
			);
		const invalid = await call({ title: 1 });
		expect(invalid.status).toBe(400);
		expect(invalid.headers["content-type"]).toBe(PROBLEM_MEDIA_TYPE);
		expect(JSON.parse(invalid.body as string).issues).toHaveLength(1);
		const notJson = await call("{nope");
		expect(JSON.parse(notJson.body as string)).toMatchObject({
			title: "InvalidRequestBody",
			status: 400,
		});
		expect((await call({ title: "nope" })).status).toBe(418);
		const crashed = await call({ title: "boom" });
		expect(crashed.status).toBe(500);
		expect(crashed.body).not.toContain("database password");
		const debugged = await routeOf(
			table({ debug: true }),
			"Posts.change",
		).handle(
			request({
				params: { slug: "a" },
				query: { page: "1" },
				body: { title: "boom" },
			}),
		);
		expect(debugged.body).toContain("database password");
	});

	test("an operation with an access asks the authenticator, and fails closed", async () => {
		const call = (authenticator?: Authenticator) =>
			routeOf(table({}, authenticator), "Posts.remove").handle(
				request({
					params: { slug: "a" },
					headers: { authorization: "Bearer t", cookie: "sid=c" },
				}),
			);
		expect((await call()).status).toBe(401);
		expect((await call(() => null)).status).toBe(401);
		expect(
			(await call(async () => ({ subject: "u", scopes: [] }))).status,
		).toBe(403);
		const seen: unknown[] = [];
		const allowed = await call((auth) => {
			seen.push(auth.header("authorization"), auth.cookie("sid"));
			seen.push(auth.operation.id);
			return { subject: "u", scopes: ["posts:write"] };
		});
		expect(allowed.status).toBe(204);
		expect(seen).toEqual(["Bearer t", "c", "Posts.remove"]);
		const refused = await call(() => {
			throw new Unauthenticated({ source: "auth" });
		});
		expect(refused.status).toBe(401);
		let asked = 0;
		await routeOf(
			table({}, () => {
				asked++;
				return null;
			}),
			"Posts.list",
		).handle(request({ query: { page: "1" } }));
		expect(asked).toBe(0);
	});

	test("the request id is on every result", async () => {
		const routes = table({ requestId: true });
		const sent = { headers: { "x-request-id": "abc-1" } };
		const listed = await routeOf(routes, "Posts.list").handle(
			request({ query: { page: "1" }, ...sent }),
		);
		expect(listed.headers["x-request-id"]).toBe("abc-1");
		expect(routes.notFound(request(sent)).headers["x-request-id"]).toBe(
			"abc-1",
		);
		expect(routes.notFound().headers["x-request-id"]).toMatch(
			/^[0-9a-f-]{36}$/,
		);
		expect(
			routes.failure(new Error("x"), {
				request: request({ headers: { "x-request-id": "bad id" } }),
			}).headers["x-request-id"],
		).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("notFound and failure are problems", () => {
		const routes = table();
		expect(routes.notFound()).toMatchObject({ status: 404 });
		expect(routes.failure(new Error("x")).status).toBe(500);
		expect(routes.failure(new Error("x"), { status: 401 }).status).toBe(401);
		expect(
			routes.failure(new Nope({ source: "x" }), { status: 401 }).status,
		).toBe(418);
	});

	test("docs serves the document of the same routes", () => {
		const routes = table({
			docs: { path: "/openapi.json", info: { title: "T", version: "1" } },
		});
		const served = routes.docs?.handle();
		expect(routes.docs?.path).toBe("/openapi.json");
		expect(served?.headers["content-type"]).toBe("application/json");
		expect(
			Object.keys(JSON.parse(served?.body as string).paths).sort(),
		).toEqual(["/posts", "/posts/{slug}"]);
		expect(table().docs).toBeUndefined();
		expect(() =>
			table({ docs: { path: "/posts", info: { title: "T", version: "1" } } }),
		).toThrow(InvalidOutputStage);
	});

	test("httpOptionsIssue names the sink", () => {
		expect(httpOptionsIssue({}, "x")).toBeUndefined();
		expect(httpOptionsIssue({ debug: 1 } as never, "x")).toContain("x.debug");
		expect(
			httpOptionsIssue({ docs: { path: "nope" } } as never, "x"),
		).toContain("x.docs.path");
		expect(
			httpOptionsIssue(
				{ context: { headers: { a: "h" }, variables: { a: "v" } } },
				"x",
			),
		).toContain("both from a header and from a variable");
		expect(httpOptionsIssue({ basePath: 1 } as never, "x")).toContain(
			"x.basePath",
		);
	});
});

describe("a delete route with body: true", () => {
	class Unsubscribe extends useCaseOf({
		name: "Unsubscribe",
		blueprint: blueprintOf((ctx) => ({
			channel: ctx.string,
			endpoint: ctx.string,
			page: ctx.optional.integer,
			limit: ctx.optional.integer,
		})),
		response: blueprintOf((ctx) => ({
			channel: ctx.string,
			endpoint: ctx.string,
			page: ctx.optional.integer,
			limit: ctx.optional.integer,
		})),
		route: {
			method: "delete",
			path: "/subscriptions/{channel}",
			query: ["page"],
			body: true,
		},
	}) {
		override async execute() {
			return this.input;
		}
	}
	class Purge extends useCaseOf({
		name: "Purge",
		blueprint: blueprintOf((ctx) => ({ before: ctx.optional.integer })),
		response: blueprintOf((ctx) => ({ before: ctx.optional.integer })),
		route: { method: "delete", path: "/subscriptions", body: true },
	}) {
		override async execute() {
			return this.input;
		}
	}
	const Push = commandOf({
		name: "Push",
		useCases: { unsubscribe: Unsubscribe, purge: Purge },
	});
	const pushed = outputOf({ name: "Push", commands: [Push] });
	const routes = (options: HttpOptions = {}) =>
		compileRoutes(pushed.operations, options, stage, { source: "test" });

	test("reads the keys with no other place from a JSON body", async () => {
		const result = await routeOf(routes(), "Push.unsubscribe").handle(
			request({
				params: { channel: "web" },
				query: { page: "2", limit: "9" },
				body: { endpoint: "https://push.example/1", channel: "x", limit: 5 },
			}),
		);
		expect(result.status).toBe(200);
		// The path and the route query win over the body; other query keys are not read.
		expect(JSON.parse(result.body as string)).toEqual({
			channel: "web",
			endpoint: "https://push.example/1",
			page: 2,
			limit: 5,
		});
	});

	test("the route query key is not read from the body", async () => {
		const result = await routeOf(routes(), "Push.unsubscribe").handle(
			request({
				params: { channel: "web" },
				body: { endpoint: "e", page: 9 },
			}),
		);
		expect(JSON.parse(result.body as string)).toEqual({
			channel: "web",
			endpoint: "e",
		});
	});

	test("an empty body is {}, and invalid JSON a 400", async () => {
		const purge = routeOf(routes(), "Push.purge");
		const empty = await purge.handle(request({ body: "" }));
		expect(empty.status).toBe(200);
		expect(JSON.parse(empty.body as string)).toEqual({});
		const notJson = await purge.handle(request({ body: "{nope" }));
		expect(JSON.parse(notJson.body as string)).toMatchObject({
			title: "InvalidRequestBody",
			status: 400,
		});
	});

	test("without it, a delete reads the query", async () => {
		const result = await routeOf(
			routes({ route: { "Push.purge": { body: false } } }),
			"Push.purge",
		).handle(request({ query: { before: "7" }, body: { before: 1 } }));
		expect(JSON.parse(result.body as string)).toEqual({ before: 7 });
	});

	test("the sink route sets it, on a delete only", async () => {
		const result = await routeOf(
			table({ route: { "Posts.remove": { body: true } } }, () => ({
				subject: "u",
				scopes: ["posts:write"],
			})),
			"Posts.remove",
		).handle(
			request({ params: { slug: "a" }, query: { slug: "q" }, body: "" }),
		);
		expect(result.status).toBe(204);
		expect(() => table({ route: { "Posts.change": { body: true } } })).toThrow(
			"a put route always reads a body",
		);
		expect(() =>
			// @ts-expect-error: body is only allowed on a delete
			table({ route: { "Posts.remove": { method: "get", body: true } } }),
		).toThrow(InvalidOutputStage);
		expect(
			httpOptionsIssue(
				// @ts-expect-error: body is only allowed on a delete
				{ route: { "Posts.list": { method: "get", body: true } } },
				"x",
			),
		).toContain("a get route never reads a body");
		expect(
			httpOptionsIssue(
				{ route: { "Posts.list": { body: "yes" } } } as never,
				"x",
			),
		).toContain('x.route["Posts.list"].body to be a boolean');
	});

	test("the use case route takes it on a delete only", () => {
		for (const [method, reason] of [
			["get", "a get route never reads a body"],
			["post", "a post route always reads a body"],
		] as const) {
			expect(() =>
				useCaseOf({
					name: "Bad",
					blueprint: blueprintOf((ctx) => ({ id: ctx.string })),
					response: blueprintOf(() => ({})),
					// @ts-expect-error: body is only allowed on a delete
					route: { method, body: true },
				}),
			).toThrow(reason);
		}
	});
});

describe("a list response", () => {
	class Item extends recordOf(
		blueprintOf((ctx) => ({ title: ctx.string, secret: ctx.string })),
		{ sensitive: ["secret"] },
	) {}
	class Recent extends useCaseOf({
		name: "Recent",
		blueprint: blueprintOf((ctx) => ({ count: ctx.integer })),
		response: listOf(Item),
		route: { method: "get", path: "/recent" },
	}) {
		override async execute() {
			return Array.from(
				{ length: this.input.count },
				(_, index) => new Item({ title: `T${index}`, secret: "hunter22" }),
			);
		}
	}
	const Feed = outputOf({
		name: "Feed",
		commands: [commandOf({ name: "Feed", useCases: { recent: Recent } })],
	});

	test("is sent as a JSON array, sensitive values masked", async () => {
		const routes = compileRoutes(
			Feed.operations,
			{},
			{ output: { name: "Feed", statuses: Feed.statuses } },
			{ source: "test" },
		);
		const result = await routeOf(routes, "Feed.recent").handle(
			request({ query: { count: "2" } }),
		);
		expect(result.status).toBe(200);
		const body = JSON.parse(result.body as string);
		expect(body).toHaveLength(2);
		expect(body[0].title).toBe("T0");
		expect(body[0].secret).not.toBe("hunter22");
	});
});
