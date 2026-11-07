import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractSpec, generate, loadSpec, normalizeSpec } from "@afora/codegen";
import { useApplication } from "@afora/core";
import { Validator } from "@seriousme/openapi-schema-validator";
import { providers, stages } from "./catalogs.ts";
import { App } from "./src/domain";
import "./src/register.ts";

// biome-ignore lint/suspicious/noExplicitAny: test helper reading JSON bodies
const body = (response: Response): Promise<any> => response.json();

// validates Database and makes the drizzle provider from it
await App.start();
const api = App.outputs.Api.build();

const json = (body: unknown, headers: Record<string, string> = {}) => ({
	method: "POST",
	headers: { "content-type": "application/json", ...headers },
	body: JSON.stringify(body),
});

const ana = {
	name: "Ana",
	email: "ana@example.com",
	plainPassword: "S3cret-pass!",
};

describe("generated code", () => {
	test("src/domain equals what afora.json generates (no drift)", async () => {
		const { spec, extended } = await loadSpec("afora.json");
		const files = generate(spec, extended, { providers, stages });
		const committed = (await readdir("src/domain")).sort();
		expect(files.map((file) => file.path.split("/").pop()).sort()).toEqual(
			committed,
		);
		for (const file of files) {
			const name = file.path.split("/").pop() as string;
			expect(await readFile(join("src/domain", name), "utf8")).toBe(
				file.contents,
			);
		}
	});
});

describe("start", () => {
	test("the started application is reachable anywhere, typed by Register", () => {
		const app: typeof App = useApplication();
		expect(app).toBe(App);
		expect(app.started).toBe(true);
		expect(app.get(app.environments.Database)).toEqual({});
	});
});

describe("the API", () => {
	let userId = "";
	let postId = "";

	test("register answers with the password masked, a duplicate is a 409", async () => {
		const response = await api.request("/api/accounts/register", json(ana));
		expect(response.status).toBe(200);
		const { user } = await body(response);
		expect(user.password).toBe("********");
		expect(user.email).toBe(ana.email);
		userId = user.id;

		const again = await api.request("/api/accounts/register", json(ana));
		expect(again.status).toBe(409);
		expect(again.headers.get("content-type")).toContain(
			"application/problem+json",
		);
	});

	test("login: right password 200, wrong password 401", async () => {
		const ok = await api.request(
			"/api/accounts/login",
			json({ email: ana.email, plainPassword: ana.plainPassword }),
		);
		expect(ok.status).toBe(200);
		const bad = await api.request(
			"/api/accounts/login",
			json({ email: ana.email, plainPassword: "wrong" }),
		);
		expect(bad.status).toBe(401);
		const problem = await body(bad);
		expect(problem.title).toBe("InvalidCredentials");
	});

	test("an invalid body is a 400 with issues", async () => {
		const response = await api.request(
			"/api/accounts/register",
			json({ name: "Ana", email: "nope" }),
		);
		expect(response.status).toBe(400);
		const problem = await body(response);
		expect(problem.issues.length).toBeGreaterThan(0);
		expect(problem.issues[0].path).toBeDefined();
	});

	test("create, publish, list and delete posts with x-user-id", async () => {
		const headers = { "x-user-id": userId };
		for (const title of ["First post", "Second post", "Third post"]) {
			const created = await api.request(
				"/api/blog/create-post",
				json({ title, content: "Hello", tags: ["news"] }, headers),
			);
			expect(created.status).toBe(200);
			const { post } = await body(created);
			if (title === "First post") postId = post.id;
		}

		const missingHeader = await api.request(
			"/api/blog/publish",
			json({ postId }),
		);
		expect(missingHeader.status).toBe(400);

		const published = await api.request(
			"/api/blog/publish",
			json({ postId }, headers),
		);
		expect(published.status).toBe(200);
		const { post } = await body(published);
		expect(post.status).toBe("published");
		expect(post.publishedAt).toBeDefined();
		expect(post.author.password).toBe("********");

		const list = await api.request("/api/blog/list-posts?limit=2&offset=0");
		expect(list.status).toBe(200);
		const page = await body(list);
		expect(page.items).toHaveLength(2);
		expect(page.total).toBe(3);

		const bob = await api.request(
			"/api/accounts/register",
			json({ ...ana, name: "Bob", email: "bob@example.com" }),
		);
		const bobId = (await body(bob)).user.id;
		const stranger = await api.request(
			"/api/blog/delete-post",
			json({ postId }, { "x-user-id": bobId }),
		);
		expect(stranger.status).toBe(404);

		const deleted = await api.request(
			"/api/blog/delete-post",
			json({ postId }, headers),
		);
		expect(deleted.status).toBe(200);
		const after = await body(await api.request("/api/blog/list-posts"));
		expect(after.total).toBe(2);
		expect(after.items.map((item: { id: string }) => item.id)).not.toContain(
			postId,
		);

		const gone = await api.request(
			"/api/blog/publish",
			json({ postId }, headers),
		);
		expect(gone.status).toBe(404);
	});

	test("/openapi.json is a valid OpenAPI document", async () => {
		const response = await api.request("/openapi.json");
		expect(response.status).toBe(200);
		const document = await body(response);
		const result = await new Validator().validate(document);
		expect(result.errors ?? result.errors).toBeUndefined();
		expect(result.valid).toBe(true);
		expect(document.info.title).toBe("Blog");
		expect(Object.keys(document.paths)).toContain("/api/accounts/register");
	});
});

describe("round trip", () => {
	test("extractSpec(App) gives back afora.json", async () => {
		const { spec } = await loadSpec("afora.json");
		const extracted = extractSpec(App, {
			imports: {
				provider: "../provider.ts#provider",
				"useCases.Register.run.hashPassword":
					"../handlers/password.ts#hashPassword",
			},
		});
		const expected = normalizeSpec(spec);
		const actual = normalizeSpec(extracted);
		// the provider of providerFrom is opaque (it is code): extraction needs
		// it mapped to its import, and gives back the spec as written
		expect(actual.provider).toEqual({ import: "../provider.ts#provider" });
		expect(actual).toEqual(expected);
	});
});
