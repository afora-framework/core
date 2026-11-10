import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { blueprintOf, entityOf, repositoryOf, StdUseCases } from "@afora/core";
import { Value } from "typebox/value";
import {
	catalog,
	extractSpec,
	generate,
	normalizeSpec,
	type Spec,
	specSchema,
	validateSpec,
} from "../src";
import { makeProject, removeProject, run } from "./project";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

const owner = { key: "author", context: "userId" };

/** A blog whose use cases are all standard ones. */
const blog: Spec = {
	version: 1,
	name: "blog",
	output: { dir: "src/domain" },
	provider: "inMemory",
	entities: {
		User: { fields: { name: "text" }, plugins: ["authenticatable"] },
		Post: {
			fields: { title: "text", status: "string", author: "User" },
			change: ["title", "status"],
			plugins: ["publishable", "taggable"],
		},
	},
	repositories: {
		Users: { entity: "User", actions: ["findById", "findByEmail", "create"] },
		Posts: {
			entity: "Post",
			deletion: "soft",
			relations: ["Users"],
			actions: [
				"findById",
				"findPage",
				"create",
				"update",
				"delete",
				"restore",
			],
		},
	},
	exceptions: { PostNotFound: { layer: "use-case" } },
	useCases: {
		Register: {
			generic: "register",
			repository: "Users",
			options: { as: "user" },
			description: "Signs a user up.",
			tags: ["accounts"],
		},
		Login: {
			generic: "login",
			repository: "Users",
			options: { errors: { invalid: "UseCaseInvalidCredentials" } },
		},
		CreatePost: {
			generic: "create",
			repository: "Posts",
			options: {
				as: "post",
				omit: ["publishedAt"],
				values: { status: "draft" },
				owner,
			},
		},
		Publish: {
			generic: "publish",
			repository: "Posts",
			options: {
				owner,
				set: { status: "published" },
				errors: { notFound: "PostNotFound" },
			},
		},
		ListPosts: { generic: "list", repository: "Posts" },
		EditPost: { generic: "update", repository: "Posts", deprecated: true },
		TagPost: { generic: "tag", repository: "Posts" },
		DeletePost: { generic: "delete", repository: "Posts" },
		RestorePost: { generic: "restore", repository: "Posts" },
	},
	commands: {
		Blog: {
			useCases: {
				register: "Register",
				login: "Login",
				create: "CreatePost",
				publish: "Publish",
				list: "ListPosts",
				edit: "EditPost",
				tag: "TagPost",
				remove: "DeletePost",
				restore: "RestorePost",
			},
		},
	},
};

// biome-ignore lint/suspicious/noExplicitAny: a JSON draft the tests mutate freely
type Draft = any;
const draft = (change: (spec: Draft) => void): Draft => {
	const copy = JSON.parse(JSON.stringify(blog));
	change(copy);
	return copy;
};
const codes = (spec: unknown) =>
	validateSpec(spec).map((i) => `${i.code}@${i.path.join(".")}`);

describe("catalog", () => {
	test("lists the standard use cases, with what each needs", () => {
		const { useCases } = catalog();
		expect(useCases.map((useCase) => useCase.name)).toEqual(
			StdUseCases.list.map((plugin) => plugin.name),
		);
		expect(useCases.find((useCase) => useCase.name === "publish")).toEqual({
			name: "publish",
			version: "1.0.0",
			description: "Publishes the publishable entity of an id and stores it.",
			actions: ["findById", "update"],
			plugins: ["publishable"],
			options: ["as", "owner", "set"],
		});
	});

	test("the options it lists are those each use case takes", () => {
		class Everything extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string })),
			{
				change: ["title"],
				plugins: (ctx) => [
					ctx.publishable,
					ctx.archivable,
					ctx.taggable,
					ctx.authenticatable,
				],
			},
		) {}
		const repository = repositoryOf({
			entity: Everything,
			deletion: "soft",
			actions: [
				"findById",
				"findByEmail",
				"findPage",
				"create",
				"update",
				"delete",
				"restore",
			],
		});
		for (const info of catalog().useCases) {
			const make = StdUseCases.plugins[
				info.name as keyof typeof StdUseCases.plugins
			].make as unknown as (repository: unknown, options: unknown) => unknown;
			let message = "";
			try {
				make(repository, { nope: 1 });
			} catch (error) {
				message = (error as Error).message;
			}
			const listed = /\(options: (.+)\)/.exec(message)?.[1]?.split(", ");
			expect([info.name, [...(listed ?? [])].sort()]).toEqual([
				info.name,
				[
					"name",
					"description",
					"tags",
					"deprecated",
					"errors",
					...info.options,
				].sort(),
			]);
		}
	});
});

describe("validation", () => {
	test("the fixture is valid and fits the schema", () => {
		expect(validateSpec(blog)).toEqual([]);
		expect(Value.Check(specSchema, blog)).toBe(true);
	});

	const cases: [string, (spec: Draft) => void, string][] = [
		[
			"an unknown standard use case",
			(c) => (c.useCases.ListPosts.generic = "nope"),
			"unknown_generic@useCases.ListPosts.generic",
		],
		[
			"an unknown repository",
			(c) => (c.useCases.ListPosts.repository = "Nope"),
			"unknown_repository@useCases.ListPosts.repository",
		],
		[
			"a repository that is something else",
			(c) => (c.useCases.ListPosts.repository = "Post"),
			"wrong_kind@useCases.ListPosts.repository",
		],
		[
			"an action the repository lacks",
			(c) => (c.useCases.ListPosts.repository = "Users"),
			"generic_requires_action@useCases.ListPosts.repository",
		],
		[
			"a plugin the entity lacks",
			(c) => (c.entities.Post.plugins = ["taggable"]),
			"generic_requires_plugin@useCases.Publish.repository",
		],
		[
			"a key of a written use case",
			(c) => (c.useCases.ListPosts.input = "X"),
			"unknown_key@useCases.ListPosts.input",
		],
		[
			"options that are not an object",
			(c) => (c.useCases.ListPosts.options = []),
			"invalid_generic_option@useCases.ListPosts.options",
		],
		[
			"an option the use case does not take",
			(c) => (c.useCases.ListPosts.options = { set: {} }),
			"invalid_generic_option@useCases.ListPosts.options.set",
		],
		[
			"the name as an option",
			(c) => (c.useCases.ListPosts.options = { name: "List" }),
			"invalid_generic_option@useCases.ListPosts.options.name",
		],
		[
			"as that is not an identifier",
			(c) => (c.useCases.CreatePost.options.as = "the post"),
			"invalid_generic_option@useCases.CreatePost.options.as",
		],
		[
			"an owner without context",
			(c) => (c.useCases.CreatePost.options.owner = { key: "author" }),
			"invalid_generic_option@useCases.CreatePost.options.owner",
		],
		[
			"an owner key the entity lacks",
			(c) => (c.useCases.CreatePost.options.owner = { context: "userId" }),
			"invalid_generic_option@useCases.CreatePost.options.owner",
		],
		[
			"an omitted key the entity lacks",
			(c) => (c.useCases.CreatePost.options.omit = ["nope"]),
			"invalid_generic_option@useCases.CreatePost.options.omit",
		],
		[
			"a value for a key the entity lacks",
			(c) => (c.useCases.CreatePost.options.values = { nope: 1 }),
			"invalid_generic_option@useCases.CreatePost.options.values",
		],
		[
			"an order by a key the entity lacks",
			(c) => (c.useCases.ListPosts.options = { orderBy: [{ key: "nope" }] }),
			"invalid_generic_option@useCases.ListPosts.options.orderBy",
		],
		[
			"an error that is not declared",
			(c) => (c.useCases.Publish.options.errors = { notFound: "Nope" }),
			"invalid_generic_option@useCases.Publish.options.errors",
		],
		[
			"an error kind that does not exist",
			(c) => (c.useCases.Publish.options.errors = { missing: "PostNotFound" }),
			"invalid_generic_option@useCases.Publish.options.errors",
		],
		[
			"a description that is not a string",
			(c) => (c.useCases.ListPosts.description = 1),
			"invalid_option@useCases.ListPosts.description",
		],
		[
			"an operation of an unknown use case",
			(c) => delete c.useCases.ListPosts,
			"unknown_use_case@commands.Blog.useCases.list",
		],
	];
	test.each(cases)("%s", (_name, change, expected) => {
		expect(codes(draft(change))).toContain(expected);
	});

	test("a written use case can depend on a standard one", () => {
		const spec = draft((c) => {
			c.useCases.Invite = {
				input: { fields: { email: "email" } },
				response: { fields: {} },
				dependencies: { register: "Register" },
				implementation: {
					steps: [
						{
							call: "register",
							input: {
								name: "Guest",
								email: "$input.email",
								password: "Demo@123",
							},
						},
						{ return: {} },
					],
				},
			};
		});
		expect(validateSpec(spec)).toEqual([]);
	});
});

describe("normalization", () => {
	test("core errors become { core }, and empty options and defaults are dropped", () => {
		const normalized = normalizeSpec(
			draft((c) => {
				c.useCases.ListPosts.options = {};
				c.useCases.ListPosts.tags = [];
				c.useCases.ListPosts.deprecated = false;
			}),
		);
		expect(normalized.useCases?.ListPosts).toEqual({
			generic: "list",
			repository: "Posts",
		});
		expect(normalized.useCases?.Login).toEqual({
			generic: "login",
			repository: "Users",
			options: { errors: { invalid: { core: "UseCaseInvalidCredentials" } } },
		});
		expect(normalized.useCases?.Register).toEqual({
			generic: "register",
			repository: "Users",
			options: { as: "user" },
			description: "Signs a user up.",
			tags: ["accounts"],
		});
	});
});

describe("generation", () => {
	const files = Object.fromEntries(
		generate(blog).map((file) => [file.path, file.contents]),
	);

	test("a standard use case is the plugin called with its repository", () => {
		const useCases = files["src/domain/use-cases.ts"] as string;
		expect(useCases).toMatchSnapshot();
		expect(useCases).toContain(
			'import { StdUseCases, UseCaseInvalidCredentials } from "@afora/core";',
		);
		expect(useCases).toContain(
			"export const Publish = StdUseCases.context.publish(Posts, {",
		);
		expect(useCases).toContain("errors: { notFound: PostNotFound },");
		expect(files["src/domain/commands.ts"]).toContain("create: CreatePost");
		expect(files["src/domain/application.ts"]).toContain("CreatePost");
	});
});

describe("JSON -> generate -> run -> extract", () => {
	const build = async () => {
		const dir = await makeProject(generate(blog));
		projects.push(dir);
		return { dir, domain: await import(join(dir, "src/domain/index.ts")) };
	};

	test("the generated command runs, and the code type-checks", async () => {
		const { dir, domain } = await build();
		const { Blog } = domain.App.commands;
		const { user } = await Blog.run("register", {
			name: "Ana",
			email: "ana@example.com",
			password: "Demo@123",
		});
		const context = { userId: user.id };
		const { post } = await Blog.run("create", { title: "Hi" }, { context });
		expect(post.status).toBe("draft");
		const published = await Blog.run("publish", { id: post.id }, { context });
		expect(published.item.status).toBe("published");
		expect((await Blog.run("list", {})).total).toBe(1);
		await Blog.run("remove", { id: post.id });
		expect((await Blog.run("list", {})).total).toBe(0);
		expect((await Blog.run("restore", { id: post.id })).item.isDeleted).toBe(
			false,
		);
		const tsc = await run(dir, "bunx", "tsc", "--noEmit", "-p", dir);
		expect(tsc.output).toBe("");
	}, 120_000);

	test("extraction gives the spec back, with no import to map", async () => {
		const { domain } = await build();
		const described = domain.App.describe().useCases.CreatePost;
		expect(described.generic).toEqual({
			name: "create",
			version: "1.0.0",
			repository: "Posts",
			options: {
				name: "CreatePost",
				as: "post",
				omit: ["publishedAt"],
				values: { status: "draft" },
				owner,
			},
		});
		expect(normalizeSpec(extractSpec(domain.App))).toEqual(normalizeSpec(blog));
	});
});
