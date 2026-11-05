import { describe, expect, expectTypeOf, test } from "bun:test";
import { blueprintOf } from "../../std/blueprint";
import { entityOf } from "../../std/entity";
import { Password } from "../../std/properties/password";
import { listOf } from "../blueprint/list";
import { optionalOf } from "../blueprint/optional";
import { ExceptionLayers } from "../exception/enums/exception-layers";
import { Exception } from "../exception/exception";
import { ReservedRecordKey } from "../record/exceptions";
import { MASK } from "../record/mask";
import { recordOf } from "../record/record";
import type { RecordValue } from "../record/types/record.interface";
import { AbstractEntity } from "./abstract-entity";
import { isEntity, isEntityClass } from "./entity";
import {
	DeletedEntity,
	ImmutableEntityKey,
	ReservedEntityKey,
} from "./exceptions";

const UUID_V7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = "01a173d2-051c-77bb-8166-a371e999573e";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

class Address extends recordOf(
	blueprintOf((ctx) => ({ street: ctx.string, zip: ctx.string })),
) {}

const UserBlueprint = blueprintOf((ctx) => ({
	name: ctx.string,
	nickname: ctx.optional.string,
	address: Address,
}));

/** An entity of `UserBlueprint` that exposes the protected `set`. */
class User extends entityOf(UserBlueprint, { change: ["name"] }) {
	update<Key extends keyof RecordValue<User>>(
		key: Key,
		value: RecordValue<User>[Key],
	): this {
		return this.set(key, value);
	}
}

const jane = { name: "Jane", address: { street: "Main St", zip: "01310-100" } };

function raise(run: () => unknown): Exception {
	try {
		run();
	} catch (error) {
		if (error instanceof Exception) return error;
		throw error;
	}
	throw new Error("expected an exception");
}

describe("identity", () => {
	test("makes an id and a createdAt when the value has none", () => {
		const before = Date.now();
		const user = new User(jane);

		expect(user.id).toMatch(UUID_V7);
		expect(Date.parse(user.createdAt)).toBeGreaterThanOrEqual(before);
		expect(Date.parse(user.createdAt)).toBeLessThanOrEqual(Date.now());
		expect(user.updatedAt).toBeUndefined();
		expect(user.deletedAt).toBeUndefined();
		expect(user.isDeleted).toBe(false);
		expect(user.name).toBe("Jane");
		expect(user.address).toBeInstanceOf(Address);
	});

	test("each entity gets its own id", () => {
		expect(new User(jane).id).not.toBe(new User(jane).id);
	});

	test("keeps the identity of the value, as loaded from a database", () => {
		const user = new User({
			...jane,
			id: ID,
			createdAt: CREATED_AT,
			updatedAt: "2026-01-02T00:00:00.000Z",
			deletedAt: "2026-01-03T00:00:00.000Z",
		});

		expect(user.id).toBe(ID);
		expect(user.createdAt).toBe(CREATED_AT);
		expect(user.updatedAt).toBe("2026-01-02T00:00:00.000Z");
		expect(user.deletedAt).toBe("2026-01-03T00:00:00.000Z");
		expect(user.isDeleted).toBe(true);
	});

	test("rejects an invalid identity", () => {
		const exception = raise(() => new User({ ...jane, id: "not-an-id" }));

		expect(exception.layer).toBe(ExceptionLayers.Record);
		expect(exception.details).toMatchObject({ key: "id" });
		expect(
			User.safeParse({ ...jane, createdAt: "yesterday" }).issues?.[0]?.path,
		).toEqual(["createdAt"]);
	});

	test("lists id in options.unique, before the keys it is given", () => {
		class Account extends entityOf(
			blueprintOf((ctx) => ({ email: ctx.email })),
			{ unique: ["email"] },
		) {}

		expect(User.options.unique).toEqual(["id"]);
		expect(Account.options.unique).toEqual(["id", "email"]);
	});

	test("the blueprint holds the identity, then the keys of the entity", () => {
		expect(Object.keys(User.blueprint.properties)).toEqual([
			"id",
			"createdAt",
			"updatedAt",
			"deletedAt",
			"name",
			"nickname",
			"address",
		]);
	});
});

describe("changes", () => {
	test("each change sets updatedAt to now", async () => {
		const user = new User(jane);

		user.change.name("Ann");
		const first = user.updatedAt;
		expect(first).toBeDefined();
		expect(user.name).toBe("Ann");

		await Bun.sleep(2);
		user.update("nickname", "an");
		expect(user.updatedAt).toBeDefined();
		expect(Date.parse(user.updatedAt as string)).toBeGreaterThan(
			Date.parse(first as string),
		);
	});

	test("an invalid change sets nothing", () => {
		const user = new User(jane);

		expect(() => user.update("name", 1 as never)).toThrow();
		expect(user.name).toBe("Jane");
		expect(user.updatedAt).toBeUndefined();
	});

	test("the effects of a change see its updatedAt", () => {
		const seen: unknown[] = [];
		class Watched extends entityOf(UserBlueprint, { change: ["name"] }) {
			protected override onSetAll(): void {
				seen.push(this.updatedAt);
			}
			protected override onSet() {
				return { name: () => seen.push(this.updatedAt) };
			}
		}

		const user = new Watched(jane).change.name("Ann");
		expect(seen).toEqual([user.updatedAt, user.updatedAt]);
		expect(user.updatedAt).toBeDefined();
	});

	test("the identity cannot be changed", () => {
		const user = new User(jane);

		for (const key of ["id", "createdAt", "updatedAt", "deletedAt"] as const) {
			const exception = raise(() => user.update(key, CREATED_AT));
			expect(exception).toBeInstanceOf(ImmutableEntityKey);
			expect(exception.layer).toBe(ExceptionLayers.Entity);
			expect(exception.details).toEqual({ key });
		}
		expect(user.updatedAt).toBeUndefined();
	});
});

describe("destroy", () => {
	test("sets deletedAt, runs onDestroy, and blocks any change after", () => {
		let destroyed = 0;
		class Tracked extends entityOf(UserBlueprint, { change: ["name"] }) {
			protected override onDestroy(): void {
				destroyed++;
			}
		}
		const user = new Tracked(jane);

		expect(user.destroy()).toBe(user);
		expect(user.deletedAt).toBeDefined();
		expect(user.isDeleted).toBe(true);
		expect(user.updatedAt).toBeUndefined();
		expect(destroyed).toBe(1);

		const exception = raise(() => user.change.name("Ann"));
		expect(exception).toBeInstanceOf(DeletedEntity);
		expect(exception.layer).toBe(ExceptionLayers.Entity);
		expect(exception.details).toEqual({ id: user.id });
		expect(raise(() => user.destroy())).toBeInstanceOf(DeletedEntity);
		expect(user.name).toBe("Jane");
		expect(destroyed).toBe(1);
	});

	test("an entity loaded destroyed cannot change", () => {
		const user = new User({ ...jane, deletedAt: CREATED_AT });

		expect(raise(() => user.change.name("Ann"))).toBeInstanceOf(DeletedEntity);
	});
});

describe("declaration", () => {
	test("the blueprint cannot declare the identity nor a member of the entity", () => {
		for (const key of [
			"id",
			"createdAt",
			"updatedAt",
			"deletedAt",
			"destroy",
			"isDeleted",
			"equals",
			"onDestroy",
		]) {
			const blueprint = blueprintOf((ctx) => ({ [key]: ctx.string }));
			const exception = raise(() => entityOf(blueprint as never));
			expect(exception).toBeInstanceOf(ReservedEntityKey);
			expect(exception.details).toEqual({ key });
		}
	});

	test("nor the members of a record", () => {
		const blueprint = blueprintOf((ctx) => ({ toJSON: ctx.string }));
		expect(raise(() => entityOf(blueprint))).toBeInstanceOf(ReservedRecordKey);
	});

	test("change cannot list a key of the identity", () => {
		expect(
			raise(() => entityOf(UserBlueprint, { change: ["id" as never] })),
		).toBeInstanceOf(ImmutableEntityKey);
	});

	test("is a record class, told apart from a plain record", () => {
		expect(User.name).toBe("User");
		expect(Object.getPrototypeOf(User).name).toBe("entity");
		expect(isEntityClass(User)).toBe(true);
		expect(isEntityClass(Address)).toBe(false);
		expect(isEntityClass({})).toBe(false);
		expect(isEntity(new User(jane))).toBe(true);
		expect(isEntity(new Address(jane.address))).toBe(false);
		expect(new User(jane)).toBeInstanceOf(AbstractEntity);
	});
});

describe("composition", () => {
	class Post extends entityOf(
		blueprintOf((ctx) => ({
			title: ctx.string,
			author: User,
			reviewer: optionalOf(User),
			coauthors: listOf(User),
		})),
	) {}

	class Feed extends recordOf(
		blueprintOf(() => ({ pinned: Post, posts: listOf(Post) })),
	) {}

	test("an entity is a field of another entity, optional or in a list", () => {
		const author = new User(jane);
		const post = new Post({
			title: "Hello",
			author,
			coauthors: [{ name: "Ann", address: jane.address }],
		});

		expect(post.author).toBe(author);
		expect(post.reviewer).toBeUndefined();
		expect(post.coauthors[0]).toBeInstanceOf(User);
		expect(post.coauthors[0]?.id).toMatch(UUID_V7);
		expect(post.coauthors[0]?.id).not.toBe(author.id);
	});

	test("an entity is a field of a record", () => {
		const post = { title: "Hello", author: jane, coauthors: [] };
		const feed = new Feed({ pinned: post, posts: [post, post] });

		expect(feed.pinned).toBeInstanceOf(Post);
		expect(feed.pinned.author).toBeInstanceOf(User);
		expect(feed.posts.map((item) => item.id)).toHaveLength(2);
		expect(feed.posts[0]?.id).not.toBe(feed.posts[1]?.id);
	});

	test("keeps the identity of a nested value", () => {
		const post = new Post({
			title: "Hello",
			author: { ...jane, id: ID, createdAt: CREATED_AT },
			coauthors: [],
		});

		expect(post.author.id).toBe(ID);
		expect(post.author.createdAt).toBe(CREATED_AT);
	});

	test("names the path of a nested issue", () => {
		const result = Post.safeParse({
			title: "Hello",
			author: jane,
			coauthors: [{ ...jane, id: "bad" }],
		});

		expect(result.issues?.[0]?.path).toEqual(["coauthors", 0, "id"]);
		expect(
			raise(
				() =>
					new Post({
						title: "Hello",
						author: { ...jane, address: { street: "x" } } as never,
						coauthors: [],
					}),
			).details,
		).toMatchObject({ key: "author.address.zip" });
	});

	test("toJSON gives the identity, and of nested entities", () => {
		const author = new User({ ...jane, id: ID, createdAt: CREATED_AT });
		const post = new Post({ title: "Hello", author, coauthors: [] });

		expect(post.toJSON()).toEqual({
			id: post.id,
			createdAt: post.createdAt,
			title: "Hello",
			author: { id: ID, createdAt: CREATED_AT, ...jane },
			coauthors: [],
		});
	});
});

describe("record features", () => {
	test("safeParse and ~standard give an entity, or the issues", async () => {
		const parsed = User.safeParse(jane);
		if (parsed.issues) throw new Error("expected an entity");
		expect(parsed.value).toBeInstanceOf(User);
		expect(parsed.value.id).toMatch(UUID_V7);

		const user = new User(jane);
		expect(User.safeParse(user)).toEqual({ value: user });
		expect(User.safeParse("jane").issues).toBeDefined();

		const validated = await User["~standard"].validate(jane);
		expect("value" in validated && validated.value).toBeInstanceOf(User);
	});

	test("masks the sensitive keys", async () => {
		class Account extends entityOf(
			blueprintOf((ctx) => ({ email: ctx.email, password: ctx.password })),
		) {}
		const account = new Account({
			email: "jane@example.com",
			password: (await Password.hash("Str0ng!Pass")).value,
		});

		expect(account.toJSON()).toMatchObject({
			id: account.id,
			email: "jane@example.com",
			password: MASK,
		});
	});

	test("equals an entity of the same declaration and id", () => {
		const user = new User({ ...jane, id: ID });
		const other = entityOf(UserBlueprint);

		expect(user.equals(new User({ ...jane, name: "Ann", id: ID }))).toBe(true);
		expect(user.equals(new User(jane))).toBe(false);
		expect(user.equals(new other({ ...jane, id: ID }))).toBe(false);
		expect(user.equals({ id: ID })).toBe(false);
	});
});

test("types", () => {
	const user = new User(jane);

	expectTypeOf(user.id).toEqualTypeOf<string>();
	expectTypeOf(user.createdAt).toEqualTypeOf<string>();
	expectTypeOf(user.updatedAt).toEqualTypeOf<string | undefined>();
	expectTypeOf(user.deletedAt).toEqualTypeOf<string | undefined>();
	expectTypeOf(user.isDeleted).toEqualTypeOf<boolean>();
	expectTypeOf(user.change.name("Ann")).toEqualTypeOf<User>();
	expectTypeOf(user.destroy()).toEqualTypeOf<User>();

	class Post extends entityOf(
		blueprintOf(() => ({ author: User, coauthors: listOf(User) })),
	) {}
	new Post({ author: jane, coauthors: [user, { ...jane, id: ID }] });

	() => {
		// @ts-expect-error the identity keys get no change method
		user.change.id(ID);
		// @ts-expect-error the keys are read-only
		user.id = ID;
		// @ts-expect-error a key of the identity cannot be declared
		entityOf(blueprintOf((ctx) => ({ id: ctx.string })));
		// @ts-expect-error change takes only the keys of the blueprint
		entityOf(UserBlueprint, { change: ["createdAt"] });
		// @ts-expect-error a nested entity still needs its own keys
		new Post({ author: { id: ID }, coauthors: [] });
	};
});
