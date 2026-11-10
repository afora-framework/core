import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	type AnyRepository,
	applicationOf,
	blueprintBuilderOf,
	blueprintOf,
	commandBuilderOf,
	type EntityOfRepository,
	entityOf,
	type Id,
	inMemoryProvider,
	isUseCaseCatalog,
	isUseCasePlugin,
	RepositoryOf,
	repositoryOf,
	type StepsUseCaseConstructor,
	UseCaseEntityNotFound,
	type UseCaseTarget,
	useCaseCatalogOf,
	useCaseOf,
	useCaseOriginOf,
	useCasePluginOf,
	useCaseTargetOf,
} from "../../index";

const fields = blueprintBuilderOf();

class Author extends entityOf(blueprintOf((ctx) => ({ name: ctx.string }))) {}
class Post extends entityOf(
	blueprintOf((ctx) => ({
		title: ctx.string,
		author: Author,
		reviewer: ctx.optionalOf(Author),
		tags: ctx.list.optional.string,
	})),
	{ change: ["title"], plugins: (ctx) => [ctx.publishable] },
) {}

const provider = inMemoryProvider();
const Authors = repositoryOf({
	entity: Author,
	provider,
	actions: ["findById", "create"],
});
const Posts = repositoryOf({
	entity: Post,
	provider,
	relations: [Authors],
	actions: ["findById", "create", "update"],
});

type GetMaker = <Repository extends AnyRepository>(
	repository: Repository & UseCaseTarget<Repository, "findById">,
	options?: { readonly name?: string },
) => StepsUseCaseConstructor<
	{ readonly id: typeof Id },
	{ readonly item: EntityOfRepository<Repository> },
	{ readonly repository: Repository }
>;

const get = useCasePluginOf<"get", GetMaker>("get", {
	description: "Finds an entity by id.",
	requires: { actions: ["findById"] },
	compile: (target, options) => ({
		name: (options.name as string | undefined) ?? `Get${target.entityName}`,
		blueprint: fields(() => ({ id: target.field("id").field })),
		response: fields(() => ({ item: target.entity })),
		dependencies: { repository: target.repository },
		errors: [UseCaseEntityNotFound],
		steps: [
			{ find: "repository.findById", args: ["$input.id"], as: "found" },
			{ ensure: "exists", value: "$found", error: UseCaseEntityNotFound },
			{ return: { item: "$found" } },
		],
	}),
});

type PublishMaker = <Repository extends AnyRepository>(
	repository: Repository &
		UseCaseTarget<
			Repository,
			"findById" | "update",
			{ publish(at?: string): unknown },
			"publishable"
		>,
) => StepsUseCaseConstructor<
	{ readonly id: typeof Id },
	{ readonly item: EntityOfRepository<Repository> },
	{ readonly repository: Repository }
>;

const publish = useCasePluginOf<"publish", PublishMaker>("publish", {
	requires: { actions: ["findById", "update"], plugins: ["publishable"] },
	compile: (target) => ({
		name: `Publish${target.entityName}`,
		blueprint: fields(() => ({ id: target.field("id").field })),
		response: fields(() => ({ item: target.entity })),
		dependencies: { repository: target.repository },
		errors: [UseCaseEntityNotFound],
		steps: [
			{ find: "repository.findById", args: ["$input.id"], as: "found" },
			{ ensure: "exists", value: "$found", error: UseCaseEntityNotFound },
			{ invoke: "$found", method: "publish" },
			{ update: "repository", value: "$found", as: "saved" },
			{ return: { item: "$saved" } },
		],
	}),
});

const Generics = useCaseCatalogOf(get, publish);
const commandOf = commandBuilderOf(Generics);

describe("useCasePluginOf", () => {
	test("makes a steps use case for a repository", async () => {
		const author = await Authors.create(new Author({ name: "Ana" }));
		const GetAuthor = get.make(Authors);
		expect(GetAuthor.useCaseName).toBe("GetAuthor");
		expect(GetAuthor.dependencies.repository).toBe(Authors);
		const { item } = await new GetAuthor({ id: author.id }).execute();
		expectTypeOf(item).toEqualTypeOf<Author>();
		expect(item.name).toBe("Ana");
	});

	test("gives the same class for the same repository and equal options", () => {
		expect(get.make(Authors)).toBe(get.make(Authors));
		expect(get.make(Authors, {})).toBe(get.make(Authors));
		const named = get.make(Authors, { name: "ReadAuthor" });
		expect(named).not.toBe(get.make(Authors));
		expect(named).toBe(get.make(Authors, { name: "ReadAuthor" }));
		expect(named.useCaseName).toBe("ReadAuthor");
		class Extended extends RepositoryOf(Authors) {}
		expect(get.make(new Extended())).toBe(get.make(Authors));
	});

	test("keeps where a class came from, and so does a class extending it", () => {
		const GetAuthor = get.make(Authors);
		expect(useCaseOriginOf(GetAuthor)).toEqual({
			plugin: get,
			repository: Authors,
			options: {},
		});
		class Mine extends GetAuthor {}
		expect(useCaseOriginOf(Mine)?.plugin).toBe(get);
		class ByHand extends useCaseOf({
			name: "ByHand",
			blueprint: blueprintOf(() => ({})),
			response: blueprintOf(() => ({})),
		}) {
			override async execute() {
				return {};
			}
		}
		expect(useCaseOriginOf(ByHand)).toBeUndefined();
		expect(useCaseOriginOf(1)).toBeUndefined();
	});

	test("a repository without a required action is a type error and throws", () => {
		const error = (() => {
			try {
				// @ts-expect-error Authors has no update action
				publish.make(Authors);
			} catch (thrown) {
				return thrown as {
					name: string;
					message: string;
					details: { missing: unknown };
				};
			}
		})();
		expect(error?.name).toBe("UseCaseUnavailable");
		expect(error?.details.missing).toEqual({
			actions: ["update"],
			plugins: ["publishable"],
		});
		expect(error?.message).toBe(
			'The use case "publish" is not available for "AuthorRepository": the repository lacks the action "update" and the entity lacks the plugin "publishable".',
		);
	});

	test("an entity without a required record plugin is a type error and throws", () => {
		const Writers = repositoryOf({
			entity: Author,
			provider,
			actions: ["findById", "update"],
		});
		// @ts-expect-error Author is not publishable
		expect(() => publish.make(Writers)).toThrow(
			'the entity lacks the plugin "publishable"',
		);
		expect(publish.make(Posts).useCaseName).toBe("PublishPost");
	});

	test("rejects what is not a repository or an options object", () => {
		const make = get.make as (...args: unknown[]) => unknown;
		expect(() => make({})).toThrow("Invalid use case plugin");
		expect(() => make(Authors, [])).toThrow("plain object");
	});

	test("validates its declaration", () => {
		const settings = { compile: () => ({}) as never };
		expect(() => useCasePluginOf("no name", settings)).toThrow("identifier");
		expect(() => useCasePluginOf("x", {} as never)).toThrow("compile");
		expect(() => useCasePluginOf("x", { ...settings, version: "1" })).toThrow(
			"semantic version",
		);
		expect(() =>
			useCasePluginOf("x", {
				...settings,
				requires: { actions: [1] as never },
			}),
		).toThrow("requires.actions");
	});

	test("describes itself as JSON", () => {
		expect(isUseCasePlugin(get)).toBe(true);
		expect(isUseCasePlugin({})).toBe(false);
		expect(JSON.parse(JSON.stringify(get))).toEqual({
			kind: "use-case-plugin",
			name: "get",
			version: "1.0.0",
			description: "Finds an entity by id.",
			requires: { actions: ["findById"], plugins: [] },
		});
	});
});

describe("useCaseTargetOf", () => {
	test("plans every key of the entity", () => {
		const target = useCaseTargetOf(Posts);
		expect(target.repositoryName).toBe("PostRepository");
		expect(target.entityName).toBe("Post");
		expect(target.actions).toEqual(["findById", "create", "update"]);
		expect(target.changeKeys).toContain("title");
		expect(
			Object.fromEntries(
				target.fields.map((plan) => [
					plan.key,
					[plan.kind, plan.input.key, plan.optional, plan.plugin],
				]),
			),
		).toMatchObject({
			id: ["property", "id", false, undefined],
			title: ["property", "title", false, undefined],
			author: ["entity", "authorId", false, undefined],
			reviewer: ["entity", "reviewerId", true, undefined],
			tags: ["list", "tags", true, undefined],
			publishedAt: ["property", "publishedAt", true, "publishable"],
		});
		expect(target.field("id").identity).toBe(true);
		expect(target.field("title").change).toBe(true);
		expect(target.field("author").related).toBe(Author);
		expect(target.field("author").input.field).toBe(
			Author.blueprint.properties.id,
		);
	});

	test("gives the repository of a relation, with the actions it must have", () => {
		const target = useCaseTargetOf(Posts, "create");
		expect(target.relation("author", ["findById"])).toBe(Authors);
		expect(() => target.relation("author", ["delete"])).toThrow(
			'The use case "create" is not available for "PostRepository": the repository of "author" lacks the action "delete".',
		);
		expect(() => target.relation("title")).toThrow("has no relation");
		expect(() => target.field("nope")).toThrow('has no key "nope"');
		expect(() => useCaseTargetOf({} as never)).toThrow(TypeError);
	});
});

describe("useCaseCatalogOf", () => {
	test("holds the plugins and their makers by name", () => {
		expect(isUseCaseCatalog(Generics)).toBe(true);
		expect(Generics.plugins.get).toBe(get);
		expect(Generics.list).toEqual([get, publish]);
		expect(Generics.context.get).toBe(get.make);
		expectTypeOf(Generics.context.get).toEqualTypeOf<GetMaker>();
		expect(Generics.resolve("get")).toBe(get);
		expect(Generics.resolve("get@1.0.0")).toBe(get);
	});

	test("rejects duplicates, unknown names and other versions", () => {
		expect(() => useCaseCatalogOf(get, get)).toThrow("another plugin");
		expect(() => useCaseCatalogOf({} as never)).toThrow("useCasePluginOf");
		expect(() => Generics.resolve("nope")).toThrow('No use case plugin "nope"');
		expect(() => Generics.resolve("get@2.0.0")).toThrow("does not satisfy");
		expect(() => Generics.resolve("get@x")).toThrow("semantic version");
	});
});

describe("commandBuilderOf", () => {
	class Hello extends useCaseOf({
		name: "Hello",
		blueprint: blueprintOf(() => ({})),
		response: blueprintOf((ctx) => ({ text: ctx.string })),
	}) {
		override async execute() {
			return { text: "hello" };
		}
	}

	test("useCases picks from the catalogs, beside classes written by hand", async () => {
		const Blog = commandOf({
			name: "Blog",
			useCases: (ctx) => ({
				author: ctx.get(Authors),
				publish: ctx.publish(Posts),
				hello: Hello,
			}),
		});
		expect(Blog.operations).toEqual(["author", "publish", "hello"]);
		expect(Blog.useCases.author).toBe(get.make(Authors));
		const author = await Authors.create(new Author({ name: "Bia" }));
		const post = await Posts.create(new Post({ title: "T", author }));
		const found = await Blog.run("author", { id: author.id });
		expectTypeOf(found.item).toEqualTypeOf<Author>();
		expect(found.item.name).toBe("Bia");
		const published = await Blog.run("publish", { id: post.id });
		expect(published.item.isPublished).toBe(true);
		expect(await Blog.run("hello", {})).toEqual({ text: "hello" });
		await expect(
			Blog.run("author", { id: "0190a6a0-0000-7000-8000-000000000001" }),
		).rejects.toThrow("The entity was not found.");
	});

	test("the object form still works, and a later catalog wins a name", () => {
		const other = useCasePluginOf("get", {
			compile: (target) => ({
				...get.make(target.repository as typeof Authors),
				name: "Other",
				blueprint: fields(() => ({})),
				response: fields(() => ({})),
				steps: [{ return: {} }],
			}),
		});
		const build = commandBuilderOf(Generics, useCaseCatalogOf(other));
		const Mixed = build({
			name: "Mixed",
			useCases: (ctx) => ({ get: ctx.get(Authors), hello: Hello }),
		});
		expect(Mixed.useCases.get.useCaseName).toBe("Other");
		expect(
			build({ name: "Plain", useCases: { hello: Hello } }).operations,
		).toEqual(["hello"]);
	});

	test("a plugin that cannot make its use case fails the declaration", () => {
		const error = (() => {
			try {
				commandOf({
					name: "Broken",
					// @ts-expect-error Authors has no update action
					useCases: (ctx) => ({ publish: ctx.publish(Authors) }),
				});
			} catch (thrown) {
				return thrown as { name: string; trace: readonly unknown[] };
			}
		})();
		expect(error?.name).toBe("UseCaseUnavailable");
		expect(JSON.stringify(error?.trace)).toContain("Broken");
	});

	test("rejects what is not a catalog or does not give use cases", () => {
		expect(() => commandBuilderOf({} as never)).toThrow("useCaseCatalogOf");
		expect(() =>
			commandOf({ name: "Empty", useCases: (() => ({})) as never }),
		).toThrow("or a function returning one");
	});
});

describe("in an application", () => {
	const Blog = commandOf({
		name: "Blog",
		useCases: (ctx) => ({ author: ctx.get(Authors), post: ctx.get(Posts) }),
	});
	const settings = {
		name: "blog",
		entities: { Author, Post },
		repositories: { Authors, Posts },
		commands: { Blog },
	};

	test("the use cases a plugin made are registered by the commands that hold them", async () => {
		const App = applicationOf(settings);
		expect(Object.keys(App.useCases)).toEqual(["GetAuthor", "GetPost"]);
		const author = await App.repositories.Authors.create(
			new Author({ name: "Caio" }),
		);
		const { item } = await App.commands.Blog.run("author", { id: author.id });
		expect(item.name).toBe("Caio");
	});

	test("listing one explicitly is the same registration", () => {
		const App = applicationOf({
			...settings,
			useCases: { GetAuthor: Blog.useCases.author },
		});
		expect(Object.keys(App.useCases).sort()).toEqual(["GetAuthor", "GetPost"]);
	});

	test("two with one name conflict, until one is given a name", () => {
		const Twice = commandOf({
			name: "Twice",
			useCases: (ctx) => ({
				one: ctx.get(Authors),
				other: ctx.get(Authors, { name: "GetAuthor" }),
			}),
		});
		expect(() => applicationOf({ ...settings, commands: { Twice } })).toThrow(
			'use case "GetAuthor" is declared as different objects',
		);
	});

	test("their repository must be registered", () => {
		expect(() =>
			applicationOf({
				...settings,
				repositories: { Posts, Authors: undefined } as never,
			}),
		).toThrow();
	});

	test("describe() says which plugin made them, with the steps", () => {
		const App = applicationOf(settings);
		const described = App.describe().useCases.GetAuthor;
		expect(described?.generic).toEqual({
			name: "get",
			version: "1.0.0",
			repository: "Authors",
			options: {},
		});
		expect(described?.implementation).toMatchObject({
			kind: "steps",
			steps: [
				{ find: "repository.findById" },
				{ ensure: "exists", error: { core: "UseCaseEntityNotFound" } },
				{ return: { item: "$found" } },
			],
		});
	});
});
