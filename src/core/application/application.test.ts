import { describe, expect, expectTypeOf, test } from "bun:test";
import { Type } from "typebox";
import {
	ApplicationConflict,
	applicationOf,
	blueprintOf,
	DuplicateApplicationDeclaration,
	Email,
	entityOf,
	enumOf,
	environmentOf,
	Integer,
	InvalidApplicationDeclaration,
	inMemoryProvider,
	isApplication,
	listOf,
	optionalOf,
	propertyLineageOf,
	propertyOf,
	recordOf,
	repositoryOf,
	UnregisteredApplicationReference,
	UnregisteredRepositoryDependency,
} from "../../index";

const Age = Integer.with({ min: 0, max: 150, description: "In years" });
const Status = enumOf(["draft", "published"]);
const Address = blueprintOf((ctx) => ({
	street: ctx.string,
	zip: ctx.string({ pattern: /^\d{5}$/ }),
}));
class User extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.text,
		email: ctx.email,
		slug: ctx.slug,
		password: ctx.password,
		age: optionalOf(Age),
		address: Address,
		tags: listOf(ctx.string, { maxItems: 5 }),
	})),
	{
		unique: ["email"],
		change: ["name"],
		sensitive: ["password"],
	},
) {}
class Post extends entityOf(
	blueprintOf((ctx) => ({
		title: ctx.text,
		status: Status,
		author: User,
		coauthors: listOf(User),
	})),
) {}
const Database = environmentOf(
	blueprintOf((ctx) => ({ DATABASE_URL: ctx.url, PORT: ctx.integer })),
	{ source: () => ({ DATABASE_URL: "http://db", PORT: "5432" }) },
);
const Users = repositoryOf({
	entity: User,
	actions: ["findById", "findByEmail", "create", "update"],
	environmentDependencies: Database,
});
const Posts = repositoryOf({
	entity: Post,
	actions: ["findById", "create"],
	relations: [Users],
});

const declare = () =>
	applicationOf({
		name: "blog",
		properties: { Age, Status },
		blueprints: { Address },
		entities: { User, Post },
		environments: { Database },
		repositories: { Users, Posts },
	});

// biome-ignore lint/suspicious/noExplicitAny: the description is read by path
type Loose = any;

const describeOf = (app: { describe(): unknown }): Loose => app.describe();

const code = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		return (error as Error).name;
	}
	return undefined;
};

describe("applicationOf", () => {
	test("registers declarations and keeps them by name", () => {
		const app = declare();
		expect(isApplication(app)).toBe(true);
		expect(Object.isFrozen(app)).toBe(true);
		expect(app.name).toBe("blog");
		expect(app.entities.User).toBe(User);
		expect(app.blueprints.Address).toBe(Address);
		expect(app.properties.Age).toBe(Age);
		expect(app.repositories.Users).toBe(Users);
		expectTypeOf(app.repositories.Users).toEqualTypeOf<typeof Users>();
		expectTypeOf(app.entities.Post).toEqualTypeOf<typeof Post>();
		expect(isApplication({})).toBe(false);
	});

	test("describes the graph", () => {
		const description = describeOf(declare());
		expect(JSON.parse(JSON.stringify(description))).toEqual(description);
		expect(description.extends).toEqual([]);
		expect(description.properties.Age).toMatchObject({
			from: "blog",
			name: "integer",
			optional: false,
			lineage: {
				kind: "refined",
				base: { name: "integer", schema: { type: "integer" } },
				options: { min: 0, max: 150, description: "In years" },
			},
			schema: { type: "integer", minimum: 0, maximum: 150 },
		});
		expect(description.properties.Status.lineage).toEqual({
			kind: "factory",
			factory: "enumOf",
			args: { values: ["draft", "published"] },
		});
		expect(description.blueprints.Address.fields.zip).toMatchObject({
			kind: "property",
			lineage: { kind: "refined", options: { pattern: "^\\d{5}$" } },
		});
		expect(description.entities.User).toMatchObject({
			from: "blog",
			options: { sensitive: [], unique: ["email"], change: ["name"] },
			plugins: [],
		});
		const fields = description.entities.User.fields;
		expect(Object.keys(fields)).toEqual([
			"name",
			"email",
			"slug",
			"password",
			"age",
			"address",
			"tags",
		]);
		expect(fields.email).toMatchObject({ kind: "property", name: "email" });
		expect(fields.password).toMatchObject({ sensitive: true });
		expect(fields.slug).toMatchObject({ unique: true });
		expect(fields.age).toMatchObject({
			kind: "property",
			optional: true,
			lineage: { kind: "optional", base: { ref: "Age" } },
		});
		expect(fields.address).toEqual({
			kind: "blueprint",
			ref: "Address",
			optional: false,
		});
		expect(fields.tags).toMatchObject({
			kind: "list",
			maxItems: 5,
			item: { kind: "property", name: "string" },
		});
		expect(description.entities.Post.fields).toMatchObject({
			status: { kind: "property", ref: "Status", optional: false },
			author: { kind: "entity", ref: "User", optional: false },
			coauthors: {
				kind: "list",
				item: { kind: "entity", ref: "User" },
			},
		});
		expect(description.environments.Database.fields.PORT).toMatchObject({
			name: "integer",
		});
		expect(description.repositories).toEqual({
			Users: {
				from: "blog",
				entity: "User",
				actions: ["findById", "findByEmail", "create", "update"],
				deletion: "hard",
				relations: [],
				environments: ["Database"],
			},
			Posts: {
				from: "blog",
				entity: "Post",
				actions: ["findById", "create"],
				deletion: "hard",
				relations: ["Users"],
				environments: [],
			},
		});
	});

	test("describes when the records of an entity expire", () => {
		class Audit extends entityOf(
			blueprintOf((ctx) => ({ action: ctx.string })),
			{ name: "Audit", expires: { after: { days: 400 } } },
		) {}
		class Window extends entityOf(
			blueprintOf((ctx) => ({ until: ctx.dateTime })),
			{ name: "Window", expires: { at: "until" } },
		) {}
		const description = describeOf(
			applicationOf({ name: "expiring", entities: { Audit, Window } }),
		);
		expect(description.entities.Audit.expires).toEqual({
			after: { days: 400 },
		});
		expect(Object.keys(description.entities.Audit.fields)).toEqual(["action"]);
		expect(description.entities.Window.expires).toEqual({ at: "until" });
		expect(Object.keys(description.entities.Window.fields)).toEqual(["until"]);
		expect(description.entities.User).toBeUndefined();
		expect(
			describeOf(applicationOf({ name: "plain", entities: { User } })).entities
				.User,
		).not.toHaveProperty("expires");
	});

	test("describes what cannot be recreated as an opaque property", () => {
		const Raw = propertyOf({
			name: "raw",
			schema: Type.String(),
			preHandle: (value) => value.trim(),
		});
		const Note = recordOf(blueprintOf(() => ({ body: Raw })));
		const app = applicationOf({ name: "notes", records: { Note } });
		expect(describeOf(app).records.Note.fields.body).toMatchObject({
			kind: "property",
			name: "raw",
			schema: { type: "string" },
		});
		expect(describeOf(app).records.Note.fields.body).not.toHaveProperty(
			"lineage",
		);
	});

	test("records the lineage of with, optionalOf and enumOf", () => {
		expect(propertyLineageOf(Email)).toBeUndefined();
		const lineage = propertyLineageOf(Age);
		expect(lineage).toMatchObject({
			kind: "refined",
			base: Integer,
			options: { min: 0, max: 150 },
		});
		expect(propertyLineageOf(optionalOf(Age))).toEqual({
			kind: "optional",
			base: Age,
		});
		expect(propertyLineageOf(Status)).toEqual({
			kind: "factory",
			factory: "enumOf",
			args: { values: ["draft", "published"] },
		});
		expect(
			propertyLineageOf(enumOf(["a"], { name: "kind", optional: true })),
		).toEqual({
			kind: "factory",
			factory: "enumOf",
			args: { values: ["a"], name: "kind", optional: true },
		});
	});

	describe("validation", () => {
		test("a declaration of the wrong kind", () => {
			expect(
				code(() =>
					applicationOf({ name: "x", entities: { User: Address } as never }),
				),
			).toBe(InvalidApplicationDeclaration.name);
			expect(
				code(() =>
					applicationOf({ name: "x", repositories: { Users: User } as never }),
				),
			).toBe("InvalidApplicationDeclaration");
			expect(code(() => applicationOf({ name: "" }))).toBe(
				"InvalidApplicationDeclaration",
			);
		});

		test("one object under two names", () => {
			expect(
				code(() =>
					applicationOf({
						name: "x",
						blueprints: { A: Address, B: Address },
					}),
				),
			).toBe(DuplicateApplicationDeclaration.name);
		});

		test("an entity held but not registered", () => {
			const error = (() => {
				try {
					applicationOf({ name: "x", entities: { Post } });
				} catch (e) {
					return e as Error & { details: { reference: string } };
				}
			})();
			expect(error?.name).toBe(UnregisteredApplicationReference.name);
			expect(error?.details.reference).toContain("User");
		});

		test("a record held by a registered blueprint, at any depth", () => {
			const Tag = recordOf(blueprintOf((ctx) => ({ label: ctx.string })));
			const Holder = blueprintOf(() => ({
				inner: blueprintOf(() => ({ tags: optionalOf(listOf(Tag)) })),
			}));
			expect(
				code(() => applicationOf({ name: "x", blueprints: { Holder } })),
			).toBe("UnregisteredApplicationReference");
			expect(
				code(() =>
					applicationOf({
						name: "x",
						blueprints: { Holder },
						records: { Tag },
					}),
				),
			).toBeUndefined();
		});

		test("a repository outside the application", () => {
			expect(
				code(() => applicationOf({ name: "x", repositories: { Users } })),
			).toBe(UnregisteredRepositoryDependency.name);
			expect(
				code(() =>
					applicationOf({
						name: "x",
						entities: { User, Post },
						environments: { Database },
						repositories: { Posts },
					}),
				),
			).toBe("UnregisteredRepositoryDependency");
			expect(
				code(() =>
					applicationOf({
						name: "x",
						entities: { User },
						repositories: { Users },
					}),
				),
			).toBe("UnregisteredRepositoryDependency");
		});
	});

	describe("composition", () => {
		const Auth = applicationOf({
			name: "auth",
			entities: { User },
			environments: { Database },
			repositories: { Users },
		});
		const Blog = applicationOf({
			name: "blog",
			extends: [Auth],
			properties: { Status },
			entities: { Post },
			repositories: { Posts },
		});

		test("inherits declarations and allows cross-app references", () => {
			expect(Blog.entities.User).toBe(User);
			expect(Blog.repositories.Posts).toBe(Posts);
			expectTypeOf(Blog.repositories.Users).toEqualTypeOf<typeof Users>();
			expectTypeOf(Blog.entities.Post).toEqualTypeOf<typeof Post>();
			expect(Blog.extends).toEqual([Auth]);
			const description = describeOf(Blog);
			expect(description.extends).toEqual(["auth"]);
			expect(description.entities.User.from).toBe("auth");
			expect(description.entities.Post.from).toBe("blog");
			expect(description.repositories.Users.from).toBe("auth");
			expect(description.entities.Post.fields.author).toMatchObject({
				kind: "entity",
				ref: "User",
			});
		});

		test("leaves the extended application alone", () => {
			expect(Object.keys(Auth.entities)).toEqual(["User"]);
			expect(Object.keys(describeOf(Auth).entities)).toEqual(["User"]);
		});

		test("deduplicates the same object under the same name", () => {
			const Twice = applicationOf({
				name: "twice",
				extends: [Auth, Blog],
				entities: { User },
			});
			expect(Object.keys(Twice.entities).sort()).toEqual(["Post", "User"]);
			expect(describeOf(Twice).entities.User.from).toBe("auth");
		});

		test("extend returns a new application", () => {
			const Standalone = applicationOf({
				name: "billing",
				entities: {
					Invoice: entityOf(blueprintOf((ctx) => ({ n: ctx.integer }))),
				},
			});
			const Both = Auth.extend(Standalone);
			expect(Both).not.toBe(Auth);
			expect(Both.name).toBe("auth");
			expect(Object.keys(Both.entities).sort()).toEqual(["Invoice", "User"]);
			expectTypeOf(Both.entities.User).toEqualTypeOf<typeof User>();
			expect(Object.keys(Auth.entities)).toEqual(["User"]);
			expect(describeOf(Both).entities.Invoice.from).toBe("billing");
		});

		test("the same name with different objects conflicts", () => {
			const Other = entityOf(blueprintOf((ctx) => ({ name: ctx.text })));
			const A = applicationOf({ name: "a", entities: { Thing: Other } });
			const B = applicationOf({
				name: "b",
				entities: { Thing: entityOf(blueprintOf((ctx) => ({ n: ctx.text }))) },
			});
			for (const make of [
				() => applicationOf({ name: "c", extends: [A, B] }),
				() => applicationOf({ name: "c", extends: [B, A] }),
				() => A.extend(B),
				() =>
					applicationOf({
						name: "c",
						extends: [A],
						entities: { Thing: B.entities.Thing },
					}),
			]) {
				try {
					make();
					throw new Error("should have thrown");
				} catch (error) {
					expect((error as Error).name).toBe(ApplicationConflict.name);
					const { origins } = (error as { details: { origins: string[] } })
						.details;
					expect(origins).toContain("a");
					expect(origins).toHaveLength(2);
				}
			}
		});

		test("one object under different names conflicts", () => {
			const A = applicationOf({ name: "a", blueprints: { Address } });
			const B = applicationOf({ name: "b", blueprints: { Location: Address } });
			expect(code(() => applicationOf({ name: "c", extends: [A, B] }))).toBe(
				"ApplicationConflict",
			);
		});

		test("validation runs on the resolved set", () => {
			expect(
				code(() =>
					applicationOf({ name: "x", entities: { Post }, extends: [Auth] }),
				),
			).toBeUndefined();
			expect(code(() => applicationOf({ name: "x", entities: { Post } }))).toBe(
				"UnregisteredApplicationReference",
			);
		});
	});

	describe("runtime scope", () => {
		const input = {
			name: "Ana",
			email: "ana@example.com",
			slug: "ana",
			password: "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNo",
			address: { street: "Rua A", zip: "12345" },
			tags: [],
		};
		const make = (
			name: string,
			provider?: ReturnType<typeof inMemoryProvider>,
		) =>
			applicationOf({
				name,
				entities: { User, Post },
				environments: { Database },
				repositories: { Users, Posts },
				...(provider ? { provider } : {}),
			});

		test("an app without a provider changes nothing", async () => {
			const app = make("plain");
			expect(app.repositories.Users).toBe(Users);
			expect(app.provider).toBeUndefined();
		});

		test("two apps with different providers do not share data", async () => {
			const one = make("one", inMemoryProvider());
			const two = make("two", inMemoryProvider());
			expect(one.repositories.Users).not.toBe(Users);
			expect(one.repositories.Users.actions).toEqual(Users.actions);
			expect(one.repository(Users)).toBe(one.repositories.Users);

			const ana = await one.repositories.Users.create(input);
			expect(await one.repositories.Users.findById(ana.id)).toBeDefined();
			expect(await two.repositories.Users.findById(ana.id)).toBeUndefined();
			expect(await Users.findById(ana.id)).toBeUndefined();

			const post = await one.repositories.Posts.create({
				title: "Hello",
				status: "draft",
				author: ana,
				coauthors: [],
			});
			const loaded = await one.repositories.Posts.findById(post.id);
			expect(loaded?.author.email).toBe("ana@example.com");
		});

		test("a repository with a provider of its own keeps it", async () => {
			const own = inMemoryProvider();
			const Pinned = repositoryOf({
				entity: User,
				actions: ["findById", "create"],
				provider: own,
				environmentDependencies: Database,
			});
			const app = applicationOf({
				name: "pinned",
				entities: { User },
				environments: { Database },
				repositories: { Pinned },
				provider: inMemoryProvider(),
			});
			expect(describeOf(app).repositories.Pinned.provider).toEqual({
				kind: "provider",
				name: "inMemory",
				options: {},
			});
			expect(describeOf(app).provider).toEqual({
				kind: "provider",
				name: "inMemory",
				options: {},
			});
			const anonymous = applicationOf({
				name: "anonymous",
				provider: { ...inMemoryProvider() },
			});
			expect(anonymous.describe().provider).toEqual({ kind: "opaque" });
			expect(applicationOf({ name: "none" }).describe()).not.toHaveProperty(
				"provider",
			);
			const ana = await app.repositories.Pinned.create(input);
			expect(await Pinned.findById(ana.id)).toBeDefined();
		});

		test("inherited repositories use the provider of the final app", async () => {
			const Auth = applicationOf({
				name: "auth",
				entities: { User },
				environments: { Database },
				repositories: { Users },
			});
			const provider = inMemoryProvider();
			const App = applicationOf({ name: "app", extends: [Auth], provider });
			const ana = await App.repositories.Users.create(input);
			expect(await Auth.repositories.Users.findById(ana.id)).toBeUndefined();
			expect(App.extend(Auth).provider).toBe(provider);
		});

		test("rejects a repository that is not registered", () => {
			expect(() =>
				make("x", inMemoryProvider()).repository({} as never),
			).toThrow();
		});
	});
});
