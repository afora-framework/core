import { afterAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
	compactSpec,
	ExtractionError,
	extractSpec,
	generate,
	normalizeSpec,
	type Spec,
} from "../src";
import { makeProject, removeProject } from "./project";

// A sink given hooks (an authenticator, middlewares) holds code that JSON
// cannot: extraction must not drop it (#199).

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

// biome-ignore lint/suspicious/noExplicitAny: the applications are loaded dynamically
type Any = any;

const HONO = resolve(import.meta.dir, "../../hono/src/index.ts");

const API_TS = `import { hono } from ${JSON.stringify(HONO)};

/** Who calls: a bearer token, written in code. */
export const authenticate = (request: { header(name: string): string | undefined }) =>
	request.header("authorization") === "Bearer writer"
		? { subject: "u1", scopes: ["posts:write"] }
		: null;

/** The sink of the API, with its hooks. */
export const apiSink = hono({ basePath: "/api" }, { authenticator: authenticate });
`;

const HAND_TS = `import {
	applicationOf, blueprintOf, commandOf, entityOf, inMemoryProvider, outputOf, repositoryOf, useCaseOf,
} from "@afora/core";
import { hono } from ${JSON.stringify(HONO)};
import { apiSink } from "./api";

class Post extends entityOf(blueprintOf((ctx) => ({ title: ctx.text, slug: ctx.slug })), {
	unique: ["slug"],
}) {}
const Posts = repositoryOf({ entity: Post, actions: ["findById", "create"] });
const Publish = useCaseOf({
	name: "Publish",
	blueprint: blueprintOf((ctx) => ({ title: ctx.text, slug: ctx.slug })),
	response: blueprintOf(() => ({ post: Post })),
	dependencies: { posts: Posts },
	access: { scopes: ["posts:write"] },
	steps: [
		{ build: Post, values: { title: "$input.title", slug: "$input.slug" }, as: "post" },
		{ create: "posts", value: "$post", as: "saved" },
		{ return: { post: "$saved" } },
	],
});
const Blog = commandOf({ name: "Blog", useCases: { publish: Publish } });
const Api = outputOf({ name: "Api", commands: [Blog], pipe: [apiSink] });
const Open = outputOf({
	name: "Open",
	commands: [Blog],
	pipe: [hono({ basePath: "/open" })],
});
export const Hand = applicationOf({
	name: "hand",
	provider: inMemoryProvider(),
	entities: { Post },
	repositories: { Posts },
	useCases: { Publish },
	commands: { Blog },
	outputs: { Api, Open },
});
`;

const IMPORTS = { "outputs.Api.pipe.0": "../api#apiSink" };
const canonical = (spec: Spec) => compactSpec(normalizeSpec(spec));
const publish = (headers: Record<string, string> = {}) => ({
	method: "POST",
	headers: { "content-type": "application/json", ...headers },
	body: JSON.stringify({ title: "Hello", slug: "hello" }),
});

async function hand() {
	const dir = await makeProject([], {
		"src/api.ts": API_TS,
		"src/hand.ts": HAND_TS,
	});
	projects.push(dir);
	const { Hand } = (await import(join(dir, "src/hand.ts"))) as Any;
	return { dir, Hand };
}

describe("a sink given hooks", () => {
	test("its description says so, and one without hooks is as before", async () => {
		const { Hand } = await hand();
		const { outputs } = Hand.describe();
		expect(outputs.Api.pipe).toEqual([
			{
				kind: "sink",
				name: "hono",
				options: { basePath: "/api" },
				hooks: true,
			},
		]);
		expect(outputs.Open.pipe).toEqual([
			{ kind: "sink", name: "hono", options: { basePath: "/open" } },
		]);
	});

	test("is not extracted without an import mapping", async () => {
		const { Hand } = await hand();
		expect(() => extractSpec(Hand)).toThrow(ExtractionError);
		expect(() => extractSpec(Hand)).toThrow("outputs.Api.pipe.0");
		expect(() => extractSpec(Hand)).toThrow("hooks");
	});

	test("is extracted as the import it is mapped to; a sink without hooks as JSON", async () => {
		const { Hand } = await hand();
		const spec = extractSpec(Hand, { imports: IMPORTS });
		expect(spec.outputs?.Api?.pipe).toEqual([{ import: "../api#apiSink" }]);
		expect(spec.outputs?.Open?.pipe).toEqual([
			{ sink: "hono", options: { basePath: "/open" } },
		]);
	});

	test("round trip: the generated application keeps the authenticator", async () => {
		const { Hand } = await hand();
		const spec = extractSpec(Hand, { imports: IMPORTS });
		const files = generate(
			spec,
			{},
			{
				stages: [{ name: "hono", module: HONO, export: "hono", kind: "sink" }],
			},
		);
		const dir = await makeProject(files, { "src/api.ts": API_TS });
		projects.push(dir);
		const { App } = (await import(join(dir, "src/domain/index.ts"))) as Any;
		const api = App.outputs.Api.build();
		expect((await api.request("/api/blog/publish", publish())).status).toBe(
			401,
		);
		const allowed = await api.request(
			"/api/blog/publish",
			publish({ authorization: "Bearer writer" }),
		);
		expect(allowed.status).toBe(200);
		expect(App.describe().outputs.Api.pipe[0].hooks).toBe(true);
		expect(canonical(extractSpec(App, { imports: IMPORTS }))).toEqual(
			canonical(spec),
		);
	});
});
