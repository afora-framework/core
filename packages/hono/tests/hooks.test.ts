import { describe, expect, test } from "bun:test";
import {
	Access,
	blueprintOf,
	commandOf,
	outputOf,
	Route,
	useCaseOf,
} from "@afora/core";
import { stageDescriptionOf } from "@afora/core/experimental";
import { Hono } from "hono";
import { type HonoHooks, hono } from "../src/index";

const Seen = blueprintOf((ctx) => ({
	slug: ctx.optional.string,
	page: ctx.optional.integer,
	session: ctx.optional.string,
	userId: ctx.optional.string,
}));

@Route("GET", "/posts/{slug}", { cookie: { session: "sid" } })
class GetPost extends useCaseOf({
	name: "GetPost",
	blueprint: blueprintOf((ctx) => ({
		slug: ctx.string,
		page: ctx.optional.integer,
		session: ctx.optional.string,
	})),
	response: Seen,
}) {
	override async execute() {
		return { ...this.input };
	}
}

@Route("POST", "/posts")
@Access({ scopes: ["posts:write"], context: { userId: "subject" } })
class CreatePost extends useCaseOf({
	name: "CreatePost",
	blueprint: blueprintOf((ctx) => ({ slug: ctx.string })),
	response: Seen,
	context: blueprintOf((ctx) => ({ userId: ctx.string })),
}) {
	override async execute() {
		return { slug: this.input.slug, userId: this.context.userId };
	}
}

const Posts = commandOf({
	name: "Posts",
	useCases: { get: GetPost, create: CreatePost },
});
const build = (hooks?: HonoHooks) =>
	outputOf({
		name: "Api",
		commands: [Posts],
		pipe: [hono({ basePath: "/api" }, hooks)],
	}).build();
const post = (headers: Record<string, string> = {}) => ({
	method: "POST",
	headers: { "content-type": "application/json", ...headers },
	body: JSON.stringify({ slug: "a" }),
});
const bearer: HonoHooks["authenticator"] = (request) => {
	const token = request.header("authorization");
	if (token === "Bearer writer")
		return { subject: "u1", scopes: ["posts:write"] };
	if (token === "Bearer reader") return { subject: "u2", scopes: [] };
	return null;
};

describe("hono sink: routes of use cases", () => {
	test("serves the route the use case declares, cookies included", async () => {
		const response = await build().request("/api/posts/hello?page=2", {
			headers: { cookie: "sid=abc" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			slug: "hello",
			page: 2,
			session: "abc",
		});
	});
});

describe("hono sink: hooks", () => {
	test("without an authenticator, an operation with an access is closed", async () => {
		const response = await build().request("/api/posts", post());
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ title: "Unauthenticated" });
	});

	test("the authenticator decides who calls", async () => {
		const app = build({ authenticator: bearer });
		expect((await app.request("/api/posts", post())).status).toBe(401);
		const reader = await app.request(
			"/api/posts",
			post({ authorization: "Bearer reader" }),
		);
		expect(reader.status).toBe(403);
		expect(await reader.json()).toMatchObject({ title: "Forbidden" });
		const writer = await app.request(
			"/api/posts",
			post({ authorization: "Bearer writer" }),
		);
		expect(writer.status).toBe(200);
		expect(await writer.json()).toEqual({ slug: "a", userId: "u1" });
	});

	test("the authenticator gets the Hono context", async () => {
		let path: string | undefined;
		const app = build({
			authenticator: (request) => {
				path = (request.native as { req: { path: string } }).req.path;
				return null;
			},
		});
		await app.request("/api/posts", post());
		expect(path).toBe("/api/posts");
	});

	test("middlewares run before the routes, in order", async () => {
		const order: string[] = [];
		const app = build({
			middlewares: [
				async (_c, next) => {
					order.push("first");
					await next();
				},
				async (c, next) => {
					order.push("second");
					if (c.req.header("x-block")) return c.text("blocked", 429);
					await next();
				},
			],
		});
		expect((await app.request("/api/posts/a")).status).toBe(200);
		expect(order).toEqual(["first", "second"]);
		const blocked = await app.request("/api/posts/a", {
			headers: { "x-block": "1" },
		});
		expect(blocked.status).toBe(429);
	});

	test("routes can be added to an app, which keeps its handlers", async () => {
		const mine = new Hono();
		mine.get("/health", (c) => c.text("ok"));
		mine.notFound((c) => c.text("mine", 404));
		const app = build({ app: mine });
		expect(app).toBe(mine);
		expect(await (await app.request("/health")).text()).toBe("ok");
		expect(await (await app.request("/nowhere")).text()).toBe("mine");
		expect((await app.request("/api/posts/a")).status).toBe(200);
	});

	test("hooks are not part of the description of the stage", () => {
		const stage = hono({ basePath: "/api" }, { authenticator: bearer });
		expect(stageDescriptionOf(stage)).toEqual({
			kind: "sink",
			name: "hono",
			options: { basePath: "/api" },
		});
		expect(() => hono({}, "nope" as never)).toThrow();
	});
});
