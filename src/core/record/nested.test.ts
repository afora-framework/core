import { expect, expectTypeOf, test } from "bun:test";
import { blueprintOf } from "../../std/blueprint";
import { Password } from "../../std/properties/password";
import { listOf } from "../blueprint/list";
import { optionalOf } from "../blueprint/optional";
import {
	isOptionalRecord,
	isRecordClass,
	recordFieldOf,
} from "../blueprint/record-field";
import type {
	BlueprintData,
	BlueprintInput,
	BlueprintValue,
} from "../blueprint/types/blueprint.interface";
import { Exception } from "../exception/exception";
import { InvalidRecordValue } from "./exceptions";
import { MASK } from "./mask";
import { recordOf } from "./record";

class User extends recordOf(
	blueprintOf((ctx) => ({
		name: ctx.text,
		password: ctx.password,
	})),
	{ change: ["name"] },
) {}

class Tag extends recordOf(blueprintOf((ctx) => ({ label: ctx.string }))) {}

const PostBlueprint = blueprintOf((ctx) => ({
	title: ctx.text,
	author: User,
	reviewer: optionalOf(User),
	tags: listOf(Tag),
}));

class Post extends recordOf(PostBlueprint, { change: ["author"] }) {}

const password = Password.demo().value;
const jane = new User({ name: "Jane", password });
const tag = new Tag({ label: "news" });

function raise(run: () => unknown): Exception {
	try {
		run();
	} catch (error) {
		if (error instanceof Exception) return error;
		throw error;
	}
	throw new Error("expected an exception");
}

test("a record class is a field of a blueprint", () => {
	expect(isRecordClass(User)).toBe(true);
	expect(isRecordClass(jane)).toBe(false);
	expect(isOptionalRecord(optionalOf(User))).toBe(true);
	expect(optionalOf(User)).toBe(optionalOf(User));
	expect(optionalOf(optionalOf(User))).toBe(optionalOf(User));
	expect(recordFieldOf(User)).toEqual({ record: User, optional: false });
	expect(recordFieldOf(optionalOf(User))).toMatchObject({
		record: User,
		optional: true,
	});
	expect(recordFieldOf(PostBlueprint)).toBeUndefined();
	expect(PostBlueprint.properties.author).toBe(User);
});

test("the blueprint takes the record's type: an instance as value, its blueprint as schema", () => {
	type Value = BlueprintValue<typeof PostBlueprint.properties>;
	expectTypeOf<Value>().toEqualTypeOf<{
		title: string;
		author: User;
		reviewer?: User;
		tags: Tag[];
	}>();
	expectTypeOf<BlueprintData<typeof PostBlueprint.properties>>().toEqualTypeOf<{
		title: string;
		author: { name: string; password: string };
		reviewer?: { name: string; password: string };
		tags: { label: string }[];
	}>();

	const data = {
		title: "Hello",
		author: { name: "Jane", password },
		tags: [{ label: "news" }],
	};
	expect(PostBlueprint.schema.match(data)).toBe(true);
	expect(
		PostBlueprint.schema.match({ ...data, author: { name: "Jane" } }),
	).toBe(false);
});

test("a record whose blueprint has a record takes an instance of it", () => {
	const post = new Post({ title: "Hello", author: jane, tags: [tag] });

	expectTypeOf<ConstructorParameters<typeof Post>>().toEqualTypeOf<
		[BlueprintInput<(typeof PostBlueprint)["properties"]>]
	>();
	expectTypeOf(post.author).toEqualTypeOf<User>();
	expectTypeOf(post.reviewer).toEqualTypeOf<User | undefined>();
	expect(post.author).toBe(jane);
	expect(post.reviewer).toBeUndefined();
	expect(post.tags[0]).toBe(tag);
	expect(post.author.name).toBe("Jane");

	() => {
		// @ts-expect-error `author` takes an instance of `User`, or an object that is a valid one
		new Post({ title: "Hello", author: { name: 1, password }, tags: [] });
		// @ts-expect-error `author` is required
		new Post({ title: "Hello", tags: [] });
		// @ts-expect-error a `Tag` is not a `User`
		new Post({ title: "Hello", author: tag, tags: [] });
	};
});

test("anything but an instance of the record, or its plain input, is rejected, at any depth", () => {
	const plain = raise(
		() =>
			new Post({
				title: "Hello",
				author: "Jane" as never,
				tags: [],
			}),
	);
	expect(plain).toBeInstanceOf(InvalidRecordValue);
	expect(plain.source).toBe("Post");
	expect(plain.details).toEqual({
		key: "author",
		errors: ['must be an instance of record "User"'],
	});

	expect(
		raise(
			() => new Post({ title: "Hello", author: jane, tags: [jane as never] }),
		).details,
	).toEqual({
		key: "tags.0",
		errors: ['must be an instance of record "Tag"'],
	});
	expect(
		raise(
			() => new Post({ title: "Hello", author: undefined as never, tags: [] }),
		).details,
	).toEqual({ key: "author", errors: ["is required"] });
});

test("a subclass of the record is accepted, as `instanceof` is", () => {
	class Admin extends User {}
	const admin = new Admin({ name: "Root", password });

	expect(new Post({ title: "Hello", author: admin, tags: [] }).author).toBe(
		admin,
	);
});

test("set and change.<key> take an instance of the record", () => {
	const post = new Post({ title: "Hello", author: jane, tags: [] });
	const ann = new User({ name: "Ann", password });

	expect(post.change.author(ann).author).toBe(ann);
	expect(() => post.change.author("Bob" as never)).toThrow(
		'must be an instance of record "User"',
	);
	expect(post.author).toBe(ann);
});

test("toJSON gives each nested record's toJSON, masked by its own options", () => {
	const post = new Post({
		title: "Hello",
		author: jane,
		reviewer: jane,
		tags: [tag],
	});

	expect(JSON.parse(JSON.stringify(post))).toEqual({
		title: "Hello",
		author: { name: "Jane", password: MASK },
		reviewer: { name: "Jane", password: MASK },
		tags: [{ label: "news" }],
	});

	const Hidden = recordOf(PostBlueprint, { sensitive: ["author"] });
	expect(
		new Hidden({ title: "Hello", author: jane, tags: [] }).toJSON().author,
	).toEqual({ name: MASK, password: MASK });
});

test("a sensitive key masks the records it holds by their keys, in lists and blueprints", () => {
	const masked = { name: MASK, password: MASK };

	const Team = recordOf(
		blueprintOf(() => ({ members: listOf(User) })),
		{ sensitive: ["members"] },
	);
	expect(new Team({ members: [jane] }).toJSON()).toEqual({
		members: [masked],
	});

	const Box = blueprintOf(() => ({ owner: User, tags: listOf(Tag) }));
	const Hidden = recordOf(
		blueprintOf(() => ({ box: Box })),
		{ sensitive: ["box"] },
	);
	expect(new Hidden({ box: { owner: jane, tags: [tag] } }).toJSON()).toEqual({
		box: { owner: masked, tags: [{ label: MASK }] },
	});

	const Shown = recordOf(blueprintOf(() => ({ box: Box })));
	expect(new Shown({ box: { owner: jane, tags: [tag] } }).toJSON()).toEqual({
		box: { owner: { name: "Jane", password: MASK }, tags: [{ label: "news" }] },
	});
});
