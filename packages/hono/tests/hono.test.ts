import { describe, expect, test } from "bun:test";
import {
	outputOf,
	PROBLEM_MEDIA_TYPE,
	StdStages,
	stageDescriptionOf,
} from "@afora/core";
import { type SpecData, Validator } from "@seriousme/openapi-schema-validator";
import type { Hono } from "hono";
import { HonoStages, hono, stages } from "../src/index";
import { blog, requireAuth, Unauthorized } from "./blog";

function api(options: Parameters<typeof hono>[0] = {}, extra = false) {
	const { Users, Posts } = blog();
	return outputOf({
		name: "Blog",
		commands: [Users, Posts],
		statuses: { Unauthorized: 401, InvalidCredentials: 401 },
		pipe: [
			...(extra ? [requireAuth()] : []),
			hono({
				context: {
					headers: { authorization: "authorization", limit: "x-limit" },
				},
				docs: {
					path: "/openapi.json",
					info: { title: "Blog", version: "1.0.0" },
				},
				route: { "Posts.list": { method: "get" } },
				...options,
			}),
		],
	}).build() as Hono;
}

const post = (
	app: Hono,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
) =>
	app.request(path, {
		method: "POST",
		body: typeof body === "string" ? body : JSON.stringify(body),
		headers: { "content-type": "application/json", ...headers },
	});

const ana = {
	name: "Ana",
	email: "ana@example.com",
	plainPassword: "S3cret-pass!",
};

describe("hono sink", () => {
	test("registers, logs in and masks the password", async () => {
		const app = api();
		const created = await post(app, "/users/register", ana);
		expect(created.status).toBe(200);
		expect(created.headers.get("content-type")).toContain("application/json");
		const { user } = (await created.json()) as {
			user: Record<string, unknown>;
		};
		expect(user.email).toBe("ana@example.com");
		expect(user.password).toBe("********");
		expect(JSON.stringify(user)).not.toContain("argon2");

		const login = await post(app, "/users/login", {
			email: ana.email,
			plainPassword: ana.plainPassword,
		});
		expect(login.status).toBe(200);
		expect(
			((await login.json()) as { user: { password: string } }).user.password,
		).toBe("********");
	});

	test("declared errors go through statuses and are problem+json", async () => {
		const app = api();
		await post(app, "/users/register", ana);
		const res = await post(app, "/users/login", {
			email: ana.email,
			plainPassword: "wrong",
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("content-type")).toBe(PROBLEM_MEDIA_TYPE);
		const problem = (await res.json()) as Record<string, unknown>;
		expect(problem).toMatchObject({
			type: "urn:afora:exception:InvalidCredentials",
			status: 401,
		});
		expect(problem.trace).toBeUndefined();
	});

	test("a declared error without a status is a 422", async () => {
		const { Users, Posts } = blog();
		const app = outputOf({
			name: "B",
			commands: [Users, Posts],
			pipe: [hono()],
		}).build();
		await post(app, "/users/register", ana);
		const res = await post(app, "/users/login", {
			email: ana.email,
			plainPassword: "wrong",
		});
		expect(res.status).toBe(422);
	});

	test("a unique violation is a 409 problem", async () => {
		const app = api();
		await post(app, "/users/register", ana);
		const res = await post(app, "/users/register", ana);
		expect(res.status).toBe(409);
		expect(res.headers.get("content-type")).toBe(PROBLEM_MEDIA_TYPE);
		expect(((await res.json()) as { title: string }).title).toBe(
			"RepositoryUniqueViolation",
		);
	});

	test("an invalid body is a 400 with issues, and bad JSON too", async () => {
		const app = api();
		const res = await post(app, "/users/register", {
			name: "Ana",
			email: "nope",
		});
		expect(res.status).toBe(400);
		expect(res.headers.get("content-type")).toBe(PROBLEM_MEDIA_TYPE);
		const problem = (await res.json()) as {
			issues: { path: (string | number)[] }[];
		};
		const paths = problem.issues.map((issue) => issue.path[0]);
		expect(paths).toContain("email");
		expect(paths).toContain("plainPassword");

		const broken = await post(app, "/users/register", "{nope");
		expect(broken.status).toBe(400);
		expect(((await broken.json()) as { title: string }).title).toBe(
			"InvalidRequestBody",
		);
	});

	test("the context comes from headers; missing optional keys are left out", async () => {
		const app = api();
		const res = await post(
			app,
			"/posts/publish",
			{ title: "Hello" },
			{ authorization: "Bearer ana@example.com", "x-limit": "5" },
		);
		expect(res.status).toBe(200);
		expect(
			((await res.json()) as { post: { authorEmail: string } }).post
				.authorEmail,
		).toBe("ana@example.com");

		const bare = await post(app, "/posts/publish", { title: "Hello" });
		expect(bare.status).toBe(200);
		expect(
			((await bare.json()) as { post: { authorEmail: string } }).post
				.authorEmail,
		).toBe("anonymous@example.com");
		const badLimit = await post(
			app,
			"/posts/publish",
			{ title: "Hi" },
			{ "x-limit": "many" },
		);
		expect(badLimit.status).toBe(400);
		expect(((await badLimit.json()) as { title: string }).title).toBe(
			"InvalidUseCaseContext",
		);
	});

	test("get reads the query and coerces scalars", async () => {
		const app = api();
		for (const title of ["One", "Two", "Three"]) {
			await post(
				app,
				"/posts/publish",
				{ title },
				{ authorization: "Bearer ana@example.com" },
			);
		}
		const all = await app.request("/posts/list?max=2");
		expect(all.status).toBe(200);
		expect(((await all.json()) as { items: unknown[] }).items).toHaveLength(2);
		const bad = await app.request("/posts/list?max=lots");
		expect(bad.status).toBe(400);
		const none = await app.request("/posts/list?onlyBy=bob@example.com");
		expect(((await none.json()) as { items: unknown[] }).items).toEqual([]);
	});

	test("an unknown route is a 404 problem", async () => {
		const res = await api().request("/nothing");
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toBe(PROBLEM_MEDIA_TYPE);
		const wrongMethod = await api().request("/users/register");
		expect(wrongMethod.status).toBe(404);
	});

	test("basePath and route apply, and docs are valid and agree with the routes", async () => {
		const app = api({
			basePath: "/api",
			docs: {
				path: "/openapi.json",
				info: { title: "Blog", version: "1.0.0" },
			},
		});
		expect((await post(app, "/api/users/register", ana)).status).toBe(200);
		expect((await post(app, "/users/register", ana)).status).toBe(404);
		const res = await app.request("/openapi.json");
		expect(res.status).toBe(200);
		const document = (await res.json()) as {
			paths: Record<string, Record<string, unknown>>;
		};
		const result = await new Validator().validate(
			document as unknown as SpecData,
		);
		expect(result.errors ?? []).toEqual([]);
		expect(result.valid).toBe(true);
		expect(Object.keys(document.paths).sort()).toEqual([
			"/api/posts/list",
			"/api/posts/publish",
			"/api/users/login",
			"/api/users/register",
		]);
		expect(document.paths["/api/posts/list"]).toHaveProperty("get");
		const other = await app.request("/api/posts/list");
		expect(other.status).toBe(200);
	});

	test("a transform wrapping invoke guards operations through statuses", async () => {
		const app = api({}, true);
		const denied = await post(app, "/posts/publish", { title: "Hi" });
		expect(denied.status).toBe(401);
		expect(((await denied.json()) as { title: string }).title).toBe(
			Unauthorized.name,
		);
		const open = await post(app, "/users/register", ana);
		expect(open.status).toBe(200); // public
		const ok = await post(
			app,
			"/posts/publish",
			{ title: "Hi" },
			{ authorization: "Bearer ana@example.com" },
		);
		expect(ok.status).toBe(200);
	});

	test("5xx hide the message unless debug is on", async () => {
		const { Posts } = blog();
		const make = (debug: boolean) =>
			outputOf({
				name: "B",
				commands: [Posts],
				// Unauthorized has no status here: a 500
				pipe: [
					requireAuth(),
					hono({
						context: { headers: { authorization: "authorization" } },
						debug,
					}),
				],
			}).build();
		const hidden = await post(make(false), "/posts/publish", { title: "Hi" });
		expect(hidden.status).toBe(500);
		const quiet = (await hidden.json()) as Record<string, unknown>;
		expect(quiet.detail).toBe("Internal error.");
		expect(quiet.trace).toBeUndefined();
		const loud = (await (
			await post(make(true), "/posts/publish", { title: "Hi" })
		).json()) as Record<string, unknown>;
		expect(loud.detail).toBe("Sign in first.");
		expect(typeof loud.trace).toBe("string");
	});

	test("rejects invalid options and a docs path that collides", () => {
		const bad = (options: object) => () => hono(options as never);
		expect(bad({ nope: 1 })).toThrow();
		expect(bad({ basePath: "api" })).toThrow();
		expect(bad({ debug: "yes" })).toThrow();
		expect(
			bad({
				docs: { path: "openapi.json", info: { title: "a", version: "1" } },
			}),
		).toThrow();
		expect(bad({ docs: { path: "/o" } })).toThrow();
		expect(bad({ context: { headers: { token: "bad header" } } })).toThrow();
		const { Posts } = blog();
		expect(() =>
			outputOf({
				name: "B",
				commands: [Posts],
				pipe: [
					hono({
						route: { "Posts.list": { method: "get" } },
						docs: { path: "/posts/list", info: { title: "a", version: "1" } },
					}),
				],
			}).build(),
		).toThrow();
		expect(() =>
			outputOf({
				name: "B",
				commands: [Posts],
				pipe: [hono({ route: { "Nope.x": {} } })],
			}).build(),
		).toThrow();
	});

	test("catalogs", () => {
		expect(stages).toEqual([
			{ name: "hono", module: "@afora/hono", export: "hono", kind: "sink" },
		]);
		const stage = HonoStages.resolve("hono", { basePath: "/api" });
		expect(stageDescriptionOf(stage)).toEqual({
			kind: "sink",
			name: "hono",
			options: { basePath: "/api" },
		});
		expect(Object.keys(HonoStages.stages)).toEqual(["hono"]);
		expect(Object.keys(StdStages.stages)).not.toContain("hono");
	});
});
