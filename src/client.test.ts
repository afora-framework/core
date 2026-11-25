import { expect, test } from "bun:test";
import { dirname, relative } from "node:path";
import { Type } from "typebox";
import * as client from "./client";
import * as core from "./index";

/** The modules only a server runs, which `@afora/core/client` must not reach. */
const SERVER = [
	"core/application/",
	"core/auth/",
	"core/command/",
	"core/entity/",
	"core/environment/",
	"core/event-policy/",
	"core/logger/",
	"core/openapi/",
	"core/output/",
	"core/record/",
	"core/repository/",
	"core/tracing/",
	"core/use-case/",
	"std/use-cases/",
];

/**
 * Leaves in those folders that a client reaches, and why. The walk goes on
 * through them, so one that starts importing more is caught there.
 */
const LEAVES: Record<string, string> = {
	"core/record/name.ts": "the check of a declared name, which parsing reads",
	"core/entity/id.ts": "the id strategy of the Std `Id` property",
	"core/entity/exceptions.ts": "the exception of an invalid id strategy",
};

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Every module of `src/` that `entry` reaches through imports that stay in the output (`import type` does not). */
async function reachedFrom(entry: string): Promise<Map<string, string>> {
	const reached = new Map<string, string>([[entry, ""]]);
	const queue = [entry];
	for (let path = queue.shift(); path; path = queue.shift()) {
		const source = await Bun.file(path).text();
		for (const { path: specifier } of transpiler.scanImports(source)) {
			if (!specifier.startsWith(".")) continue;
			const target = Bun.resolveSync(specifier, dirname(path));
			if (reached.has(target)) continue;
			reached.set(target, path);
			queue.push(target);
		}
	}
	return reached;
}

test("the client entry reaches no module only a server runs", async () => {
	const reached = await reachedFrom(`${import.meta.dir}/client.ts`);
	const name = (path: string) => relative(import.meta.dir, path);
	const offending = [...reached]
		.map(([path, by]) => [name(path), by && name(by)] as const)
		.filter(
			([path]) =>
				!(path in LEAVES) && SERVER.some((folder) => path.startsWith(folder)),
		)
		.map(([path, by]) => `${path} (imported by ${by})`);
	expect(offending).toEqual([]);
	// The walk itself works: it goes past the entry, into blueprints and Std.
	expect(reached.size).toBeGreaterThan(20);
	expect([...reached.keys()].map(name)).toContain("std/blueprint.ts");
});

test("the client entry exports the objects of the main entry", () => {
	const exports = Object.entries(client);
	const main = new Map(Object.entries(core));
	const names = exports.map(([name]) => name).sort();
	expect(names).toEqual([
		"ExceptionLayers",
		"blueprintOf",
		"enumOf",
		"exceptionOf",
		"listOf",
		"optionalOf",
		"propertyOf",
		"variantOf",
	]);
	for (const [name, value] of exports) expect(main.get(name)).toBe(value);
});

test("a blueprint from either entry is accepted by the other", () => {
	const Title = client.propertyOf({
		name: "title",
		schema: Type.String({ minLength: 1 }),
		preHandle: (value: string) => value.trim(),
	});
	const Tag = client.blueprintOf((ctx) => ({ label: ctx.string }));
	const Kind = client.enumOf(["note", "task"]);

	// Made on the client, used by the server: in a blueprint, a list and a record.
	const Post = core.blueprintOf((ctx) => ({
		title: Title,
		kind: Kind,
		tags: core.listOf(Tag),
		cover: ctx.optionalOf(Tag),
	}));
	class PostRecord extends core.recordOf(Post) {}
	const post = new PostRecord({
		title: "  Hello ",
		kind: "note",
		tags: [{ label: "a" }],
	});
	expect(post.toJSON()).toEqual({
		title: "Hello",
		kind: "note",
		tags: [{ label: "a" }],
	});

	// Made on the server, used by the client.
	const Author = core.blueprintOf((ctx) => ({ name: ctx.string }));
	const Draft = client.blueprintOf((ctx) => ({
		author: Author,
		post: Post,
		reviewers: client.listOf(Author),
		note: client.optionalOf(Author),
		body: client.variantOf("kind", { text: Tag, task: Author }),
		email: ctx.email,
	}));
	const parsed = Draft.safeParse({
		author: { name: "Ada" },
		post: { title: "x", kind: "task", tags: [] },
		reviewers: [{ name: "Grace" }],
		body: { kind: "text", label: "b" },
		email: "ADA@example.com",
	});
	expect(parsed.issues).toBeUndefined();
	if (!parsed.issues) {
		expect(parsed.value.email).toBe("ada@example.com");
		expect(parsed.value.body).toEqual({ kind: "text", label: "b" });
	}

	const failed = Draft.safeParse({
		author: {},
		post: { title: "", kind: "x" },
	});
	expect(failed.issues?.map((issue) => issue.path.join("."))).toEqual(
		expect.arrayContaining(["author.name", "post.title", "post.kind"]),
	);

	// One Standard Schema, whichever entry made it.
	expect(Draft["~standard"].vendor).toBe(Post["~standard"].vendor);
});

test("an exception declared from the client entry is the core's", () => {
	const Offline = client.exceptionOf({
		layer: client.ExceptionLayers.Interface,
		name: "Offline",
		message: "No connection.",
	});
	const error = new Offline({ source: "sync" });
	expect(error).toBeInstanceOf(core.Exception);
	expect(error.layer).toBe(core.ExceptionLayers.Interface);
});
