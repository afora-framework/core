/**
 * The migration example end to end: real requests to the Hono app of
 * `migration.ts`, and the OpenAPI document it serves, one block per issue.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { jsonSchemaOf } from "@afora/core";
import Ajv2020 from "ajv/dist/2020";
import {
	Article,
	articleInput,
	cmsOf,
	DbDown,
	Inventory,
	Item,
	MAX_BYTES,
	memoryCache,
	PushSubscription,
	Setting,
	trace,
} from "./migration";

const LEGACY_ID = "6f1c2b9e-3d4a-4e8b-9f2a-1c3b5d7e9f0a"; // a UUID v4
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let cms: ReturnType<typeof cmsOf>;
let doc: OpenApiDocument;
interface OpenApiDocument {
	paths: Record<string, Record<string, OpenApiOperation>>;
}
interface OpenApiOperation {
	parameters?: { name: string; in: string; schema: object }[];
	requestBody?: { content: Record<string, { schema: Schema }> };
	responses: Record<
		string,
		{ description: string; content?: Record<string, { schema: Schema }> }
	>;
}
type Schema = {
	type?: string;
	format?: string;
	contentMediaType?: string;
	items?: Schema;
	properties?: Record<string, Schema>;
};

const send = (path: string, init?: RequestInit) =>
	cms.api.fetch(new Request(`http://cms.test${path}`, init));
const json = (method: string, body: unknown, headers = {}) => ({
	method,
	headers: { "content-type": "application/json", ...headers },
	body: JSON.stringify(body),
});

beforeEach(async () => {
	cms = cmsOf();
	const { Settings, Articles, PushSubscriptions } = cms.app.repositories;
	await Settings.create(new Setting({ id: "profile", title: "Alan" }));
	await Articles.create(
		new Article({ id: LEGACY_ID, slug: "hello", title: "Hello" }),
	);
	await PushSubscriptions.create(
		new PushSubscription({
			endpoint: "https://push.example.com/abc",
			owner: "alan",
		}),
	);
	cms.spy.reset();
	doc = (await (await send("/openapi.json")).json()) as OpenApiDocument;
});

describe("#122 ids of every kind", () => {
	test("Key: a settings document is read by its name", async () => {
		const response = await send("/settings/profile");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ id: "profile", title: "Alan" });
		expect((await send("/settings/seo")).status).toBe(404);
		expect(doc.paths["/settings/{id}"]?.get?.parameters?.[0]).toMatchObject({
			name: "id",
			in: "path",
			schema: { type: "string" },
		});
	});

	test("Uuid: a v4 row of the old database loads", async () => {
		const response = await send(`/articles/${LEGACY_ID}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: LEGACY_ID });
	});

	test("Serial on SQLite: the database assigns the id", async () => {
		const created = await send("/items", json("POST", { name: "Lamp" }));
		expect(created.status).toBe(201);
		const { item } = (await created.json()) as { item: { id: number } };
		expect(Number.isInteger(item.id)).toBe(true);

		// The path is read as an integer.
		const found = await send(`/items/${item.id}`);
		expect(found.status).toBe(200);
		expect(await found.json()).toMatchObject({
			item: { id: item.id, name: "Lamp" },
		});
		expect((await send("/items/not-a-number")).status).toBe(400);

		// The client cannot choose the id.
		const chosen = await send("/items", json("POST", { id: 99, name: "No" }));
		expect(chosen.status).toBe(400);
		expect(await chosen.json()).toMatchObject({
			issues: [{ path: ["id"], code: "undeclared_key" }],
		});
		expect((await send("/items/99")).status).toBe(404);

		expect(
			doc.paths["/items/{id}"]?.get?.parameters?.[0]?.schema,
		).toMatchObject({ type: "integer", minimum: 1 });
		expect(
			doc.paths["/items"]?.post?.requestBody?.content["application/json"]
				?.schema.properties,
		).not.toHaveProperty("id");
	});
});

describe("#116 a status chosen at run time", () => {
	test("the health check answers 200, or 503 with the same body", async () => {
		const up = await send("/health");
		expect(up.status).toBe(200);
		expect(await up.json()).toEqual({ ok: true, settings: 1 });

		cms.spy.fail(Setting, "count", new DbDown({ source: "test" }), {
			times: 1,
		});
		const down = await send("/health");
		expect(down.status).toBe(503);
		expect(down.headers.get("content-type")).toContain("application/json");
		expect(await down.json()).toEqual({ ok: false, settings: -1 });

		const responses = doc.paths["/health"]?.get?.responses ?? {};
		expect(Object.keys(responses)).toEqual(
			expect.arrayContaining(["200", "503"]),
		);
		expect(responses["503"]?.description).toStartWith("Service unavailable.");
		expect(responses["503"]?.content?.["application/json"]?.schema).toEqual(
			responses["200"]?.content?.["application/json"]?.schema,
		);
	});
});

describe("#119 DELETE with a JSON body", () => {
	const endpoint = "https://push.example.com/abc";

	test("the body is read, and the owner only from its header", async () => {
		// Someone else, claiming the owner in the body: the header wins.
		const smuggled = await send(
			"/push/subscriptions",
			json("DELETE", { endpoint, owner: "alan" }, { "x-owner": "mallory" }),
		);
		expect(smuggled.status).toBe(200);
		expect(await smuggled.json()).toEqual({ removed: false });

		// Without the header, the owner in the body is dropped: a 400.
		const headless = await send(
			"/push/subscriptions",
			json("DELETE", { endpoint, owner: "alan" }),
		);
		expect(headless.status).toBe(400);

		const removed = await send(
			"/push/subscriptions",
			json("DELETE", { endpoint }, { "x-owner": "alan" }),
		);
		expect(await removed.json()).toEqual({ removed: true });

		const operation = doc.paths["/push/subscriptions"]?.delete;
		const body = operation?.requestBody?.content["application/json"]?.schema;
		expect(Object.keys(body?.properties ?? {})).toEqual(["endpoint"]);
		expect(operation?.parameters).toContainEqual(
			expect.objectContaining({ name: "x-owner", in: "header" }),
		);
	});
});

describe("#118 multipart uploads", () => {
	const upload = (file: File, folder?: string) => {
		const form = new FormData();
		form.set("file", file);
		if (folder) form.set("folder", folder);
		return send("/admin/media", { method: "POST", body: form });
	};
	const png = (size: number) => {
		const bytes = new Uint8Array(size);
		bytes.set(PNG_SIGNATURE);
		return bytes;
	};

	test("a real PNG passes", async () => {
		const response = await upload(
			new File([png(64)], "logo.png", { type: "image/png" }),
			"brand",
		);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({
			name: "logo.png",
			type: "image/png",
			size: 64,
			folder: "brand",
		});
	});

	test("a disguised file and a large one are 400s at the key", async () => {
		const disguised = await upload(
			new File(["<script>alert(1)</script>"], "logo.png", {
				type: "image/png",
			}),
		);
		expect(disguised.status).toBe(400);
		expect(await disguised.json()).toMatchObject({
			title: "InvalidFileContent",
			issues: [expect.objectContaining({ path: ["file"] })],
		});

		const large = await upload(
			new File([png(MAX_BYTES + 1)], "huge.png", { type: "image/png" }),
		);
		expect(large.status).toBe(400);
		expect(await large.json()).toMatchObject({
			issues: [expect.objectContaining({ path: ["file"] })],
		});
	});

	test("OpenAPI documents multipart/form-data with a binary file", () => {
		const content = doc.paths["/admin/media"]?.post?.requestBody?.content;
		expect(Object.keys(content ?? {})).toEqual(["multipart/form-data"]);
		expect(content?.["multipart/form-data"]?.schema.properties?.file).toEqual({
			type: "string",
			format: "binary",
			contentMediaType: "image/png",
		});
	});
});

describe("#117, #115 and #121: a cached list", () => {
	test("GET /articles is a bare array, and OpenAPI says so", async () => {
		const response = await send("/articles");
		expect(await response.json()).toEqual([
			{ id: LEGACY_ID, slug: "hello", title: "Hello" },
		]);
		const schema =
			doc.paths["/articles"]?.get?.responses["200"]?.content?.[
				"application/json"
			]?.schema;
		expect(schema?.type).toBe("array");
		expect(schema?.items?.type).toBe("object");
	});

	test("the second request is served from the cache service", async () => {
		await send("/articles");
		await send("/articles");
		expect(cms.spy.calls(Article, "findMany")).toHaveLength(1);
	});

	test("a test overrides the service in execute()", async () => {
		const cache = memoryCache(
			new Map([["articles", [{ id: "x", slug: "cached", title: "Cached" }]]]),
		);
		const list = await new cms.app.useCases.ListArticles({}).execute({
			cache,
		});
		expect(list).toEqual([{ id: "x", slug: "cached", title: "Cached" }]);
		expect(cms.spy.calls(Article)).toHaveLength(0);
	});
});

describe("#120 and #121: failures injected through the spy", () => {
	test("a declared exception keeps its detail at a 503", async () => {
		cms.spy.fail("Setting", "count", new DbDown({ source: "test" }));
		const response = await send("/admin/settings/count");
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			status: 503,
			title: "DbDown",
			detail: "The database is down.",
		});
	});

	test("a plain Error stays masked", async () => {
		cms.spy.fail("Setting", "count", new Error("password=hunter2"));
		const response = await send("/admin/settings/count");
		expect(response.status).toBe(500);
		const problem = (await response.json()) as { detail: string };
		expect(problem.detail).toBe("Internal error.");
		expect(JSON.stringify(problem)).not.toContain("hunter2");
	});
});

describe("#124 a traced provider", () => {
	test("records each operation, inside the command's transaction too", async () => {
		// Inventory runs each operation in a transaction, so these calls go
		// through the child provider, which wrapProvider wraps too.
		expect(Inventory.transaction).toBe(true);
		trace.length = 0;
		const created = await send("/items", json("POST", { name: "Desk" }));
		const { item } = (await created.json()) as { item: { id: number } };
		await send(`/items/${item.id}`);
		expect(trace).toEqual(["insert", "findOne"]);
		expect(await cms.app.repositories.Items.findById(item.id)).toBeInstanceOf(
			Item,
		);
	});
});

describe("#123 schemas and messages", () => {
	test("jsonSchemaOf validates a sample with Ajv", () => {
		const schema = jsonSchemaOf(articleInput);
		const validate = new Ajv2020({ strict: false }).compile(schema);
		expect(validate({ slug: "hello", title: "Hello" })).toBe(true);
		expect(validate({ slug: "hello" })).toBe(false);
	});

	test("a custom message reaches the client without a prefix", async () => {
		const response = await send(
			"/articles",
			json("POST", { slug: "Not A Slug", title: "Hi" }),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			issues: [
				{
					path: ["slug"],
					message: "Use lowercase letters, numbers and hyphens.",
				},
			],
		});
	});
});
