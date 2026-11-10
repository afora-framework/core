import { describe, expect, expectTypeOf, test } from "bun:test";
import { statusOf } from "../../adapters";
import {
	applicationOf,
	blueprintOf,
	type CommandInput,
	commandOf,
	ExceptionLayers,
	entityOf,
	exceptionOf,
	inMemoryProvider,
	repositoryOf,
	StdUseCases,
	useCaseOf,
} from "../../index";
import { isPasswordHash } from "../properties/password";

const PostNotFound = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "PostNotFound",
	message: "No such post.",
});
const EmailTaken = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "EmailTaken",
	message: "The email is taken.",
});

class User extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string })),
	{
		change: ["name"],
		plugins: (ctx) => [ctx.authenticatable],
	},
) {}

class Post extends entityOf(
	blueprintOf((ctx) => ({
		title: ctx.string,
		status: ctx.string,
		author: User,
	})),
	{
		change: ["title", "status"],
		plugins: (ctx) => [ctx.publishable, ctx.taggable, ctx.archivable],
	},
) {}

class Note extends entityOf(
	blueprintOf((ctx) => ({ text: ctx.string })),
	{
		change: ["text"],
		plugins: (ctx) => [ctx.ownable],
	},
) {}

function domain() {
	const provider = inMemoryProvider();
	const Users = repositoryOf({
		entity: User,
		provider,
		actions: ["findById", "findByEmail", "create", "update"],
	});
	const Posts = repositoryOf({
		entity: Post,
		provider,
		relations: [Users],
		deletion: "soft",
		actions: ["findById", "findPage", "create", "update", "delete", "restore"],
	});
	const Notes = repositoryOf({
		entity: Note,
		provider,
		actions: ["findById", "findPage", "create", "update", "delete"],
	});
	return { Users, Posts, Notes };
}

const strong = "Demo@123";
const owner = { key: "author", context: "userId" } as const;

describe("the standard use cases in a command", () => {
	const { Users, Posts } = domain();
	const Accounts = commandOf({
		name: "Accounts",
		useCases: (ctx) => ({
			register: ctx.register(Users, {
				as: "user",
				errors: { conflict: EmailTaken },
			}),
			login: ctx.login(Users, { as: "user" }),
			rename: ctx.update(Users, { as: "user" }),
		}),
	});
	const Blog = commandOf({
		name: "Blog",
		useCases: (ctx) => ({
			create: ctx.create(Posts, {
				as: "post",
				omit: ["publishedAt", "archivedAt"],
				values: { status: "draft" },
				owner,
			}),
			get: ctx.get(Posts, { as: "post" }),
			list: ctx.list(Posts),
			update: ctx.update(Posts, { as: "post", owner }),
			publish: ctx.publish(Posts, {
				as: "post",
				owner,
				set: { status: "published" },
				errors: { notFound: PostNotFound },
			}),
			unpublish: ctx.unpublish(Posts),
			archive: ctx.archive(Posts),
			unarchive: ctx.unarchive(Posts),
			tag: ctx.tag(Posts),
			untag: ctx.untag(Posts),
			remove: ctx.delete(Posts, { as: "post", owner }),
			restore: ctx.restore(Posts, { as: "post" }),
		}),
	});

	test("register hashes the password, and login checks it", async () => {
		const { user } = await Accounts.run("register", {
			name: "Ana",
			email: "ana@example.com",
			password: strong,
		});
		expectTypeOf(user).toEqualTypeOf<User>();
		expect(isPasswordHash(user.password)).toBe(true);
		expect(user.toJSON().password).toBe("********");
		const stored = await Users.findByEmail("ana@example.com");
		expect(await stored?.verifyPassword(strong)).toBe(true);

		const logged = await Accounts.run("login", {
			email: "ana@example.com",
			password: strong,
		});
		expect(logged.user.id).toBe(user.id);
		const wrong = await Accounts.run("login", {
			email: "ana@example.com",
			password: "nope",
		}).catch((error) => error);
		expect(wrong.name).toBe("UseCaseInvalidCredentials");
		expect(statusOf(wrong)).toBe(401);
		await expect(
			Accounts.run("login", { email: "no@example.com", password: strong }),
		).rejects.toThrow("Invalid credentials.");
	});

	test("register rejects a weak password at the input, and a taken email", async () => {
		const weak = await Accounts.run("register", {
			name: "Bia",
			email: "bia@example.com",
			password: "weak",
		}).catch((error) => error);
		expect(weak.name).toBe("InvalidUseCaseInput");
		expect(statusOf(weak)).toBe(400);
		const taken = await Accounts.run("register", {
			name: "Ana again",
			email: "ana@example.com",
			password: strong,
		}).catch((error) => error);
		expect(taken.name).toBe("EmailTaken");
	});

	test("update changes only what the input gives, a password included", async () => {
		const ana = (await Users.findByEmail("ana@example.com")) as User;
		const renamed = await Accounts.run("rename", { id: ana.id, name: "Ana B" });
		expect(renamed.user.name).toBe("Ana B");
		expect(await renamed.user.verifyPassword(strong)).toBe(true);
		const changed = await Accounts.run("rename", {
			id: ana.id,
			password: "Other@456",
		});
		expect(changed.user.name).toBe("Ana B");
		expect(await changed.user.verifyPassword("Other@456")).toBe(true);
		expectTypeOf<CommandInput<typeof Accounts, "rename">>().toEqualTypeOf<{
			readonly id: string;
			readonly name?: string | undefined;
			readonly password?: string | undefined;
		}>();
	});

	test("create to restore, as the owner", async () => {
		const ana = (await Users.findByEmail("ana@example.com")) as User;
		const context = { userId: ana.id };

		const { post } = await Blog.run("create", { title: "Hello" }, { context });
		expectTypeOf(post).toEqualTypeOf<Post>();
		expect(post.author.id).toBe(ana.id);
		expect(post.status).toBe("draft");
		expectTypeOf<CommandInput<typeof Blog, "create">>().toEqualTypeOf<{
			readonly title: string;
			readonly tags?: string[] | undefined;
		}>();

		const published = await Blog.run("publish", { id: post.id }, { context });
		expect(published.post.isPublished).toBe(true);
		expect(published.post.status).toBe("published");

		const page = await Blog.run("list", {});
		expect(page).toMatchObject({ total: 1, limit: 20, offset: 0 });
		expect(page.items[0]?.title).toBe("Hello");

		const updated = await Blog.run(
			"update",
			{ id: post.id, title: "Hello again" },
			{ context },
		);
		expect(updated.post.title).toBe("Hello again");
		expect(updated.post.status).toBe("published");

		const tagged = await Blog.run("tag", { id: post.id, tags: ["a", "b"] });
		expect(tagged.item.tags).toEqual(["a", "b"]);
		const untagged = await Blog.run("untag", { id: post.id, tags: ["a"] });
		expect(untagged.item.tags).toEqual(["b"]);

		expect((await Blog.run("archive", { id: post.id })).item.isArchived).toBe(
			true,
		);
		expect((await Blog.run("unarchive", { id: post.id })).item.isArchived).toBe(
			false,
		);
		expect(
			(await Blog.run("unpublish", { id: post.id })).item.isPublished,
		).toBe(false);

		const removed = await Blog.run("remove", { id: post.id }, { context });
		expect(removed.post.isDeleted).toBe(true);
		const missing = await Blog.run("get", { id: post.id }).catch((e) => e);
		expect(missing.name).toBe("UseCaseEntityNotFound");
		expect(statusOf(missing)).toBe(404);
		expect((await Blog.run("list", {})).total).toBe(0);

		const restored = await Blog.run("restore", { id: post.id });
		expect(restored.post.isDeleted).toBe(false);
		expect((await Blog.run("get", { id: post.id })).post.title).toBe(
			"Hello again",
		);
	});

	test("another caller does not reach what it does not own", async () => {
		const ana = (await Users.findByEmail("ana@example.com")) as User;
		const { user: bob } = await Accounts.run("register", {
			name: "Bob",
			email: "bob@example.com",
			password: strong,
		});
		const { post } = await Blog.run(
			"create",
			{ title: "Mine" },
			{ context: { userId: ana.id } },
		);
		const context = { userId: bob.id };
		const denied = await Blog.run(
			"publish",
			{ id: post.id },
			{ context },
		).catch((error) => error);
		expect(denied.name).toBe("PostNotFound");
		await expect(
			Blog.run("remove", { id: post.id }, { context }),
		).rejects.toThrow("The entity was not found.");
		// a caller that does not exist cannot create
		await expect(
			Blog.run(
				"create",
				{ title: "x" },
				{ context: { userId: "0190a6a0-0000-7000-8000-000000000001" } },
			),
		).rejects.toThrow("The entity was not found.");
	});

	test("names follow the verb and the entity, or the option", () => {
		expect(Blog.useCases.create.useCaseName).toBe("CreatePost");
		expect(Blog.useCases.remove.useCaseName).toBe("DeletePost");
		expect(Accounts.useCases.register.useCaseName).toBe("RegisterUser");
		expect(
			StdUseCases.context.list(Posts, { name: "ListPosts" }).useCaseName,
		).toBe("ListPosts");
		expect(Blog.useCases.create).toBe(
			StdUseCases.context.create(Posts, {
				as: "post",
				omit: ["publishedAt", "archivedAt"],
				values: { status: "draft" },
				owner,
			}),
		);
	});
});

describe("owner as an id, with the ownable plugin", () => {
	const { Notes } = domain();
	const mine = { context: "userId" } as const;
	const Notebook = commandOf({
		name: "Notebook",
		useCases: (ctx) => ({
			write: ctx.create(Notes, { owner: mine }),
			list: ctx.list(Notes, {
				owner: mine,
				orderBy: [{ key: "text", direction: "asc" }],
			}),
			erase: ctx.delete(Notes, { owner: mine }),
		}),
	});
	const ana = "0190a6a0-0000-7000-8000-00000000000a";
	const bob = "0190a6a0-0000-7000-8000-00000000000b";

	test("create fills it, list filters by it, delete checks it", async () => {
		const { item } = await Notebook.run(
			"write",
			{ text: "b" },
			{ context: { userId: ana } },
		);
		await Notebook.run("write", { text: "a" }, { context: { userId: ana } });
		await Notebook.run("write", { text: "c" }, { context: { userId: bob } });
		expect(item.ownerId).toBe(ana);
		const page = await Notebook.run("list", {}, { context: { userId: ana } });
		expect(page.items.map((note) => note.text)).toEqual(["a", "b"]);
		await expect(
			Notebook.run("erase", { id: item.id }, { context: { userId: bob } }),
		).rejects.toThrow("The entity was not found.");
		await Notebook.run("erase", { id: item.id }, { context: { userId: ana } });
		expect(await Notes.findById(item.id)).toBeUndefined();
	});
});

describe("what a repository and its entity lack", () => {
	const { Users, Posts, Notes } = domain();
	const ctx = StdUseCases.context;
	const unavailable = (make: () => unknown): string => {
		try {
			make();
		} catch (error) {
			const thrown = error as { name: string; message: string };
			if (thrown.name === "UseCaseUnavailable") return thrown.message;
			throw error;
		}
		throw new Error("Expected UseCaseUnavailable.");
	};

	test("an action the repository does not declare", () => {
		// @ts-expect-error Users has no delete action
		expect(unavailable(() => ctx.delete(Users))).toContain(
			'lacks the action "delete"',
		);
		// @ts-expect-error Notes is not soft-deleted: it cannot declare restore
		expect(unavailable(() => ctx.restore(Notes))).toContain(
			'lacks the action "restore"',
		);
	});

	test("a record plugin the entity does not have", () => {
		// @ts-expect-error User is not publishable
		expect(unavailable(() => ctx.publish(Users))).toContain(
			'lacks the plugin "publishable"',
		);
		// @ts-expect-error Note is not taggable
		expect(unavailable(() => ctx.tag(Notes))).toContain(
			'lacks the plugin "taggable"',
		);
		// @ts-expect-error Post is not authenticatable
		expect(unavailable(() => ctx.login(Posts))).toContain("authenticatable");
	});

	test("options the entity cannot satisfy", () => {
		const loose = ctx as unknown as Record<
			string,
			(repository: unknown, options: unknown) => unknown
		>;
		const make = (name: string, repository: unknown, options: unknown) =>
			unavailable(() => loose[name]?.(repository, options));
		expect(make("create", Posts, { omit: ["title"] })).toContain(
			'"title" is required and cannot be omitted',
		);
		expect(make("create", Posts, { omit: ["nope"] })).toContain(
			'has no key "nope"',
		);
		expect(make("create", Posts, { values: { id: "x" } })).toContain(
			"identity key",
		);
		expect(make("create", Posts, { nope: 1 })).toContain('no option "nope"');
		expect(make("create", Posts, { owner: { context: "userId" } })).toContain(
			'has no key "ownerId"',
		);
		expect(make("publish", Posts, { set: { author: "x" } })).toContain(
			"not a change key",
		);
		expect(make("get", Posts, { errors: { notFound: Error } })).toContain(
			"exceptionOf",
		);
		expect(make("get", Posts, { as: "not valid" })).toContain("identifier");
		expect(make("restore", Posts, { owner: { context: "userId" } })).toContain(
			'no option "owner"',
		);
		// the repository of the author cannot load it
		const Writers = repositoryOf({ entity: User, actions: ["create"] });
		const Drafts = repositoryOf({
			entity: Post,
			relations: [Writers],
			actions: ["create"],
		});
		expect(make("create", Drafts, { omit: ["publishedAt"] })).toContain(
			'the repository of "author" lacks the action "findById"',
		);
	});
});

describe("in an application", () => {
	const { Users, Posts } = domain();
	const Blog = commandOf({
		name: "Blog",
		transaction: true,
		useCases: (ctx) => ({
			create: ctx.create(Posts, {
				omit: ["publishedAt", "archivedAt"],
				owner,
				errors: { owner: PostNotFound },
			}),
			register: ctx.register(Users),
		}),
	});

	test("they are registered by their command and described with their origin", () => {
		const App = applicationOf({
			name: "blog",
			entities: { User, Post },
			repositories: { Users, Posts },
			exceptions: { PostNotFound },
			commands: { Blog },
		});
		const { useCases } = App.describe();
		expect(Object.keys(useCases)).toEqual(["CreatePost", "RegisterUser"]);
		expect(useCases.CreatePost?.generic).toEqual({
			name: "create",
			version: "1.0.0",
			repository: "Posts",
			options: {
				omit: ["publishedAt", "archivedAt"],
				owner: { key: "author", context: "userId" },
				errors: { owner: "PostNotFound" },
			},
		});
		expect(useCases.CreatePost?.dependencies).toMatchObject({
			repository: { kind: "repository", ref: "Posts" },
			authorRepository: { kind: "repository", ref: "Users" },
		});
		expect(useCases.RegisterUser?.implementation).toMatchObject({
			kind: "steps",
			steps: [
				{ find: "repository.findByEmail" },
				{ ensure: "absent", error: { core: "UseCaseEntityConflict" } },
				{ run: "convertPassword", fn: { kind: "opaque" } },
				{ build: "User" },
				{ create: "repository" },
				{ return: { item: "$item" } },
			],
		});
	});

	test("an error given in options must be registered, as any other", () => {
		expect(() =>
			applicationOf({
				name: "blog",
				entities: { User, Post },
				repositories: { Users, Posts },
				commands: { Blog },
			}),
		).toThrow("PostNotFound");
	});

	test("a use case written by hand can depend on one", async () => {
		const Register = StdUseCases.context.register(Users);
		class Invite extends useCaseOf({
			name: "Invite",
			blueprint: blueprintOf((ctx) => ({ email: ctx.email })),
			response: blueprintOf((ctx) => ({ id: ctx.id })),
			dependencies: { register: Register },
		}) {
			override async execute({ register = this.dependencies.register } = {}) {
				const { item } = await register({
					name: "Guest",
					email: this.input.email,
					password: strong,
				});
				return { id: item.id };
			}
		}
		const { id } = await new Invite({ email: "guest@example.com" }).execute();
		expect((await Users.findById(id))?.name).toBe("Guest");
	});
});

describe("versioned entities", () => {
	class Page extends entityOf(
		blueprintOf((ctx) => ({ title: ctx.string })),
		{ change: ["title"], versioned: true },
	) {}
	const Pages = repositoryOf({
		entity: Page,
		deletion: "soft",
		actions: ["findById", "create", "update", "delete", "restore"],
	});
	const Wiki = commandOf({
		name: "Wiki",
		useCases: (ctx) => ({
			create: ctx.create(Pages, { as: "page" }),
			update: ctx.update(Pages, { as: "page" }),
			remove: ctx.delete(Pages, { as: "page" }),
			restore: ctx.restore(Pages, { as: "page" }),
		}),
	});

	test("create, update, delete and restore check and bump the version", async () => {
		expectTypeOf<CommandInput<typeof Wiki, "create">>().toEqualTypeOf<{
			readonly title: string;
		}>();
		const { page } = await Wiki.run("create", { title: "a" });
		expect(page.version).toBe(1);
		const stale = (await Pages.findById(page.id)) as Page;
		const updated = await Wiki.run("update", { id: page.id, title: "b" });
		expect(updated.page.version).toBe(2);
		expect((await Pages.findById(page.id))?.version).toBe(2);
		const conflict = await Pages.update(stale.change.title("c")).catch(
			(error) => error,
		);
		expect(conflict.name).toBe("RepositoryConcurrencyConflict");
		expect(statusOf(conflict)).toBe(409);
		expect((await Wiki.run("remove", { id: page.id })).page.version).toBe(3);
		expect((await Wiki.run("restore", { id: page.id })).page.version).toBe(4);
	});
});
