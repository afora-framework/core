import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type SpecData, Validator } from "@seriousme/openapi-schema-validator";
import { Value } from "typebox/value";
import {
	catalog,
	compactSpec,
	ExtractionError,
	extractSpec,
	generate,
	normalizeSpec,
	type Spec,
	type StageCatalogEntry,
	specSchema,
	validateSpec,
} from "../src";
import { BIOME, makeProject, removeProject, run } from "./project";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

const STAGES_TS = `import { type Stage, transformOf } from "@afora/core";

/** A catalog stage: { transform: "label", options: { tag } }. */
export const labeler = transformOf({
	name: "label",
	apply: (operation, options: { tag?: string }) => ({
		...operation,
		tags: [...operation.tags, options.tag ?? "labeled"],
	}),
});

/** A stage written by hand, so it is opaque. */
export const keepAll: Stage = {
	kind: "transform",
	apply: (operation) => operation,
};
`;

const STAGES: readonly StageCatalogEntry[] = [
	{ name: "label", module: "../stages", export: "labeler", kind: "transform" },
];

const blog: Spec = {
	version: 1,
	name: "blog",
	output: { dir: "src/domain" },
	provider: "inMemory",
	entities: {
		Post: { fields: { title: "text", slug: "slug" }, unique: ["slug"] },
	},
	repositories: {
		Posts: { entity: "Post", actions: ["findById", "findBySlug", "create"] },
	},
	exceptions: { PostExists: { layer: "use-case", message: "Post exists." } },
	useCases: {
		Publish: {
			description: "Publishes a post.",
			input: { fields: { title: "text", slug: "slug" } },
			response: { fields: { post: "Post" } },
			dependencies: { posts: "Posts" },
			errors: ["PostExists"],
			implementation: {
				steps: [
					{ find: "posts.findBySlug", args: ["$input.slug"], as: "existing" },
					{ ensure: "absent", value: "$existing", error: "PostExists" },
					{
						build: "Post",
						values: { title: "$input.title", slug: "$input.slug" },
						as: "post",
					},
					{ create: "posts", value: "$post", as: "saved" },
					{ return: { post: "$saved" } },
				],
			},
		},
	},
	commands: {
		Blog: {
			description: "The blog.",
			tags: ["public"],
			useCases: { publish: "Publish" },
		},
		Admin: { tags: ["private"], useCases: { publish: "Publish" } },
	},
	outputs: {
		Api: {
			commands: ["Blog", "Admin"],
			statuses: { PostExists: 409 },
			pipe: [
				{ transform: "select", options: { tags: ["public"] } },
				{ transform: "label", options: { tag: "api" } },
				{
					sink: "openapi",
					options: { info: { title: "Blog", version: "1.0.0" } },
				},
			],
		},
		Plain: { commands: ["Admin"], pipe: [] },
		Manual: {
			commands: ["Blog"],
			pipe: [{ import: "../stages#keepAll" }],
		},
	},
};

const IMPORTS = { "outputs.Manual.pipe.0": "../stages#keepAll" };
const canonical = (spec: Spec) => compactSpec(normalizeSpec(spec));

async function build(spec: Spec) {
	const files = generate(spec, {}, { stages: STAGES });
	const dir = await makeProject(files, { "src/stages.ts": STAGES_TS });
	projects.push(dir);
	return { dir, files, domain: await import(join(dir, "src/domain/index.ts")) };
}

// biome-ignore lint/suspicious/noExplicitAny: the generated application is loaded dynamically
type Any = any;
// biome-ignore lint/suspicious/noExplicitAny: a JSON draft the tests mutate freely
type Draft = any;

const codes = (spec: unknown) =>
	validateSpec(spec, {}, { stages: STAGES }).map(
		(i) => `${i.code}@${i.path.join(".")}`,
	);
const edit = (change: (copy: Draft) => void): Spec => {
	const copy = JSON.parse(JSON.stringify(blog));
	change(copy);
	return copy;
};

describe("catalog", () => {
	test("lists the built-in stages with their kind", () => {
		expect(catalog().stages).toEqual([
			{ name: "openapi", kind: "sink", builtin: true },
			{ name: "select", kind: "transform", builtin: true },
		]);
	});
});

describe("outputs: validation", () => {
	test("the fixture is valid and fits the schema", () => {
		expect(codes(blog)).toEqual([]);
		expect(Value.Check(specSchema, blog)).toBe(true);
	});

	test("an external stage is unknown without the catalog", () => {
		expect(validateSpec(blog).map((i) => i.code)).toContain("unknown_stage");
	});

	const table: [string, (copy: Draft) => void, string][] = [
		[
			"unknown key",
			(c) => (c.outputs.Plain.x = 1),
			"unknown_key@outputs.Plain.x",
		],
		[
			"commands are required",
			(c) => delete c.outputs.Plain.commands,
			"invalid_commands@outputs.Plain.commands",
		],
		[
			"unknown command",
			(c) => (c.outputs.Plain.commands = ["Nope"]),
			"unknown_command@outputs.Plain.commands.0",
		],
		[
			"a command of the wrong kind",
			(c) => (c.outputs.Plain.commands = ["Publish"]),
			"wrong_kind@outputs.Plain.commands.0",
		],
		[
			"a command twice",
			(c) => (c.outputs.Plain.commands = ["Admin", "Admin"]),
			"duplicate_command@outputs.Plain.commands.1",
		],
		[
			"pipe is required",
			(c) => delete c.outputs.Plain.pipe,
			"invalid_pipe@outputs.Plain.pipe",
		],
		[
			"a stage shape",
			(c) => (c.outputs.Plain.pipe = [{ nope: "x" }]),
			"invalid_stage@outputs.Plain.pipe.0",
		],
		[
			"unknown transform",
			(c) => (c.outputs.Plain.pipe = [{ transform: "nope" }]),
			"unknown_stage@outputs.Plain.pipe.0.transform",
		],
		[
			"unknown sink",
			(c) => (c.outputs.Plain.pipe = [{ sink: "nope" }]),
			"unknown_stage@outputs.Plain.pipe.0.sink",
		],
		[
			"a sink named as a transform",
			(c) => (c.outputs.Plain.pipe = [{ transform: "openapi" }]),
			"stage_kind_mismatch@outputs.Plain.pipe.0.transform",
		],
		[
			"a transform named as a sink",
			(c) => (c.outputs.Plain.pipe = [{ sink: "label" }]),
			"stage_kind_mismatch@outputs.Plain.pipe.0.sink",
		],
		[
			"a sink that is not last",
			(c) =>
				(c.outputs.Plain.pipe = [
					{ sink: "openapi", options: { info: { title: "x", version: "1" } } },
					{ transform: "select" },
				]),
			"sink_not_last@outputs.Plain.pipe.0",
		],
		[
			"options that are not an object",
			(c) => (c.outputs.Plain.pipe = [{ transform: "select", options: [] }]),
			"invalid_stage_options@outputs.Plain.pipe.0.options",
		],
		[
			"options that are not JSON",
			(c) =>
				(c.outputs.Plain.pipe = [
					{ transform: "select", options: { tags: [undefined] } },
				]),
			"invalid_stage_options@outputs.Plain.pipe.0.options",
		],
		[
			"an import reference",
			(c) => (c.outputs.Manual.pipe = [{ import: "nope" }]),
			"invalid_import@outputs.Manual.pipe.0",
		],
		[
			"statuses shape",
			(c) => (c.outputs.Api.statuses = []),
			"invalid_statuses@outputs.Api.statuses",
		],
		[
			"a status below 400",
			(c) => (c.outputs.Api.statuses.PostExists = 200),
			"invalid_status@outputs.Api.statuses.PostExists",
		],
		[
			"a status above 599",
			(c) => (c.outputs.Api.statuses.PostExists = 600),
			"invalid_status@outputs.Api.statuses.PostExists",
		],
		[
			"a fractional status",
			(c) => (c.outputs.Api.statuses.PostExists = 409.5),
			"invalid_status@outputs.Api.statuses.PostExists",
		],
		[
			"an unknown exception",
			(c) => (c.outputs.Api.statuses.Nope = 500),
			"unknown_exception@outputs.Api.statuses.Nope",
		],
	];
	test.each(table)("%s", (_name, change, expected) => {
		expect(codes(edit(change))).toContain(expected);
	});

	test("an exception exported by the core has a status", () => {
		const spec = edit((c) => {
			c.outputs.Api.statuses.RepositoryUniqueViolation = 409;
		});
		expect(codes(spec)).toEqual([]);
	});

	test("the stage catalog itself is checked", () => {
		const bad = (stages: unknown) =>
			validateSpec(blog, {}, { stages: stages as StageCatalogEntry[] }).map(
				(i) => i.code,
			);
		expect(bad([{ name: "select", module: "x", export: "y" }])).toContain(
			"invalid_stage_catalog",
		);
		expect(bad([...STAGES, ...STAGES])).toContain("invalid_stage_catalog");
		expect(bad([{ name: "a", module: "", export: "1" }])).toContain(
			"invalid_stage_catalog",
		);
	});
});

describe("outputs: normalization", () => {
	test("drops the defaults", () => {
		const spec = edit((c) => {
			c.outputs.Plain.statuses = {};
			c.outputs.Api.pipe[0].options = {};
		});
		const out = canonical(spec) as Draft;
		expect(out.outputs.Plain.statuses).toBeUndefined();
		expect(out.outputs.Api.pipe[0]).toEqual({ transform: "select" });
	});
});

describe("outputs: generate", () => {
	test("writes outputs.ts and registers them in the application", () => {
		const files = generate(blog, {}, { stages: STAGES });
		const outputs = files.find((f) => f.path.endsWith("outputs.ts"));
		expect(outputs?.contents).toMatchSnapshot();
		const app = files.find((f) => f.path.endsWith("application.ts"));
		expect(app?.contents).toContain("outputs: {");
	});

	test("an invalid spec is refused", () => {
		expect(() =>
			generate(edit((c) => (c.outputs.Plain.pipe = [{ sink: "nope" }]))),
		).toThrow("is not a stage");
	});

	test("clean for Biome and type-checks", async () => {
		const { dir } = await build(blog);
		await Bun.write(
			join(dir, "biome.json"),
			JSON.stringify({
				formatter: { indentStyle: "tab" },
				javascript: { formatter: { quoteStyle: "double" } },
				linter: { rules: { preset: "recommended" } },
				assist: { actions: { source: { organizeImports: "on" } } },
			}),
		);
		const biome = await run(
			dir,
			BIOME,
			"check",
			`--config-path=${dir}`,
			join(dir, "src/domain"),
		);
		expect(biome.output).not.toContain("error");
		expect(biome.code).toBe(0);
		const tsc = await run(dir, "bunx", "tsc", "--noEmit", "-p", dir);
		expect(tsc.output).toBe("");
		expect(tsc.code).toBe(0);
	}, 120_000);
});

describe("outputs: round trip", () => {
	test("JSON -> generate -> build the OpenAPI document -> extract is equal", async () => {
		const { domain } = await build(blog);
		const Api = domain.App.outputs.Api;
		expect(Api.operations.map((op: Any) => op.id)).toEqual(["Blog.publish"]);
		expect(Api.operations[0].tags).toEqual(["public", "api"]);
		const document = Api.build();
		const result = await new Validator().validate(document as SpecData);
		expect(result.errors ?? []).toEqual([]);
		expect(result.valid).toBe(true);
		expect(document.info).toEqual({ title: "Blog", version: "1.0.0" });
		expect(Object.keys(document.paths)).toEqual(["/blog/publish"]);
		expect(document.paths["/blog/publish"].post.responses["409"]).toBeDefined();
		expect(domain.App.outputs.Plain.operations).toHaveLength(1);
		expect(() => domain.App.outputs.Plain.build()).toThrow();

		const extracted = extractSpec(domain.App, { imports: IMPORTS });
		expect(canonical(extracted)).toEqual(canonical(blog));
	});

	test("a stage written by hand needs an import mapping", async () => {
		const { domain } = await build(blog);
		expect(() => extractSpec(domain.App)).toThrow(ExtractionError);
		expect(() => extractSpec(domain.App)).toThrow("outputs.Manual.pipe.0");
	});

	test("a hand-written output extracts to the same document", async () => {
		const { dir } = await build(blog);
		await Bun.write(
			join(dir, "src/hand.ts"),
			`import {
	applicationOf, commandOf, entityOf, blueprintOf, repositoryOf, useCaseOf, inMemoryProvider,
	outputOf, select, openapi,
} from "@afora/core";

class Post extends entityOf(blueprintOf((ctx) => ({ title: ctx.text, slug: ctx.slug })), {
	unique: ["slug"],
}) {}
const Posts = repositoryOf({ entity: Post, actions: ["findById", "findBySlug", "create"] });
const Publish = useCaseOf({
	name: "Publish",
	blueprint: blueprintOf((ctx) => ({ title: ctx.text, slug: ctx.slug })),
	response: blueprintOf(() => ({ post: Post })),
	dependencies: { posts: Posts },
	steps: [
		{ build: Post, values: { title: "$input.title", slug: "$input.slug" }, as: "post" },
		{ create: "posts", value: "$post", as: "saved" },
		{ return: { post: "$saved" } },
	],
});
const Blog = commandOf({ name: "Blog", tags: ["public"], useCases: { publish: Publish } });
const Api = outputOf({
	name: "Api",
	commands: [Blog],
	pipe: [select({ tags: ["public"] }), openapi({ info: { title: "Hand", version: "2.0.0" } })],
});
export const Hand = applicationOf({
	name: "hand",
	provider: inMemoryProvider(),
	entities: { Post },
	repositories: { Posts },
	useCases: { Publish },
	commands: { Blog },
	outputs: { Api },
});
`,
		);
		const { Hand } = (await import(join(dir, "src/hand.ts"))) as Any;
		const spec = extractSpec(Hand);
		expect(spec.outputs?.Api?.pipe).toEqual([
			{ transform: "select", options: { tags: ["public"] } },
			{
				sink: "openapi",
				options: { info: { title: "Hand", version: "2.0.0" } },
			},
		]);
		const { domain } = await build(spec);
		expect(domain.App.outputs.Api.build()).toEqual(Hand.outputs.Api.build());
	});
});
