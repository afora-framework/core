import { expect, expectTypeOf, test } from "bun:test";
import { Type } from "typebox";
import { blueprintOf } from "../../std/blueprint";
import { Std } from "../../std/blueprint-plugin";
import { propertyOf } from "../property/property";
import { blueprintBuilderOf } from "./blueprint";
import { blueprintPluginOf } from "./blueprint-plugin";
import { fieldOf } from "./callable";
import { UndeclaredBlueprintProperty } from "./exceptions";
import { listOf } from "./list";
import { optionalOf } from "./optional";
import type {
	BlueprintField,
	BlueprintValue,
} from "./types/blueprint.interface";
import { variantOf } from "./variant";

const Id = propertyOf({ name: "id", schema: Type.String() });
const CreatedAt = propertyOf({ name: "createdAt", schema: Type.Number() });
const Name = propertyOf({
	name: "name",
	schema: Type.String({ minLength: 3 }),
});
const Nickname = propertyOf({
	name: "nickname",
	schema: Type.String(),
	optional: true,
});

const Timestamps = blueprintPluginOf("timestamps", { createdAt: CreatedAt });

const Base = blueprintPluginOf("base", {
	id: Id,
	name: Name,
	nickname: Nickname,
});

test("passes the properties of every plugin to the definition", () => {
	blueprintOf([Base, Timestamps], ({ optional: _, list: __, ...ctx }) => {
		const fields: Record<string, unknown> = Object.fromEntries(
			Object.entries(ctx).map(([key, field]) => [
				key,
				fieldOf(field as BlueprintField),
			]),
		);
		expect(fields).toEqual({
			...Std.properties,
			...Std.factories,
			listOf,
			optionalOf,
			propertyOf,
			variantOf,
			id: Id,
			name: Name,
			nickname: Nickname,
			createdAt: CreatedAt,
		});
		return {};
	});
});

test("passes the factories of every plugin to the definition", () => {
	const Tagged = blueprintPluginOf(
		"tagged",
		{},
		{ tagOf: (name: string) => propertyOf({ name, schema: Type.String() }) },
	);
	const Post = blueprintOf([Tagged], (ctx) => ({ tag: ctx.tagOf("tag") }));

	expect(Post.properties.tag.type.name).toBe("tag");
	expect(Post.safeParse({ tag: "news" })).toEqual({ value: { tag: "news" } });
});

test("a factory replaces a field with the same name, in the context and its mirrors", () => {
	const Shadow = blueprintPluginOf("shadow", {}, { name: () => Id });

	blueprintOf([Base, Shadow], (ctx) => {
		expect(ctx.name()).toBe(Id);
		expect(ctx.optional).not.toHaveProperty("name");
		expect(ctx.list).not.toHaveProperty("name");
		expectTypeOf(ctx.optional).not.toHaveProperty("name");
		return {};
	});
});

test("every context has listOf, optionalOf and propertyOf, generics kept", () => {
	const contentBlueprintOf = blueprintBuilderOf(Base);
	const Post = contentBlueprintOf((ctx) => ({
		tags: ctx.listOf(ctx.name, { maxItems: 2 }),
		nickname: ctx.optionalOf(ctx.name),
		score: ctx.propertyOf({ name: "score", schema: Type.Integer() }),
	}));

	expect(Post.safeParse({ tags: ["Ana"], score: 1 })).toEqual({
		value: { tags: ["Ana"], score: 1 },
	});
	expect(
		Post.safeParse({ tags: ["Ana", "Bia", "Cid"], score: 1.5 }),
	).toHaveProperty("issues");
	expectTypeOf<BlueprintValue<typeof Post.properties>>().toEqualTypeOf<{
		tags: string[];
		nickname?: string;
		score: number;
	}>();
});

test.each(["listOf", "optionalOf", "propertyOf", "variantOf"])(
	'"%s" is reserved for plugins, as a property or a factory',
	(key) => {
		const AsProperty = blueprintPluginOf("broken", { [key]: Id });
		const AsFactory = blueprintPluginOf("broken", {}, { [key]: () => Id });

		expect(() => blueprintOf([AsProperty], () => ({}))).toThrow(
			`"${key}" is reserved`,
		);
		expect(() => blueprintOf([AsFactory], () => ({}))).toThrow(
			`"${key}" is reserved`,
		);
	},
);

test("a factory cannot take a reserved key", () => {
	const Broken = blueprintPluginOf("broken", {}, { list: () => Id });

	expect(() => blueprintOf([Broken], () => ({}))).toThrow('"list" is reserved');
});

test("keeps only the properties picked by the definition", () => {
	const User = blueprintOf([Base, Timestamps], (ctx) => ({
		id: ctx.id,
		name: ctx.name,
	}));

	expect(User.properties).toEqual({ id: Id, name: Name });
	expect(User.plugins).toEqual([Std, Base, Timestamps]);
});

test("builds a general schema of the picked properties", () => {
	const User = blueprintOf([Base], (ctx) => ({
		name: ctx.name,
		nickname: ctx.nickname,
	}));

	expect(User.schema.match({ name: "abc" })).toBe(true);
	expect(User.schema.match({ name: "abc", nickname: "x" })).toBe(true);
	expect(User.schema.match({ name: "ab" })).toBe(false);
	expect(User.schema.match({})).toBe(false);
});

test("accepts properties declared outside the plugins", () => {
	const User = blueprintOf([Base], (ctx) => ({
		id: ctx.id,
		createdAt: CreatedAt,
	}));

	expect(User.schema.match({ id: "1", createdAt: 0 })).toBe(true);
});

test("a later plugin replaces a key of an earlier one", () => {
	const OtherId = propertyOf({ name: "id", schema: Type.Number() });
	const Numeric = blueprintPluginOf("numeric", { id: OtherId });

	const User = blueprintOf([Base, Numeric], (ctx) => ({ id: ctx.id }));

	expect(User.properties.id).toBe(OtherId);
	expectTypeOf(User.properties.id).toEqualTypeOf(OtherId);
});

test("infers the value type of the blueprint", () => {
	const User = blueprintOf([Base, Timestamps], (ctx) => ({
		id: ctx.id,
		createdAt: ctx.createdAt,
		nickname: ctx.nickname,
	}));

	expectTypeOf<BlueprintValue<typeof User.properties>>().toEqualTypeOf<{
		id: string;
		createdAt: number;
		nickname?: string;
	}>();
});

test("rejects keys that no plugin provides", () => {
	expect(() =>
		// @ts-expect-error `title` is not in any plugin
		blueprintOf([Base], (ctx) => ({ title: ctx.title })),
	).toThrow('Property "title" of the blueprint is not declared.');
});

test("Std is always included, first, so plugins can replace its keys", () => {
	const Email = propertyOf({ name: "email", schema: Type.String() });
	const Custom = blueprintPluginOf("custom", { email: Email });

	const User = blueprintOf([Custom], (ctx) => ({
		id: ctx.id,
		email: ctx.email,
	}));

	expect(User.plugins).toEqual([Std, Custom]);
	expect(User.properties.id).toBe(Std.properties.id);
	expect(User.properties.email).toBe(Email);
	expectTypeOf(User.properties.email).toEqualTypeOf(Email);
});

test("passing Std explicitly does not include it twice", () => {
	const User = blueprintOf([Std, Base], (ctx) => ({ name: ctx.name }));

	expect(User.plugins).toEqual([Std, Base]);
	expect(User.properties.name).toBe(Name);
});

test("blueprintBuilderOf builds blueprints from its own base, without Std", () => {
	const Title = propertyOf({ name: "title", schema: Type.String() });
	const Content = blueprintPluginOf("content", { title: Title });
	const contentBlueprintOf = blueprintBuilderOf(Content);

	const Post = contentBlueprintOf((ctx) => ({ title: ctx.title }));
	expect(Post.plugins).toEqual([Content]);
	expect(Post.properties.title).toBe(Title);
	expect(() =>
		// @ts-expect-error `email` is a Std key, not one of Content
		contentBlueprintOf((ctx) => ({ email: ctx.email })),
	).toThrow(UndeclaredBlueprintProperty);

	const Extra = blueprintPluginOf("extra", { slug: Std.properties.slug });
	const Page = contentBlueprintOf([Extra], (ctx) => ({
		title: ctx.title,
		slug: ctx.slug,
	}));
	expect(Page.plugins).toEqual([Content, Extra]);
	expectTypeOf<BlueprintValue<typeof Page.properties>>().toEqualTypeOf<{
		title: string;
		slug: string;
	}>();
});
