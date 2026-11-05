import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	blueprintOf,
	type EntityNonUniqueKeyOf,
	type EntityUniqueKeyOf,
	type EventDefinition,
	Exception,
	ExceptionLayers,
	entityOf,
	environmentOf,
	eventOf,
	InvalidEnvironment,
	InvalidRepositoryData,
	InvalidRepositoryDeclaration,
	InvalidRepositoryEntity,
	type IRepositoryProvider,
	inMemoryProvider,
	isRepository,
	listOf,
	optionalOf,
	type RepositoryContext,
	RepositoryEntityNotFound,
	RepositoryOf,
	RepositoryUniqueViolation,
	recordOf,
	repositoryOf,
	useCaseOf,
} from "../../index";

const deleted: string[] = [];
class User extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.string,
		email: ctx.email,
		slug: ctx.slug,
		nickname: ctx.optional.slug,
		bio: ctx.optional.string,
	})),
	{
		unique: ["email"],
		change: ["name", "email"],
		onCreate: () => UserCreated,
		onDelete: () => UserDeleted,
	},
) {}
// The annotations avoid a circular inference between the entity and its events.
const UserCreated: EventDefinition = eventOf(
	"user.created",
	User,
	async () => {},
);
const UserDeleted: EventDefinition = eventOf(
	"user.deleted",
	User,
	async (user) => {
		deleted.push(user.id);
	},
);

const ana = () =>
	new User({ name: "Ana", email: "ana@example.com", slug: "Ana Maria" });

/** The exception `promise` rejects with, which must be `target`. */
async function rejected(
	promise: Promise<unknown>,
	target: Parameters<Exception["is"]>[0],
	layer = ExceptionLayers.Repository,
): Promise<Exception> {
	const error = await promise.then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(Exception);
	expect((error as Exception).is(target)).toBe(true);
	expect((error as Exception).passedThrough(layer)).toBe(true);
	return error as Exception;
}

const ALL = [
	"findById",
	"findByEmail",
	"findBySlug",
	"findByNickname",
	"findManyByName",
	"findManyByCreatedAt",
	"create",
	"update",
	"delete",
	"count",
] as const;

describe("repositoryOf", () => {
	test("id, options.unique and unique properties are the unique keys", () => {
		expect(User.options.unique).toEqual(["id", "email", "slug", "nickname"]);
		expectTypeOf<EntityUniqueKeyOf<typeof User>>().toEqualTypeOf<
			"id" | "email" | "slug" | "nickname"
		>();
	});

	test("has only the declared actions, every one async", async () => {
		const users = repositoryOf({
			entity: User,
			actions: ["findById", "count"],
		});
		expect(isRepository(users)).toBe(true);
		expect(users.actions).toEqual(["findById", "count"]);
		expect(users.entity).toBe(User);
		expect("create" in users).toBe(false);
		expect(users.count()).toBeInstanceOf(Promise);
		expect(await users.count()).toBe(0);
		// @ts-expect-error not declared
		users.create;
	});

	test("create, find, update, count and delete", async () => {
		const users = repositoryOf({ entity: User, actions: ALL });
		const user = await users.create(ana());
		expect(await users.count()).toBe(1);

		const found = await users.findById(user.id);
		expect(found).toBeInstanceOf(User);
		expect(found).not.toBe(user);
		expect(found?.toJSON()).toEqual(user.toJSON());
		expect((await users.findByEmail("ANA@example.com "))?.id).toBeUndefined();
		expect((await users.findByEmail("ana@example.com"))?.id).toBe(user.id);
		expect((await users.findBySlug("ana-maria"))?.id).toBe(user.id);
		expect(await users.findByNickname("nope")).toBeUndefined();
		expect(await users.findManyByName("Ana")).toHaveLength(1);
		expect(await users.findManyByName("Bia")).toEqual([]);

		user.change.name("Bia");
		expect(await users.update(user)).toBe(user);
		expect((await users.findById(user.id))?.name).toBe("Bia");

		expect(await users.delete(user.id)).toBeInstanceOf(User);
		expect(await users.count()).toBe(0);
		expect(await users.findById(user.id)).toBeUndefined();
	});

	test("create builds the entity from its input", async () => {
		const users = repositoryOf({ entity: User, actions: ["create"] });
		const user = await users.create({
			name: "Ana",
			email: "ana@example.com",
			slug: "ana",
		});
		expect(user).toBeInstanceOf(User);
		expect(user.pullEvents().map((event) => event.name)).toEqual([
			"user.created",
		]);
	});

	test("an entity read back does not emit onCreate again", async () => {
		const users = repositoryOf({
			entity: User,
			actions: ["create", "findById"],
		});
		const user = await users.create(ana());
		const found = await users.findById(user.id);
		expect(found?.pullEvents()).toEqual([]);
	});

	test("delete destroys the entity, which emits onDelete", async () => {
		const users = repositoryOf({ entity: User, actions: ["create", "delete"] });
		const user = await users.create(ana());
		user.pullEvents();
		await users.delete(user);
		expect(user.isDeleted).toBe(true);
		const events = user.pullEvents();
		expect(events.map((event) => event.name)).toEqual(["user.deleted"]);
		await events[0]?.handle();
		expect(deleted).toContain(user.id);
		await rejected(users.delete(user.id), RepositoryEntityNotFound);
	});

	test("the in-memory provider enforces every unique key", async () => {
		const users = repositoryOf({ entity: User, actions: ["create", "update"] });
		const user = await users.create(ana());
		await rejected(users.create(user), RepositoryUniqueViolation);
		await rejected(
			users.create(
				new User({ name: "B", email: "ana@example.com", slug: "b" }),
			),
			RepositoryUniqueViolation,
		);
		await rejected(
			users.create(
				new User({ name: "B", email: "b@example.com", slug: "ana-maria" }),
			),
			RepositoryUniqueViolation,
		);

		const other = await users.create(
			new User({ name: "B", email: "b@example.com", slug: "b" }),
		);
		other.change.email("ana@example.com");
		await rejected(users.update(other), RepositoryUniqueViolation);
		await rejected(users.update(ana()), RepositoryEntityNotFound);
	});

	test("rejects a value that is not an entity of its class", async () => {
		const users = repositoryOf({ entity: User, actions: ["update"] });
		class Other extends entityOf(
			blueprintOf((ctx) => ({ name: ctx.string })),
		) {}
		await rejected(
			// @ts-expect-error another entity
			users.update(new Other({ name: "x" })),
			InvalidRepositoryEntity,
		);
	});

	test("each repository without a provider has its own store", async () => {
		const a = repositoryOf({ entity: User, actions: ["create", "count"] });
		const b = repositoryOf({ entity: User, actions: ["count"] });
		await a.create(ana());
		expect(await a.count()).toBe(1);
		expect(await b.count()).toBe(0);

		const shared = inMemoryProvider();
		const c = repositoryOf({
			entity: User,
			actions: ["create"],
			provider: shared,
		});
		const d = repositoryOf({
			entity: User,
			actions: ["count"],
			provider: shared,
		});
		await c.create(ana());
		expect(await d.count()).toBe(1);
	});

	test("findBy requires a unique key; findManyBy a key that is not unique", () => {
		const declare = (actions: readonly string[]) => () =>
			repositoryOf({ entity: User, actions: actions as never });
		expect(declare(["findByName"])).toThrow(InvalidRepositoryDeclaration);
		expect(declare(["findByName"])).toThrow(/"name" to be a unique key/);
		expect(declare(["findManyByUnknown"])).toThrow(/not an action/);
		expect(declare([])).toThrow(InvalidRepositoryDeclaration);
		expect(declare(["findManyByBio", "findManyByDeletedAt"])).not.toThrow();
		for (const action of [
			"findManyById",
			"findManyByEmail",
			"findManyBySlug",
		]) {
			expect(declare([action])).toThrow(InvalidRepositoryDeclaration);
		}
		expect(declare(["findManyByEmail"])).toThrow(
			/unique key "email" of User; use "findByEmail"/,
		);
		expect(() =>
			// @ts-expect-error email is unique
			repositoryOf({ entity: User, actions: ["findManyByEmail"] }),
		).toThrow(InvalidRepositoryDeclaration);
		expectTypeOf<EntityNonUniqueKeyOf<typeof User>>().toEqualTypeOf<
			"name" | "bio" | "createdAt" | "updatedAt" | "deletedAt"
		>();
		expect(() =>
			// @ts-expect-error name is not unique
			repositoryOf({ entity: User, actions: ["findByName"] }),
		).toThrow(InvalidRepositoryDeclaration);
		expect(() =>
			// @ts-expect-error not an entity
			repositoryOf({ entity: class {}, actions: ["count"] }),
		).toThrow(InvalidRepositoryDeclaration);
	});

	test("a provider must have the methods the actions call", () => {
		expect(() =>
			repositoryOf({
				entity: User,
				actions: ["count"],
				provider: {} as IRepositoryProvider,
			}),
		).toThrow(/no "count"/);
	});
});

describe("environmentDependencies", () => {
	const Database = environmentOf(
		blueprintOf((ctx) => ({ DATABASE_URL: ctx.url })),
		{ source: () => ({ DATABASE_URL: "https://db.example.com" }) },
	);
	const Region = environmentOf(
		blueprintOf((ctx) => ({ REGION: ctx.string })),
		{
			source: () => ({ REGION: "sa-east-1", OTHER: "ignored" }),
		},
	);

	test("the provider gets the merged environments as context.env", async () => {
		const seen: unknown[] = [];
		const memory = inMemoryProvider();
		const provider: IRepositoryProvider<{
			readonly DATABASE_URL: string;
			readonly REGION: string;
		}> = {
			...memory,
			async count(context) {
				seen.push(context.env, context.name, context.unique);
				return memory.count(context as RepositoryContext);
			},
		};
		const users = repositoryOf({
			entity: User,
			actions: ["count"],
			provider,
			environmentDependencies: [Database, Region],
		});
		await users.count();
		expect(seen).toEqual([
			{ DATABASE_URL: "https://db.example.com", REGION: "sa-east-1" },
			"UserRepository",
			["id", "email", "slug", "nickname"],
		]);
	});

	test("an invalid environment throws on first use, not on declaration", async () => {
		const Broken = environmentOf(
			blueprintOf((ctx) => ({ URL: ctx.url })),
			{
				source: () => ({}),
			},
		);
		const users = repositoryOf({
			entity: User,
			actions: ["count"],
			environmentDependencies: Broken,
		});
		await rejected(users.count(), InvalidEnvironment);
	});
});

describe("RepositoryOf", () => {
	const Users = repositoryOf({
		entity: User,
		actions: ["findByEmail", "findManyByName", "create"],
	});

	class UsersRepository extends RepositoryOf(Users) {
		readonly created: string[] = [];

		async findNamed(name: string): Promise<string[]> {
			return (await this.findManyByName(name)).map((user) => user.email);
		}

		// findBy<Key> and findManyBy<Key> are named by the entity, so they are
		// typed as properties: override them with a field, which can call super.
		override findByEmail = async (email: string) =>
			super.findByEmail(email.trim().toLowerCase());

		async countAll(): Promise<number> {
			return this.provider.count(this.context);
		}

		override async create(...args: Parameters<typeof Users.create>) {
			const user = await super.create(...args);
			this.created.push(user.email);
			return user;
		}
	}

	test("extends a repository with methods and overrides", async () => {
		const users = new UsersRepository();
		expect(isRepository(users)).toBe(true);
		expect(users).toBeInstanceOf(Users.constructor);
		await users.create(ana());
		expect(users.created).toEqual(["ana@example.com"]);
		expect(await users.findNamed("Ana")).toEqual(["ana@example.com"]);
		expect(await users.countAll()).toBe(1);
		expect((await users.findByEmail(" ANA@example.com"))?.name).toBe("Ana");
		// The class shares the store of the repository it extends.
		expect(await Users.findByEmail("ana@example.com")).toBeInstanceOf(User);
		expectTypeOf(users.findByEmail).returns.resolves.toEqualTypeOf<
			User | undefined
		>();
	});

	test("rejects anything but a repository", () => {
		// @ts-expect-error not a repository
		expect(() => RepositoryOf({})).toThrow(InvalidRepositoryDeclaration);
	});
});

describe("references", () => {
	let counter = 0;
	const person = (name = "Ana") => {
		counter++;
		return new User({
			name,
			email: `${name.toLowerCase()}${counter}@example.com`,
			slug: `${name.toLowerCase()}-${counter}`,
		});
	};

	const Card = recordOf(
		blueprintOf((ctx) => ({ label: ctx.string, owner: User })),
	);
	class Post extends entityOf(
		blueprintOf((ctx) => ({
			title: ctx.string,
			author: User,
			editor: optionalOf(User),
			reviewers: listOf(User),
			profile: blueprintOf(() => ({ manager: User })),
			card: Card,
		})),
	) {}
	class Assignment extends entityOf(
		blueprintOf(() => ({ author: User })),
		{ unique: ["author"] },
	) {}

	type Call = { readonly method: string; readonly value?: unknown };
	/** A provider that keeps what it was asked, with or without `findIn`. */
	function spy(withFindIn = true) {
		const memory = inMemoryProvider();
		const calls: Call[] = [];
		const provider: IRepositoryProvider = {
			...memory,
			async findOne(context, key, value) {
				calls.push({ method: "findOne", value });
				return memory.findOne(context, key, value);
			},
			async insert(context, data) {
				calls.push({ method: "insert", value: data });
				return memory.insert(context, data);
			},
		};
		if (withFindIn) {
			provider.findIn = async (context, key, values) => {
				calls.push({ method: "findIn", value: values });
				return (memory.findIn as NonNullable<typeof memory.findIn>)(
					context,
					key,
					values,
				);
			};
		} else {
			delete provider.findIn;
		}
		return { provider, calls };
	}

	function setup(withFindIn = true) {
		const users = spy(withFindIn);
		const posts = spy();
		const Users = repositoryOf({
			entity: User,
			provider: users.provider,
			actions: ["findById", "create", "update", "delete", "findManyByName"],
		});
		const Posts = repositoryOf({
			entity: Post,
			provider: posts.provider,
			relations: [Users],
			actions: [
				"findById",
				"findManyByAuthor",
				"findManyByReviewers",
				"findManyByTitle",
				"create",
			],
		});
		return { users, posts, Users, Posts };
	}

	const postOf = (
		author: User,
		extra: { editor?: User; reviewers?: User[]; title?: string } = {},
	) =>
		new Post({
			title: extra.title ?? "Title",
			author,
			editor: extra.editor,
			reviewers: extra.reviewers ?? [],
			profile: { manager: author },
			card: { label: "card", owner: author },
		});

	const insertedBy = (provider: { calls: Call[] }) =>
		provider.calls.find((call) => call.method === "insert")?.value as Record<
			string,
			unknown
		>;

	test("stores the id of an entity it holds, and reads the entity back", async () => {
		const { posts, Users, Posts } = setup();
		const author = await Users.create(person());
		const post = await Posts.create(postOf(author));
		expect(insertedBy(posts).author).toBe(author.id);

		const found = await Posts.findById(post.id);
		expect(found?.author).toBeInstanceOf(User);
		expect(found?.author.id).toBe(author.id);
		expect(found?.author.name).toBe("Ana");
	});

	test("an optional reference is undefined when absent, and resolved when present", async () => {
		const { Users, Posts } = setup();
		const author = await Users.create(person());
		const editor = await Users.create(person("Bia"));
		const alone = await Posts.create(postOf(author));
		const edited = await Posts.create(postOf(author, { editor }));
		expect((await Posts.findById(alone.id))?.editor).toBeUndefined();
		expect((await Posts.findById(edited.id))?.editor?.id).toBe(editor.id);
	});

	test("a list stores the ids, resolves them in order, and shares repeated ids", async () => {
		const { posts, Users, Posts } = setup();
		const a = await Users.create(person("Ana"));
		const b = await Users.create(person("Bia"));
		const post = await Posts.create(postOf(a, { reviewers: [b, a, b] }));
		expect(insertedBy(posts).reviewers).toEqual([b.id, a.id, b.id]);

		const found = await Posts.findById(post.id);
		expect(found?.reviewers.map((user) => user.id)).toEqual([b.id, a.id, b.id]);
		expect(found?.reviewers[0]).toBe(found?.reviewers[2]);
		expect(found?.reviewers[1]).toBe(found?.author);
	});

	test("a blueprint or a record holding an entity stores only its id", async () => {
		const { posts, Users, Posts } = setup();
		const author = await Users.create(person());
		const post = await Posts.create(postOf(author));
		expect(insertedBy(posts).profile).toEqual({ manager: author.id });
		expect(insertedBy(posts).card).toEqual({ label: "card", owner: author.id });

		const found = await Posts.findById(post.id);
		expect(found?.profile.manager.id).toBe(author.id);
		expect(found?.card).toBeInstanceOf(Card);
		expect(found?.card.owner).toBe(found?.author);
	});

	test("a change to the entity it holds shows when the record is read again", async () => {
		const { Users, Posts } = setup();
		const author = await Users.create(person());
		const post = await Posts.create(postOf(author));
		author.change.name("Ana Maria");
		await Users.update(author);
		const found = await Posts.findById(post.id);
		expect(found?.author.name).toBe("Ana Maria");
		expect(found?.card.owner.name).toBe("Ana Maria");
	});

	test("findManyBy takes an entity or its id, after the entity changed", async () => {
		const { Users, Posts } = setup();
		const author = await Users.create(person());
		const reviewer = await Users.create(person("Bia"));
		const post = await Posts.create(postOf(author, { reviewers: [reviewer] }));
		author.change.name("Changed");
		await Users.update(author);

		const ids = async (promise: Promise<Post[]>) =>
			(await promise).map((it) => it.id);
		expect(await ids(Posts.findManyByAuthor(author))).toEqual([post.id]);
		expect(await ids(Posts.findManyByAuthor(author.id))).toEqual([post.id]);
		expect(await Posts.findManyByAuthor(reviewer)).toEqual([]);
		expect(await Posts.findManyByReviewers([reviewer])).toHaveLength(1);
		expect(await Posts.findManyByReviewers([reviewer.id])).toHaveLength(1);

		type Parameter<Method extends (value: never) => unknown> =
			Parameters<Method>[0];
		expectTypeOf<Parameter<typeof Posts.findManyByAuthor>>().toEqualTypeOf<
			User | string
		>();
		expectTypeOf<Parameter<typeof Posts.findManyByReviewers>>().toEqualTypeOf<
			readonly (User | string)[]
		>();
		expectTypeOf<
			Parameter<typeof Posts.findManyByTitle>
		>().toEqualTypeOf<string>();
	});

	test("a unique reference key has a findBy", async () => {
		const { Users } = setup();
		const Assignments = repositoryOf({
			entity: Assignment,
			relations: [Users],
			actions: ["findByAuthor", "create"],
		});
		const author = await Users.create(person());
		const assignment = await Assignments.create({ author });
		expect((await Assignments.findByAuthor(author))?.id).toBe(assignment.id);
		expect((await Assignments.findByAuthor(author.id))?.id).toBe(assignment.id);
		expect(await Assignments.findByAuthor("unknown")).toBeUndefined();
		await rejected(Assignments.create({ author }), RepositoryUniqueViolation);
	});

	test("the relations must be exactly the repositories of the entities it holds", () => {
		const { Users } = setup();
		class Other extends entityOf(
			blueprintOf((ctx) => ({ name: ctx.string })),
		) {}
		const Others = repositoryOf({ entity: Other, actions: ["count"] });
		const declare = (relations?: unknown) => () =>
			repositoryOf({
				entity: Post,
				actions: ["count"],
				relations: relations as never,
			});

		expect(declare()).toThrow(InvalidRepositoryDeclaration);
		expect(declare()).toThrow(/Missing relation.*"User"/);
		expect(declare([Users, Others])).toThrow(/"Other" is not held/);
		expect(declare([Users, Users])).toThrow(/"User" is duplicated/);
		expect(declare([{}])).toThrow(InvalidRepositoryDeclaration);
		expect(declare([User])).toThrow(InvalidRepositoryDeclaration);
		expect(declare("users")).toThrow(InvalidRepositoryDeclaration);
		expect(declare([Users])).not.toThrow();
		// An entity that holds no entity takes no relation.
		expect(() =>
			repositoryOf({ entity: User, actions: ["count"], relations: [Users] }),
		).toThrow(InvalidRepositoryDeclaration);
	});

	test("a relation can be the repository of a subclass of the entity", async () => {
		class Admin extends User {}
		const Admins = repositoryOf({ entity: Admin, actions: ["create"] });
		const Posts = repositoryOf({
			entity: Post,
			actions: ["create", "findById"],
			relations: [Admins],
		});
		const admin = await Admins.create(
			new Admin({ name: "Root", email: "root@example.com", slug: "root" }),
		);
		const post = await Posts.create(postOf(admin));
		expect((await Posts.findById(post.id))?.author).toBeInstanceOf(Admin);
	});

	test("an entity that was removed fails the read, even in an optional field", async () => {
		const { Users, Posts } = setup();
		const author = await Users.create(person());
		const editor = await Users.create(person("Bia"));
		const withEditor = await Posts.create(postOf(author, { editor }));
		await Users.delete(editor);

		for (const promise of [
			Posts.findById(withEditor.id),
			Posts.findManyByTitle("Title"),
		]) {
			const error = await rejected(promise, InvalidRepositoryData);
			expect(error.is(RepositoryEntityNotFound)).toBe(true);
		}
	});

	test("many records load what they hold in one findIn, or one findOne for each id", async () => {
		const withIn = setup();
		const without = setup(false);
		for (const { Users, Posts, users } of [withIn, without]) {
			const a = await Users.create(person("Ana"));
			const b = await Users.create(person("Bia"));
			await Posts.create(postOf(a, { reviewers: [b] }));
			await Posts.create(postOf(b, { reviewers: [a, b] }));
			await Posts.create(postOf(a, { editor: b }));
			users.calls.length = 0;
			expect(await Posts.findManyByTitle("Title")).toHaveLength(3);
		}

		const [lookup] = withIn.users.calls;
		expect(withIn.users.calls).toHaveLength(1);
		expect(lookup?.method).toBe("findIn");
		expect(lookup?.value).toHaveLength(2);
		expect(without.users.calls.map((call) => call.method)).toEqual([
			"findOne",
			"findOne",
		]);
	});

	test("references chain through the repositories of the entities", async () => {
		class Org extends entityOf(blueprintOf((ctx) => ({ name: ctx.string }))) {}
		class Dept extends entityOf(
			blueprintOf((ctx) => ({ name: ctx.string, org: Org })),
		) {}
		class Task extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string, dept: Dept })),
		) {}
		// No repository here has findById; the relations load by their state.
		const Orgs = repositoryOf({ entity: Org, actions: ["create"] });
		const Depts = repositoryOf({
			entity: Dept,
			actions: ["create"],
			relations: [Orgs],
		});
		class DeptsRepository extends RepositoryOf(Depts) {}
		const Tasks = repositoryOf({
			entity: Task,
			actions: ["create", "findById"],
			relations: [new DeptsRepository()],
		});

		const org = await Orgs.create({ name: "Acme" });
		const dept = await Depts.create({ name: "Sales", org });
		const task = await Tasks.create({ title: "Call", dept });
		const found = await Tasks.findById(task.id);
		expect(found?.dept.name).toBe("Sales");
		expect(found?.dept.org.name).toBe("Acme");
		expect(found?.dept.org.id).toBe(org.id);
	});

	test("entities read as references do not emit onCreate again", async () => {
		const { Users, Posts } = setup();
		const author = await Users.create(person());
		const post = await Posts.create(postOf(author));
		const found = await Posts.findById(post.id);
		expect(found?.author.pullEvents()).toEqual([]);
		expect(found?.pullEvents()).toEqual([]);
	});

	test("in a use case, the events of an entity go up only through its own repository", async () => {
		const { Users, Posts } = setup();
		const author = person();
		const Output = blueprintOf(() => ({}));
		class StorePost extends useCaseOf({
			name: "StorePost",
			blueprint: blueprintOf(() => ({ post: Post })),
			response: Output,
			dependencies: { posts: Posts },
		}) {
			override async execute({ posts = this.dependencies.posts } = {}) {
				await posts.create(this.input.post);
				return {};
			}
		}
		class StoreUser extends useCaseOf({
			name: "StoreUser",
			blueprint: blueprintOf(() => ({ user: User })),
			response: Output,
			dependencies: { users: Users },
		}) {
			override async execute({ users = this.dependencies.users } = {}) {
				await users.create(this.input.user);
				return {};
			}
		}

		const storePost = new StorePost({ post: postOf(author) });
		await storePost.execute();
		expect(storePost.pullEvents()).toEqual([]);
		expect(author.pullEvents().map((event) => event.name)).toEqual([
			"user.created",
		]);

		const storeUser = new StoreUser({ user: person("Bia") });
		await storeUser.execute();
		expect(storeUser.pullEvents().map((event) => event.name)).toEqual([
			"user.created",
		]);
	});

	test("a use case does not take the events of an entity given to the repository of another", async () => {
		const { Posts } = setup();
		const author = person();
		const Output = blueprintOf(() => ({}));
		class FindPosts extends useCaseOf({
			name: "FindPosts",
			blueprint: blueprintOf(() => ({ author: User })),
			response: Output,
			dependencies: { posts: Posts },
		}) {
			override async execute({ posts = this.dependencies.posts } = {}) {
				await posts.findManyByAuthor(this.input.author);
				return {};
			}
		}

		const find = new FindPosts({ author });
		await find.execute();
		expect(find.pullEvents()).toEqual([]);
		expect(author.pullEvents().map((event) => event.name)).toEqual([
			"user.created",
		]);
	});

	test("a method of an extended repository giving back what its entity holds leaves the events of that to its own repository", async () => {
		const { Users, Posts } = setup();
		class Authors extends RepositoryOf(Posts) {
			async authorOf(id: string): Promise<User | undefined> {
				return (await this.findById(id))?.author;
			}
			// The author comes from the argument, so it still has its events.
			async authorOfNew(post: Post): Promise<User> {
				await this.create(post);
				return post.author;
			}
		}
		const authors = new Authors();
		const author = person();
		const stored = await authors.create(
			postOf(await Users.create(person("Bia"))),
		);
		const Output = blueprintOf(() => ({}));
		class Ask extends useCaseOf({
			name: "Ask",
			blueprint: blueprintOf((ctx) => ({ id: ctx.string, post: Post })),
			response: Output,
			dependencies: { authors },
		}) {
			override async execute({ authors = this.dependencies.authors } = {}) {
				await authors.authorOf(this.input.id);
				await authors.authorOfNew(this.input.post);
				return {};
			}
		}

		const post = postOf(author, { title: "New" });
		const ask = new Ask({ id: stored.id, post });
		await ask.execute();
		expect(ask.pullEvents()).toEqual([]);
		expect(post.author.pullEvents().map((event) => event.name)).toEqual([
			"user.created",
		]);
	});

	test("the in-memory provider finds the values of a list of keys", async () => {
		const provider = inMemoryProvider();
		const context: RepositoryContext = {
			entity: User,
			name: "UserRepository",
			unique: ["id"],
			env: undefined,
		};
		for (const id of ["a", "b", "c"]) {
			await provider.insert(context, { id, name: id });
		}
		expect(provider.findIn).toBeFunction();
		const found = await provider.findIn?.(context, "id", ["c", "a", "x"]);
		expect(found?.map((data) => data.id).sort()).toEqual(["a", "c"]);
		expect(await provider.findIn?.(context, "id", [])).toEqual([]);
	});
});
