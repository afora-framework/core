import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
	catalog,
	compactSpec,
	ExtractionError,
	extractSpec,
	generate,
	normalizeSpec,
	type Spec,
	specSchema,
	validateSpec,
} from "../src";
import { makeProject, removeProject } from "./project";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

const REALTIME_TS = `export const published: { topic: string; event: unknown }[] = [];

export const hub = {
	publish(topic: string, event: unknown) {
		published.push({ topic, event });
	},
};

export const queue = { publish() {} };
`;

const POLICY_TS = `import { eventPolicyOf } from "@afora/core";

export const audit = eventPolicyOf<{ readonly label?: string }>({
	name: "audit",
	handle: () => {},
});
`;

/** Posts publishes its events to the realtime hub; Drafts uses a policy of an external catalog. */
const live: Spec = {
	version: 1,
	name: "live",
	output: { dir: "src/domain" },
	provider: "inMemory",
	publishers: {
		realtime: { import: "../realtime#hub" },
		queue: { import: "../realtime#queue" },
	},
	entities: { Post: { fields: { title: "text" } } },
	repositories: {
		PostStore: { entity: "Post", actions: ["findById", "create"] },
	},
	useCases: {
		Write: {
			input: { fields: { title: "text" } },
			response: { fields: { post: "Post" } },
			dependencies: { posts: "PostStore" },
			implementation: {
				steps: [
					{ build: "Post", values: { title: "$input.title" }, as: "post" },
					{ create: "posts", value: "$post", as: "saved" },
					{ return: { post: "$saved" } },
				],
			},
		},
	},
	commands: {
		Posts: {
			useCases: { write: "Write" },
			events: {
				policy: "publishEvents",
				options: { publisher: "realtime", topic: "posts/{id}" },
			},
		},
		Drafts: {
			useCases: { write: "Write" },
			events: {
				policy: "publishEvents",
				options: { publisher: "queue", topic: "drafts", handle: false },
			},
		},
	},
};

const IMPORTS = {
	"publishers.realtime": "../realtime#hub",
	"publishers.queue": "../realtime#queue",
};

const canonical = (spec: Spec) => compactSpec(normalizeSpec(spec));

// biome-ignore lint/suspicious/noExplicitAny: a JSON draft the tests mutate freely
type Draft = any;
const edit = (change: (copy: Draft) => void): Spec => {
	const copy = JSON.parse(JSON.stringify(live));
	change(copy);
	return copy;
};
const codes = (spec: unknown, options = {}) =>
	validateSpec(spec, {}, options).map((i) => `${i.code}@${i.path.join(".")}`);

describe("event policies: validation", () => {
	test("the fixture is valid, fits the schema and the catalog lists publishEvents", () => {
		expect(validateSpec(live)).toEqual([]);
		expect(Value.Check(specSchema, live)).toBe(true);
		expect(catalog().policies).toEqual([
			{ name: "publishEvents", builtin: true },
		]);
	});

	const table: [string, (copy: Draft) => void, string][] = [
		[
			"unknown policy",
			(c) => (c.commands.Posts.events = { policy: "nope" }),
			"unknown_event_policy@commands.Posts.events.policy",
		],
		[
			"options rejected by the policy",
			(c) => (c.commands.Posts.events.options.topic = ""),
			"invalid_event_policy_options@commands.Posts.events.options",
		],
		[
			"options that are not an object",
			(c) => (c.commands.Posts.events.options = []),
			"invalid_event_policy_options@commands.Posts.events.options",
		],
		[
			"a publisher that is not declared",
			(c) => (c.commands.Posts.events.options.publisher = "elsewhere"),
			"unknown_publisher@commands.Posts.events.options.publisher",
		],
		[
			"an unknown key next to policy",
			(c) => (c.commands.Posts.events.extra = 1),
			"unknown_key@commands.Posts.events.extra",
		],
		[
			"onEventError with a policy",
			(c) => (c.commands.Posts.onEventError = { import: "../realtime#queue" }),
			"event_error_requires_after_commit@commands.Posts.onEventError",
		],
		[
			"publishers is an object",
			(c) => (c.publishers = []),
			"invalid_publishers@publishers",
		],
		[
			"a publisher is an import",
			(c) => (c.publishers.realtime = "hub"),
			"invalid_import@publishers.realtime",
		],
		[
			"a publisher key is an identifier",
			(c) => (c.publishers["not-ok"] = { import: "../realtime#hub" }),
			"invalid_name@publishers.not-ok",
		],
	];
	for (const [name, change, expected] of table) {
		test(name, () => {
			expect(codes(edit(change))).toContain(expected);
		});
	}

	test("a publisher may come from an extended spec", () => {
		const base: Spec = {
			version: 1,
			name: "base",
			publishers: { realtime: { import: "./realtime#hub" } },
		};
		const child = edit((c) => {
			c.extends = ["../base/afora.json"];
			delete c.publishers;
			c.commands.Drafts.events.options.publisher = "realtime";
		});
		expect(
			validateSpec(child, { "../base/afora.json": { spec: base } }),
		).toEqual([]);
	});

	test("a policy of an external catalog is checked by name and as JSON", () => {
		const external = edit((c) => {
			c.commands.Drafts.events = { policy: "audit", options: { label: "x" } };
		});
		expect(codes(external)).toContain(
			"unknown_event_policy@commands.Drafts.events.policy",
		);
		const policies = [
			{ name: "audit", module: "../policies", export: "audit" },
		];
		expect(validateSpec(external, {}, { policies })).toEqual([]);
		expect(
			codes(external, {
				policies: [{ name: "publishEvents", module: "x", export: "y" }],
			}),
		).toContain("invalid_policy_catalog@");
	});
});

describe("event policies: generation", () => {
	test("emits the policy call and the publishers of the application", () => {
		const files = generate(live);
		const commands = files.find((f) => f.path.endsWith("commands.ts"))
			?.contents as string;
		expect(commands).toContain("publishEvents");
		expect(commands).toContain('topic: "posts/{id}"');
		const app = files.find((f) => f.path.endsWith("application.ts"))
			?.contents as string;
		expect(app).toContain("publishers: {");
		expect(app).toContain('from "../realtime"');
	});

	test("an external policy is imported from its module", () => {
		const external = edit((c) => {
			c.commands.Drafts.events = { policy: "audit", options: { label: "x" } };
		});
		const files = generate(
			external,
			{},
			{
				policies: [{ name: "audit", module: "../policies", export: "audit" }],
			},
		);
		const commands = files.find((f) => f.path.endsWith("commands.ts"))
			?.contents as string;
		expect(commands).toContain('from "../policies"');
		expect(commands).toContain('audit({ label: "x" })');
	});
});

describe("event policies: round trip", () => {
	// biome-ignore lint/suspicious/noExplicitAny: the generated application is loaded dynamically
	type Any = any;

	async function build(spec: Spec) {
		const dir = await makeProject(generate(spec), {
			"src/realtime.ts": REALTIME_TS,
			"src/policies.ts": POLICY_TS,
		});
		projects.push(dir);
		return {
			domain: (await import(join(dir, "src/domain/index.ts"))) as Any,
			realtime: (await import(join(dir, "src/realtime.ts"))) as Any,
		};
	}

	test("JSON -> generate -> run -> extract is equal", async () => {
		const { domain } = await build(live);
		const description = domain.App.describe();
		expect(description.commands.Posts.events).toEqual({
			kind: "policy",
			name: "publishEvents",
			options: { publisher: "realtime", topic: "posts/{id}" },
		});
		expect(Object.keys(description.publishers)).toEqual(["queue", "realtime"]);
		const out = await domain.App.commands.Posts.run("write", { title: "Hi" });
		expect(JSON.parse(JSON.stringify(out)).post.title).toBe("Hi");

		const extracted = extractSpec(domain.App, { imports: IMPORTS });
		expect(canonical(extracted)).toEqual(canonical(live));
	});

	test("a publisher needs an import mapping", async () => {
		const { domain } = await build(live);
		expect(() => extractSpec(domain.App)).toThrow(ExtractionError);
		expect(() => extractSpec(domain.App)).toThrow('The publisher "queue"');
	});
});
