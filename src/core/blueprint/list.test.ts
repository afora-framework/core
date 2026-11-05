import { expect, expectTypeOf, test } from "bun:test";
import { blueprintOf } from "../../std/blueprint";
import { Std } from "../../std/blueprint-plugin";
import { blueprintPluginOf } from "./blueprint-plugin";
import { UndeclaredBlueprintProperty } from "./exceptions";
import { isBlueprint } from "./is-blueprint";
import { isBlueprintList, listOf } from "./list";
import { optionalOf } from "./optional";
import type { BlueprintValue } from "./types/blueprint.interface";

const Address = blueprintOf((ctx) => ({
	street: ctx.string,
	number: ctx.integer,
}));
const address = { street: "Main St", number: 10 };

test("a list of blueprints is an array of nested objects", () => {
	const User = blueprintOf((ctx) => ({
		name: ctx.string,
		addresses: listOf(Address),
	}));

	expect(User.schema.match({ name: "Jane", addresses: [] })).toBe(true);
	expect(User.schema.match({ name: "Jane", addresses: [address] })).toBe(true);
	expect(
		User.schema.match({ name: "Jane", addresses: [{ street: "Main St" }] }),
	).toBe(false);
	expect(User.schema.match({ name: "Jane", addresses: address })).toBe(false);
	expect(User.schema.match({ name: "Jane" })).toBe(false);
	expect(
		User.schema.errors({ name: "Jane", addresses: [address, {}] }).join(),
	).toContain("/addresses/1");

	expectTypeOf<BlueprintValue<typeof User.properties>>().toEqualTypeOf<{
		name: string;
		addresses: { street: string; number: number }[];
	}>();
});

test("a list of properties validates each item", () => {
	const Post = blueprintOf((ctx) => ({
		tags: listOf(ctx.string),
		ids: listOf(ctx.id),
	}));

	expect(Post.schema.match({ tags: ["a", "b"], ids: [] })).toBe(true);
	expect(Post.schema.match({ tags: [1], ids: [] })).toBe(false);
	expect(Post.schema.match({ tags: [], ids: ["not-an-id"] })).toBe(false);

	expectTypeOf<BlueprintValue<typeof Post.properties>>().toEqualTypeOf<{
		tags: string[];
		ids: string[];
	}>();
});

test("minItems and maxItems limit the list", () => {
	const Post = blueprintOf((ctx) => ({
		tags: listOf(ctx.string, { minItems: 1, maxItems: 2 }),
	}));

	expect(Post.schema.match({ tags: [] })).toBe(false);
	expect(Post.schema.match({ tags: ["a"] })).toBe(true);
	expect(Post.schema.match({ tags: ["a", "b", "c"] })).toBe(false);
});

test("optionalOf makes a list an optional key, also through ctx.optional", () => {
	const Base = blueprintOf((ctx) => ({ tags: listOf(ctx.string) }));
	const Post = blueprintOf([Base], (ctx) => ({
		tags: ctx.optional.tags,
		addresses: optionalOf(listOf(Address)),
	}));

	expect(Post.properties.tags).toBe(optionalOf(Base.properties.tags));
	expect(Post.properties.tags.optional).toBe(true);
	expect(Post.schema.match({})).toBe(true);
	expect(Post.schema.match({ tags: ["a"], addresses: [address] })).toBe(true);
	expect(Post.schema.match({ tags: [1] })).toBe(false);

	expectTypeOf<BlueprintValue<typeof Post.properties>>().toEqualTypeOf<{
		tags?: string[];
		addresses?: { street: string; number: number }[];
	}>();
});

test("lists nest, and hold joined blueprints", () => {
	const Located = Address.join(blueprintOf((ctx) => ({ zip: ctx.string })));
	const Grid = blueprintOf(() => ({
		grid: listOf(listOf(Located)),
	}));
	const located = { ...address, zip: "01310-100" };

	expect(Grid.schema.match({ grid: [[located], []] })).toBe(true);
	expect(Grid.schema.match({ grid: [[address]] })).toBe(false);
	expectTypeOf<BlueprintValue<typeof Grid.properties>>().toEqualTypeOf<{
		grid: { street: string; number: number; zip: string }[][];
	}>();
});

test("a list of something that is not a field is rejected", () => {
	expect(() =>
		blueprintOf(() => ({ items: listOf(undefined as never) })),
	).toThrow(UndeclaredBlueprintProperty);
});

test("ctx.list mirrors every field as a list, and ctx.list.optional as an optional one", () => {
	const Base = blueprintOf(() => ({ address: Address }));
	const Post = blueprintOf([Base], (ctx) => ({
		tags: ctx.list.string,
		addresses: ctx.list.address,
		ids: ctx.list.optional.id,
	}));

	expect(Post.properties.tags.item).toBe(Std.properties.string);
	expect(Post.properties.addresses.item).toBe(Address);
	expect(Post.properties.ids.optional).toBe(true);
	expect(Post.schema.match({ tags: ["a"], addresses: [address] })).toBe(true);
	expect(Post.schema.match({ tags: [1], addresses: [] })).toBe(false);

	blueprintOf((ctx) => {
		expect(Object.keys(ctx.list)).toEqual([
			...Object.keys(Std.properties),
			"optional",
		]);
		expect(Object.keys(ctx.list.optional)).toEqual(Object.keys(Std.properties));
		expect(ctx.list.optional.string).toBe(optionalOf(ctx.list.string));
		expect(ctx.list).not.toHaveProperty("list");
		expect(ctx.list.optional).not.toHaveProperty("optional");
		expect(ctx.list.optional).not.toHaveProperty("list");
		return {};
	});

	expectTypeOf<BlueprintValue<typeof Post.properties>>().toEqualTypeOf<{
		tags: string[];
		addresses: { street: string; number: number }[];
		ids?: string[];
	}>();
	() => {
		blueprintOf((ctx) => ({
			// @ts-expect-error there is no list of lists in ctx.list
			grid: ctx.list.list,
			// @ts-expect-error nor optional or list in ctx.list.optional
			a: ctx.list.optional.optional,
			// @ts-expect-error see above
			b: ctx.list.optional.list,
		}));
	};
});

test('"list" cannot be a plugin property', () => {
	const Broken = blueprintPluginOf("broken", { list: Std.properties.string });

	expect(() => blueprintOf([Broken], () => ({}))).toThrow('"list" is reserved');
});

test("lists and blueprints are told apart by their brand, not their shape", () => {
	const lookalike = { item: Std.properties.string, optional: false };
	const fake = { schema: Address.schema, properties: Address.properties };

	expect(isBlueprintList(listOf(Std.properties.string))).toBe(true);
	expect(isBlueprintList(optionalOf(listOf(Std.properties.string)))).toBe(true);
	expect(isBlueprintList(lookalike)).toBe(false);
	expect(isBlueprint(Address)).toBe(true);
	expect(isBlueprint(optionalOf(Address))).toBe(true);
	expect(isBlueprint(fake)).toBe(false);
	expect(isBlueprint(listOf(Address))).toBe(false);
	expect(() => blueprintOf(() => ({ tags: lookalike as never }))).toThrow(
		UndeclaredBlueprintProperty,
	);
});
