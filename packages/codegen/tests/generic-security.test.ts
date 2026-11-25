import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
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

const self = { key: "id", context: "userId" };
const owner = { key: "author", context: "userId" };

/**
 * The options the standard use cases took for their safety: changePassword,
 * owner.key "id", relations, maxLimit and owner on restore.
 */
const spec: Spec = {
	version: 1,
	name: "guarded",
	output: { dir: "src/domain" },
	provider: "inMemory",
	entities: {
		User: {
			fields: { name: "text" },
			change: ["name"],
			plugins: ["authenticatable"],
		},
		Folder: { fields: { label: "text", author: "User" } },
		Post: {
			fields: { title: "text", author: "User", folder: "Folder" },
			change: ["title"],
		},
	},
	repositories: {
		Users: {
			entity: "User",
			actions: ["findById", "findByEmail", "create", "update"],
		},
		Folders: {
			entity: "Folder",
			relations: ["Users"],
			actions: ["findById", "create"],
		},
		Posts: {
			entity: "Post",
			deletion: "soft",
			relations: ["Users", "Folders"],
			actions: [
				"findById",
				"findPage",
				"create",
				"delete",
				"restore",
				"exists",
			],
		},
	},
	useCases: {
		Register: { generic: "register", repository: "Users" },
		ChangePassword: {
			generic: "changePassword",
			repository: "Users",
			options: { as: "user", owner: self },
		},
		EditMe: {
			generic: "update",
			repository: "Users",
			options: { as: "user", owner: self },
		},
		CreateFolder: {
			generic: "create",
			repository: "Folders",
			options: { owner },
		},
		CreatePost: {
			generic: "create",
			repository: "Posts",
			options: { as: "post", owner },
		},
		CreatePostAnywhere: {
			generic: "create",
			repository: "Posts",
			options: { as: "post", owner, relations: { folder: { shared: true } } },
		},
		ListPosts: {
			generic: "list",
			repository: "Posts",
			options: { maxLimit: 5 },
		},
		DeletePost: {
			generic: "delete",
			repository: "Posts",
			options: { owner },
		},
		RestorePost: {
			generic: "restore",
			repository: "Posts",
			options: { owner },
		},
	},
	commands: {
		Site: {
			useCases: {
				register: "Register",
				changePassword: "ChangePassword",
				editMe: "EditMe",
				createFolder: "CreateFolder",
				createPost: "CreatePost",
				createPostAnywhere: "CreatePostAnywhere",
				list: "ListPosts",
				remove: "DeletePost",
				restore: "RestorePost",
			},
		},
	},
};

// biome-ignore lint/suspicious/noExplicitAny: a JSON draft the tests mutate freely
type Draft = any;
const draft = (change: (spec: Draft) => void): Draft => {
	const copy = JSON.parse(JSON.stringify(spec));
	change(copy);
	return copy;
};
const issuesOf = (value: unknown) =>
	validateSpec(value).map((i) => `${i.code}@${i.path.join(".")}`);
const messageOf = (value: unknown, code: string) =>
	validateSpec(value).find((i) => i.code === code)?.message ?? "";

describe("validation", () => {
	test("the fixture is valid and fits the schema", () => {
		expect(validateSpec(spec)).toEqual([]);
		expect(Value.Check(specSchema, spec)).toBe(true);
	});

	const cases: [string, (spec: Draft) => void, string][] = [
		[
			'owner.key "id" on create',
			(c) => (c.useCases.CreatePost.options.owner = self),
			"invalid_generic_option@useCases.CreatePost.options.owner",
		],
		[
			'owner.key "id" on register',
			(c) => (c.useCases.Register.options = { owner: self }),
			"invalid_generic_option@useCases.Register.options.owner",
		],
		[
			'restore with owner, without "exists"',
			(c) =>
				(c.repositories.Posts.actions = c.repositories.Posts.actions.filter(
					(action: string) => action !== "exists",
				)),
			"invalid_generic_option@useCases.RestorePost.options.owner",
		],
		[
			"changePassword without update",
			(c) =>
				(c.repositories.Users.actions = ["findById", "findByEmail", "create"]),
			"generic_requires_action@useCases.ChangePassword.repository",
		],
		[
			"changePassword of an entity that is not authenticatable",
			(c) => (c.useCases.ChangePassword.repository = "Posts"),
			"generic_requires_plugin@useCases.ChangePassword.repository",
		],
		[
			"an option changePassword does not take",
			(c) => (c.useCases.ChangePassword.options.values = {}),
			"invalid_generic_option@useCases.ChangePassword.options.values",
		],
		[
			"a maxLimit of 0",
			(c) => (c.useCases.ListPosts.options.maxLimit = 0),
			"invalid_generic_option@useCases.ListPosts.options.maxLimit",
		],
		[
			"a maxLimit that is not whole",
			(c) => (c.useCases.ListPosts.options.maxLimit = 2.5),
			"invalid_generic_option@useCases.ListPosts.options.maxLimit",
		],
		[
			"maxLimit on get",
			(c) =>
				(c.useCases.GetPost = {
					generic: "get",
					repository: "Posts",
					options: { maxLimit: 5 },
				}),
			"invalid_generic_option@useCases.GetPost.options.maxLimit",
		],
		[
			"relations that are not an object",
			(c) => (c.useCases.CreatePostAnywhere.options.relations = ["folder"]),
			"invalid_generic_option@useCases.CreatePostAnywhere.options.relations",
		],
		[
			"relations of a key that holds no entity",
			(c) =>
				(c.useCases.CreatePostAnywhere.options.relations = {
					title: { shared: true },
				}),
			"invalid_generic_option@useCases.CreatePostAnywhere.options.relations",
		],
		[
			"relations with another option",
			(c) =>
				(c.useCases.CreatePostAnywhere.options.relations = {
					folder: { shared: "yes" },
				}),
			"invalid_generic_option@useCases.CreatePostAnywhere.options.relations",
		],
		[
			"relations on list",
			(c) => (c.useCases.ListPosts.options.relations = {}),
			"invalid_generic_option@useCases.ListPosts.options.relations",
		],
	];
	test.each(cases)("%s", (_name, change, expected) => {
		expect(issuesOf(draft(change))).toContain(expected);
	});

	test("logout and changePassword take the token version", () => {
		const versioned = draft((c) => {
			c.entities.User.fields.sessionVersion = "integer";
			c.entities.User.change = ["name", "sessionVersion"];
			c.repositories.Users.actions.push("increment");
			c.useCases.ChangePassword.options.token = {
				versionFrom: "sessionVersion",
			};
			c.useCases.Logout = {
				generic: "logout",
				repository: "Users",
				options: { owner: self, token: { versionFrom: "sessionVersion" } },
			};
		});
		expect(issuesOf(versioned)).toEqual([]);
		expect(Value.Check(specSchema, versioned)).toBe(true);
	});

	test("update of an entity whose only change key is sensitive is refused", () => {
		const refused = draft((c) => {
			c.entities.User.change = [];
		});
		expect(issuesOf(refused)).toEqual([
			"generic_unavailable@useCases.EditMe.generic",
		]);
		expect(messageOf(refused, "generic_unavailable")).toContain(
			'"password" is sensitive',
		);
		expect(messageOf(refused, "generic_unavailable")).toContain(
			"changePassword",
		);
	});

	test("update with owner refuses a change key that holds the owner", () => {
		const refused = draft((c) => {
			c.entities.Note = {
				fields: { text: "text", ownerId: "string" },
				change: ["text", "ownerId"],
			};
			c.repositories.Notes = {
				entity: "Note",
				actions: ["findById", "update"],
			};
			c.useCases.EditNote = {
				generic: "update",
				repository: "Notes",
				options: { owner: { context: "userId" } },
			};
		});
		expect(issuesOf(refused)).toEqual([
			"generic_unavailable@useCases.EditNote.options.owner",
		]);
		expect(messageOf(refused, "generic_unavailable")).toContain(
			'"ownerId" holds the owner',
		);
	});
});

describe("generation", () => {
	const files = Object.fromEntries(
		generate(spec).map((file) => [file.path, file.contents]),
	);
	const useCases = files["src/domain/use-cases.ts"] as string;

	test("the options are written as given", () => {
		expect(useCases).toContain(
			"export const ChangePassword = StdUseCases.context.changePassword(Users, {",
		);
		expect(useCases).toContain('owner: { key: "id", context: "userId" },');
		expect(useCases).toContain("relations: { folder: { shared: true } },");
		expect(useCases).toContain("maxLimit: 5,");
		expect(useCases).toContain(
			"export const RestorePost = StdUseCases.context.restore(Posts, {",
		);
	});
});

describe("JSON -> generate -> run -> extract", () => {
	test("the guards hold in the generated code, which type-checks", async () => {
		const dir = await makeProject(generate(spec));
		projects.push(dir);
		const domain = await import(join(dir, "src/domain/index.ts"));
		const { Site } = domain.App.commands;
		const signUp = async (name: string, email: string) =>
			(await Site.run("register", { name, email, password: "Demo@123" })).item;
		const ana = await signUp("Ana", "ana@example.com");
		const bob = await signUp("Bob", "bob@example.com");
		const asAna = { context: { userId: ana.id } };
		const asBob = { context: { userId: bob.id } };
		const failure = (promise: Promise<unknown>) =>
			promise.then(
				() => undefined,
				(error: Error) => error.name,
			);

		// update takes no password, and changes only the caller.
		const edited = await Site.run(
			"editMe",
			{ id: ana.id, name: "Ana B", password: "Hack@123" },
			asAna,
		).catch((error: Error) => error);
		expect((edited as Error).name).toBe("InvalidUseCaseInput");
		expect(
			(await Site.run("editMe", { id: ana.id, name: "Ana B" }, asAna)).user
				.name,
		).toBe("Ana B");
		expect(
			await failure(Site.run("editMe", { id: ana.id, name: "X" }, asBob)),
		).toBe("UseCaseEntityNotFound");

		// changePassword asks for the current password, of the caller only.
		const change = {
			id: ana.id,
			currentPassword: "Demo@123",
			password: "Next@456",
		};
		expect(await failure(Site.run("changePassword", change, asBob))).toBe(
			"UseCaseEntityNotFound",
		);
		expect(
			await failure(
				Site.run(
					"changePassword",
					{ ...change, currentPassword: "Wrong@123" },
					asAna,
				),
			),
		).toBe("UseCaseInvalidCredentials");
		const { user } = await Site.run("changePassword", change, asAna);
		expect(await user.verifyPassword("Next@456")).toBe(true);

		// create loads only the caller's folder, unless it is shared.
		const { item: folder } = await Site.run(
			"createFolder",
			{ label: "Ana's" },
			asAna,
		);
		expect(
			await failure(
				Site.run("createPost", { title: "Hi", folderId: folder.id }, asBob),
			),
		).toBe("UseCaseEntityNotFound");
		const { post } = await Site.run(
			"createPostAnywhere",
			{ title: "Hi", folderId: folder.id },
			asBob,
		);
		expect(post.folder.id).toBe(folder.id);

		// list caps the limit at maxLimit.
		expect(await failure(Site.run("list", { limit: 6 }))).toBe(
			"InvalidUseCaseInput",
		);
		expect((await Site.run("list", { limit: 5 })).total).toBe(1);

		// restore with owner brings back only the caller's.
		await Site.run("remove", { id: post.id }, asBob);
		expect(await failure(Site.run("restore", { id: post.id }, asAna))).toBe(
			"UseCaseEntityNotFound",
		);
		expect(
			(await Site.run("restore", { id: post.id }, asBob)).item.isDeleted,
		).toBe(false);

		const tsc = await run(dir, "bunx", "tsc", "--noEmit", "-p", dir);
		expect(tsc.output).toBe("");

		expect(normalizeSpec(extractSpec(domain.App))).toEqual(normalizeSpec(spec));
	}, 120_000);
});
