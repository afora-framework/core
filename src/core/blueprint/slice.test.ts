import { expect, expectTypeOf, test } from "bun:test";
import { blueprintOf } from "../../std/blueprint";
import { entityOf } from "../../std/entity";
import { toOpenAPI } from "../openapi/openapi";
import { MASK } from "../record/mask";
import { recordOf } from "../record/record";
import { listOf } from "./list";
import { optionalOf } from "./optional";
import { sliceOf, sliceValue } from "./slice";
import type { BlueprintData } from "./types/blueprint.interface";

const Address = blueprintOf((ctx) => ({
	city: ctx.string,
	street: ctx.string,
}));
class Tag extends recordOf(
	blueprintOf((ctx) => ({ label: ctx.string, color: ctx.string })),
) {}
class User extends recordOf(
	blueprintOf((ctx) => ({ name: ctx.text, nick: ctx.string })),
	{ sensitive: ["nick"] },
) {}

const Person = blueprintOf((ctx) => ({
	name: ctx.text,
	age: ctx.optional.string,
	address: Address,
	places: listOf(Address),
	maybe: optionalOf(Address),
	tag: Tag,
	tags: listOf(Tag),
	author: User,
}));

test("sliceOf keeps the keys of a mask, recursively", () => {
	const Sliced = sliceOf(Person, {
		name: true,
		address: { city: true },
		places: { street: true },
		maybe: { city: true },
		tags: { label: true },
	});
	expect(Object.keys(Sliced.properties)).toEqual([
		"name",
		"address",
		"places",
		"maybe",
		"tags",
	]);
	expect(
		Sliced.safeParse({
			name: "Jane Doe",
			address: { city: "X" },
			places: [{ street: "S" }],
			tags: [{ label: "a" }],
		}),
	).toHaveProperty("value");
	expect(
		Sliced.safeParse({
			name: "Jane Doe",
			address: { street: "x" },
			places: [],
			tags: [],
		}),
	).toHaveProperty("issues");
	expect(Sliced.properties.maybe.optional).toBe(true);
	expect(Sliced.properties.places.optional).toBe(false);
	expectTypeOf<
		BlueprintData<typeof Sliced.properties>["address"]
	>().toEqualTypeOf<{
		city: string;
	}>();
});

test("sliceOf takes a blueprint or a record class as selector", () => {
	const Selector = blueprintOf((ctx) => ({
		name: ctx.text,
		address: blueprintOf((c) => ({ city: c.string })),
	}));
	const Sliced = sliceOf(Person, Selector);
	expect(Object.keys(Sliced.properties)).toEqual(["name", "address"]);
	expect(Object.keys(Sliced.properties.address.properties)).toEqual(["city"]);
	class City extends recordOf(blueprintOf((ctx) => ({ city: ctx.string }))) {}
	const ByRecord = sliceOf(Address, City);
	expect(Object.keys(ByRecord.properties)).toEqual(["city"]);
});

test("sliceOf rejects keys the blueprint does not have", () => {
	// @ts-expect-error unknown key
	expect(() => sliceOf(Person, { nope: true })).toThrow();
	// @ts-expect-error unknown nested key
	expect(() => sliceOf(Person, { address: { nope: true } })).toThrow();
	// @ts-expect-error a property has no keys
	expect(() => sliceOf(Person, { name: { nope: true } })).toThrow();
});

test("sliceValue strips keys, through lists and records", () => {
	const user = new User({ name: "Jane Doe", nick: "secret-nick" });
	const out = sliceValue(
		{
			name: "n",
			extra: 1,
			places: [
				{ city: "a", street: "b" },
				{ city: "c", street: "d" },
			],
			author: user,
		},
		{ name: true, places: { city: true }, author: { name: true, nick: true } },
	);
	expect(out.name).toBe("n");
	expect(out.places).toEqual([{ city: "a" }, { city: "c" }]);
	expect(out.author.nick).not.toBe("secret-nick");
	expect("extra" in out).toBe(false);
	expectTypeOf(out.places).toEqualTypeOf<{ city: string }[]>();
	expect(sliceValue(user, User) as object).toEqual(user.toJSON());
	expect(sliceValue({ a: 1, b: 2 }, { a: true, z: true })).toEqual({ a: 1 });
});

const Author = class Author extends recordOf(
	blueprintOf((ctx) => ({ name: ctx.text, secret: ctx.string })),
	{ sensitive: ["secret"], unique: ["name"], change: ["name", "secret"] },
) {};
const Post = blueprintOf((ctx) => ({ title: ctx.text, author: Author }));
const authorValue = { name: "Jane Doe", secret: "s3cret" };

test("a sub-sliced record field stays a record with its flags", () => {
	const Sliced = sliceOf(Post, { author: { name: true, secret: true } });
	const Field = Sliced.properties.author;
	expect(Field.options.sensitive).toEqual(["secret"]);
	expect(Field.options.unique).toEqual(["name"]);
	expect(Field.options.change).toEqual(["name", "secret"]);
	const sliced = new (recordOf(Sliced))({ author: authorValue });
	expect(sliced.toJSON().author).toEqual({ name: "Jane Doe", secret: MASK });

	const OnlyName = sliceOf(Post, { author: { name: true } });
	expect(OnlyName.properties.author.options).toEqual({
		sensitive: [],
		unique: ["name"],
		change: ["name"],
	});
	const schema = toOpenAPI(Sliced) as {
		properties: { author: { properties: { secret: { writeOnly?: boolean } } } };
	};
	expect(schema.properties.author.properties.secret.writeOnly).toBe(true);
});

test("a sliced record field accepts an instance of the original record", () => {
	const Card = recordOf(sliceOf(Post, { author: { name: true } }));
	const author = new Author(authorValue);
	const card = new Card({ author });
	expect(card.author as object).toBe(author);
	expect(JSON.parse(JSON.stringify(card)).author).toEqual({
		name: "Jane Doe",
		secret: MASK,
	});
	expect(() => new Card({ author: { name: "Jane Doe" } })).not.toThrow();
	expect(() => new Card({ author: { secret: "x" } as never })).toThrow();
});

test("slicing a blueprint by itself keeps it equivalent, records whole", () => {
	const Same = sliceOf(Post, Post);
	expect(Object.keys(Same.properties)).toEqual(["title", "author"]);
	expect(Same.properties.author).toBe(Author);
	const person = sliceOf(Person, Person);
	expect(person.properties.tag).toBe(Tag);
	expect(person.properties.tags.item).toBe(Tag);
	expect(person.properties.address).toBe(Address);
	expect(person.properties.maybe).toBe(Person.properties.maybe);
	expect(
		new (recordOf(Same))({ title: "Hello", author: authorValue }).toJSON(),
	).toEqual({ title: "Hello", author: { name: "Jane Doe", secret: MASK } });
	expect(toOpenAPI(Same)).toEqual(toOpenAPI(Post));
});

test("a record selected whole by a record selector keeps its class", () => {
	class Card extends recordOf(
		blueprintOf((ctx) => ({ title: ctx.text, author: Author })),
	) {}
	const Sliced = sliceOf(Post, Card);
	expect(Sliced.properties.author).toBe(Author);
});

const Account = entityOf(
	blueprintOf((ctx) => ({ email: ctx.string, token: ctx.string })),
	{ sensitive: ["token"], unique: ["email"] },
);
const Session = blueprintOf((ctx) => ({ label: ctx.text, account: Account }));

test("a sliced entity keeps its identity keys only if named", () => {
	const Without = sliceOf(Session, { account: { email: true, token: true } });
	const Field = Without.properties.account;
	expect(Object.keys(Field.blueprint.properties)).toEqual(["email", "token"]);
	expect(Field.options.unique).toEqual(["email"]);
	expect(Field.options.sensitive).toEqual(["token"]);
	const sliced = new (recordOf(Without))({
		account: { email: "a@b.co", token: "t" },
	});
	expect(sliced.toJSON().account).toEqual({ email: "a@b.co", token: MASK });

	const With = sliceOf(Session, { account: { id: true, email: true } });
	expect(Object.keys(With.properties.account.blueprint.properties)).toEqual([
		"id",
		"email",
	]);
	expect(With.properties.account.options.unique).toEqual(["id", "email"]);
	const account = new Account({ email: "a@b.co", token: "t" });
	expect(new (recordOf(With))({ account }).account as object).toBe(account);
	expect(With.properties.account.safeParse({ email: "a@b.co" })).toHaveProperty(
		"issues",
	);
});

test("sliceValue keeps required keys required, optional ones optional", () => {
	const Profile = recordOf(
		blueprintOf((ctx) => ({ name: ctx.text, nick: ctx.optional.string })),
	);
	const profile = new Profile({ name: "Jane Doe" });
	const out = sliceValue(profile, { name: true, nick: true });
	expectTypeOf(out).toEqualTypeOf<{ name: string; nick?: string }>();
	expect(out).toEqual({ name: "Jane Doe" });

	const account = new Account({ email: "a@b.co", token: "t" });
	const entity = sliceValue(account, { id: true, email: true });
	expectTypeOf(entity).toEqualTypeOf<{ id: string; email: string }>();
	expect(Object.keys(entity)).toEqual(["id", "email"]);

	const list = sliceValue([profile], { name: true, nick: true });
	expectTypeOf(list).toEqualTypeOf<{ name: string; nick?: string }[]>();
});
