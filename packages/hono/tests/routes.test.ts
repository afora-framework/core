import { describe, expect, test } from "bun:test";
import {
	blueprintOf,
	commandOf,
	ExceptionLayers,
	exceptionOf,
	outputOf,
	PROBLEM_MEDIA_TYPE,
	useCaseOf,
} from "@afora/core";
import { type SpecData, Validator } from "@seriousme/openapi-schema-validator";
import { Hono } from "hono";
import { type HonoOptions, hono } from "../src/index";

const EntryNotFound = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "EntryNotFound",
	message: "No such entry.",
});
const Forbidden = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "Forbidden",
	message: "Not allowed.",
});

const entryShape = blueprintOf((ctx) => ({
	slug: ctx.string,
	title: ctx.string,
	views: ctx.integer,
}));

function cms() {
	const entries = new Map<string, { slug: string; title: string }>();
	const found = (slug: string) => {
		const entry = entries.get(slug);
		if (!entry) throw new EntryNotFound({ source: "Entries" });
		return entry;
	};

	class GetEntry extends useCaseOf({
		name: "GetEntry",
		blueprint: blueprintOf((ctx) => ({
			slug: ctx.string,
			views: ctx.optional.integer,
		})),
		response: entryShape,
		errors: [EntryNotFound],
	}) {
		override async execute() {
			return { ...found(this.input.slug), views: this.input.views ?? 0 };
		}
	}
	class CreateEntry extends useCaseOf({
		name: "CreateEntry",
		blueprint: blueprintOf((ctx) => ({ slug: ctx.string, title: ctx.string })),
		response: entryShape,
	}) {
		override async execute() {
			entries.set(this.input.slug, { ...this.input });
			return { ...this.input, views: 0 };
		}
	}
	class UpdateEntry extends useCaseOf({
		name: "UpdateEntry",
		blueprint: blueprintOf((ctx) => ({ slug: ctx.string, title: ctx.string })),
		context: blueprintOf((ctx) => ({
			caller: ctx.optionalOf(
				blueprintOf((c) => ({ id: c.string, scopes: c.list.string })),
			),
			token: ctx.optional.string,
		})),
		response: entryShape,
		errors: [EntryNotFound, Forbidden],
	}) {
		override async execute() {
			const caller = this.context?.caller;
			if (!caller?.scopes.includes("write")) {
				throw new Forbidden({ source: "UpdateEntry" });
			}
			const entry = found(this.input.slug);
			entry.title = `${this.input.title} (by ${caller.id}, ${this.context?.token ?? "no token"})`;
			return { ...entry, views: 0 };
		}
	}
	class RemoveEntry extends useCaseOf({
		name: "RemoveEntry",
		blueprint: blueprintOf((ctx) => ({ slug: ctx.string })),
		response: blueprintOf(() => ({})),
		errors: [EntryNotFound],
	}) {
		override async execute() {
			found(this.input.slug);
			entries.delete(this.input.slug);
			return {};
		}
	}
	return commandOf({
		name: "Entries",
		useCases: {
			get: GetEntry,
			create: CreateEntry,
			update: UpdateEntry,
			remove: RemoveEntry,
		},
	});
}

const routing = {
	route: {
		"Entries.get": { method: "get", path: "/entries/{slug}" },
		"Entries.create": { path: "/entries", status: 201 },
		"Entries.update": { method: "patch", path: "/entries/{slug}" },
		"Entries.remove": {
			method: "delete",
			path: "/entries/{slug}",
			status: 204,
		},
	},
	responses: {
		"Entries.get": {
			headers: { "cache-control": "public, max-age=60, s-maxage=86400" },
		},
	},
	requestId: true,
	context: {
		headers: { token: "authorization" },
		variables: { caller: "caller" },
	},
	security: {
		schemes: { bearer: { type: "http", scheme: "bearer" } },
		operations: { "Entries.update": { scheme: "bearer", scopes: ["write"] } },
	},
	docs: { path: "/openapi.json", info: { title: "Cms", version: "1.0.0" } },
} satisfies HonoOptions;

/** The sink's app under a parent app whose middleware resolves the caller. */
function app(options: HonoOptions = routing) {
	const api = outputOf({
		name: "Cms",
		commands: [cms()],
		statuses: { Forbidden: 403, EntryNotFound: 404 },
		pipe: [hono(options)],
	}).build();
	const parent = new Hono<{ Variables: { caller: unknown } }>();
	parent.use(async (c, next) => {
		const caller = c.req.header("x-test-caller");
		if (caller) c.set("caller", JSON.parse(caller));
		await next();
	});
	parent.route("/", api);
	return parent;
}

const json = (method: string, body: unknown, headers = {}) => ({
	method,
	body: JSON.stringify(body),
	headers: { "content-type": "application/json", ...headers },
});

describe("hono routes", () => {
	test("201 on create, then the path fills the input of get", async () => {
		const server = app();
		const created = await server.request(
			"/entries",
			json("POST", { slug: "hello", title: "Hello" }),
		);
		expect(created.status).toBe(201);
		expect(await created.json()).toEqual({
			slug: "hello",
			title: "Hello",
			views: 0,
		});

		const got = await server.request("/entries/hello?views=3");
		expect(got.status).toBe(200);
		expect(got.headers.get("cache-control")).toBe(
			"public, max-age=60, s-maxage=86400",
		);
		expect(await got.json()).toEqual({
			slug: "hello",
			title: "Hello",
			views: 3,
		});
		// the path wins over the query
		const over = await server.request("/entries/hello?slug=other");
		expect(over.status).toBe(200);
		expect(((await over.json()) as { slug: string }).slug).toBe("hello");

		const missing = await server.request("/entries/nope");
		expect(missing.status).toBe(404);
		expect(missing.headers.get("content-type")).toBe(PROBLEM_MEDIA_TYPE);
		expect(missing.headers.get("cache-control")).toBeNull();
	});

	test("path parameters are decoded and win over the body", async () => {
		const server = app();
		await server.request(
			"/entries",
			json("POST", { slug: "a b", title: "Spaced" }),
		);
		const res = await server.request(
			"/entries/a%20b",
			json(
				"PATCH",
				{ slug: "ignored", title: "New" },
				{ "x-test-caller": JSON.stringify({ id: "u1", scopes: ["write"] }) },
			),
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { slug: string }).slug).toBe("a b");
	});

	test("204 has no body", async () => {
		const server = app();
		await server.request("/entries", json("POST", { slug: "x", title: "X" }));
		const removed = await server.request("/entries/x", { method: "DELETE" });
		expect(removed.status).toBe(204);
		expect(await removed.text()).toBe("");
		expect((await server.request("/entries/x")).status).toBe(404);
	});

	test("the context comes from middleware variables, as they are, and headers", async () => {
		const server = app();
		await server.request("/entries", json("POST", { slug: "e", title: "E" }));
		const update = (headers: Record<string, string>) =>
			server.request("/entries/e", json("PATCH", { title: "T" }, headers));

		const anonymous = await update({});
		expect(anonymous.status).toBe(403);

		const reader = await update({
			"x-test-caller": JSON.stringify({ id: "u1", scopes: ["read"] }),
		});
		expect(reader.status).toBe(403);

		const writer = await update({
			"x-test-caller": JSON.stringify({ id: "u2", scopes: ["write"] }),
			authorization: "Bearer t",
		});
		expect(writer.status).toBe(200);
		expect(((await writer.json()) as { title: string }).title).toBe(
			"T (by u2, Bearer t)",
		);

		// a variable is not coerced: the context blueprint rejects a bad one
		const bad = await update({
			"x-test-caller": JSON.stringify({ id: 1, scopes: "write" }),
		});
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { title: string }).title).toBe(
			"InvalidUseCaseContext",
		);
	});

	test("the request id is propagated or generated on successes and problems", async () => {
		const server = app();
		const sent = await server.request("/entries", {
			...json("POST", { slug: "r", title: "R" }),
			headers: { "content-type": "application/json", "x-request-id": "abc-1" },
		});
		expect(sent.headers.get("x-request-id")).toBe("abc-1");

		const generated = await server.request("/entries/none");
		expect(generated.status).toBe(404);
		expect(generated.headers.get("x-request-id")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);

		const badJson = await server.request("/entries", {
			method: "POST",
			body: "{",
			headers: { "x-request-id": "bad json" },
		});
		expect(badJson.status).toBe(400);
		// not a token: replaced by a new id
		expect(badJson.headers.get("x-request-id")).not.toBe("bad json");
		expect(badJson.headers.get("x-request-id")).toBeTruthy();

		const unknown = await server.request("/nowhere");
		expect(unknown.status).toBe(404);
		expect(unknown.headers.get("x-request-id")).toBeTruthy();

		const named = outputOf({
			name: "Cms",
			commands: [cms()],
			pipe: [hono({ requestId: "x-correlation-id" })],
		}).build();
		const res = await named.request("/entries/create", {
			...json("POST", { slug: "c", title: "C" }),
			headers: {
				"content-type": "application/json",
				"x-correlation-id": "corr-9",
			},
		});
		expect(res.headers.get("x-correlation-id")).toBe("corr-9");
	});

	test("the document agrees: path parameters, statuses, headers and security", async () => {
		const res = await app().request("/openapi.json");
		expect(res.headers.get("x-request-id")).toBeTruthy();
		const document = (await res.json()) as {
			paths: Record<
				string,
				Record<
					string,
					{
						parameters?: { name: string; in: string }[];
						responses: Record<string, { headers?: Record<string, unknown> }>;
						security?: unknown;
					}
				>
			>;
			components: { securitySchemes?: unknown };
		};
		const result = await new Validator().validate(
			document as unknown as SpecData,
		);
		expect(result.errors ?? []).toEqual([]);
		expect(Object.keys(document.paths)).toEqual([
			"/entries/{slug}",
			"/entries",
		]);
		const entry = document.paths["/entries/{slug}"] ?? {};
		expect(entry.get?.parameters?.map((p) => [p.name, p.in])).toEqual([
			["slug", "path"],
			["views", "query"],
		]);
		expect(Object.keys(entry.get?.responses["200"]?.headers ?? {})).toEqual([
			"x-request-id",
			"cache-control",
		]);
		expect(Object.keys(entry.delete?.responses ?? {})[0]).toBe("204");
		expect(
			Object.keys(document.paths["/entries"]?.post?.responses ?? {})[0],
		).toBe("201");
		expect(entry.patch?.security).toEqual([{ bearer: ["write"] }]);
		expect(document.components.securitySchemes).toEqual({
			bearer: { type: "http", scheme: "bearer" },
		});
	});

	test("rejects invalid routing and context options", () => {
		const bad = (options: object) => () => hono(options as never);
		expect(
			bad({ route: { "Entries.get": { path: "/entries/:slug" } } }),
		).toThrow();
		expect(bad({ route: { "Entries.get": { path: "/entries/*" } } })).toThrow();
		expect(bad({ route: { "Entries.get": { status: 301 } } })).toThrow();
		expect(bad({ requestId: 1 })).toThrow();
		expect(
			bad({ responses: { "Entries.get": { headers: { a: 1 } } } }),
		).toThrow();
		expect(bad({ security: { schemes: { b: { type: "nope" } } } })).toThrow();
		expect(bad({ context: { variables: { caller: "" } } })).toThrow();
		expect(bad({ context: { variables: [] } })).toThrow();
		expect(
			bad({
				context: {
					headers: { caller: "x-caller" },
					variables: { caller: "caller" },
				},
			}),
		).toThrow();
		expect(() =>
			outputOf({
				name: "Cms",
				commands: [cms()],
				pipe: [hono({ route: { "Entries.get": { path: "/entries/{id}" } } })],
			}).build(),
		).toThrow();
	});
});
