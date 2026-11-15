// The `id` option of an entity: UUID v7 stays the default, and each entity can
// take another strategy of its own (`Uuid`, `Key`, or any `idOf`).
import { afterEach, describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { InvalidIdStrategy } from "../core/entity/exceptions";
import { idOf, isIdStrategy } from "../core/entity/id";
import { propertyOf } from "../core/property/property";
import { blueprintOf } from "./blueprint";
import { entityOf } from "./entity";
import { Key, Uuid } from "./properties/identity";
import { Integer, Text } from "./properties/primitives";
import { configure, resetRuntime } from "./runtime";

afterEach(resetRuntime);

const UUID_V7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V4 = "6F1C2B9E-3D4A-4E8B-9F2A-1C3B5D7E9F0A";

const Named = blueprintOf(() => ({ name: Text }));

describe("the default", () => {
	class User extends entityOf(Named) {}

	test("is still a UUID v7, made and checked as before", () => {
		expect(new User({ name: "Jane" }).id).toMatch(UUID_V7);
		expect(User.safeParse({ id: V4, name: "Jane" }).issues?.[0]?.path).toEqual([
			"id",
		]);
		const id: string = new User({ name: "Jane" }).id;
		expect(typeof id).toBe("string");
	});
});

describe("Uuid", () => {
	class Legacy extends entityOf(Named, { id: Uuid }) {}

	test("accepts a UUID of any version, lower-cased", () => {
		expect(new Legacy({ id: V4, name: "Jane" }).id).toBe(V4.toLowerCase());
	});

	test("makes a UUID v7 when the input has none", () => {
		expect(new Legacy({ name: "Jane" }).id).toMatch(UUID_V7);
	});

	test("checks the id of a configured generator", () => {
		configure({ idGenerator: () => "nope" });
		expect(
			Legacy.safeParse({ name: "Jane" }).issues?.map((issue) => issue.path),
		).toEqual([["id"]]);
	});

	test("rejects what is not a UUID", () => {
		expect(
			Legacy.safeParse({ id: "projects-1", name: "x" }).issues,
		).toHaveLength(1);
	});
});

describe("Key", () => {
	class Setting extends entityOf(Named, { id: Key, change: ["name"] }) {}

	test("keeps the id given", () => {
		const setting = new Setting({ id: "profile", name: "Profile" });
		expect(setting.id).toBe("profile");
		expect(setting.toJSON()).toMatchObject({ id: "profile", name: "Profile" });
		expect(setting.change.name("Me").id).toBe("profile");
	});

	test("requires the id: a missing one is an issue at id", () => {
		const parsed = Setting.safeParse({ name: "Profile" });
		expect(parsed.issues?.map((issue) => issue.path)).toEqual([["id"]]);
		// @ts-expect-error: the input of an entity with a natural key holds its id.
		expect(() => new Setting({ name: "Profile" })).toThrow();
	});

	test("rejects an empty id, and one longer than 256 characters", () => {
		expect(Setting.safeParse({ id: "", name: "x" }).issues).toHaveLength(1);
		expect(
			Setting.safeParse({ id: "a".repeat(257), name: "x" }).issues,
		).toHaveLength(1);
	});

	test("cannot change", () => {
		const setting = new Setting({ id: "seo", name: "SEO" });
		expect(Setting.options.unique).toContain("id");
		expect(setting.equals(new Setting({ id: "seo", name: "Other" }))).toBe(
			true,
		);
	});
});

describe("idOf", () => {
	test("a generator of integers gives number ids", () => {
		let next = 0;
		class Ticket extends entityOf(Named, {
			id: idOf(Integer, () => ++next),
		}) {}
		const first = new Ticket({ name: "a" });
		const id: number = first.id;
		expect(id).toBe(1);
		expect(new Ticket({ name: "b" }).id).toBe(2);
		expect(new Ticket({ id: 40, name: "c" }).id).toBe(40);
		// A generated id is checked: the strategy does not vouch for it.
		next = 0.5;
		expect(Ticket.safeParse({ name: "d" }).issues?.[0]?.path).toEqual(["id"]);
	});

	test("is a strategy, and nothing else is", () => {
		expect(isIdStrategy(idOf(Integer))).toBe(true);
		expect(isIdStrategy(Key)).toBe(true);
		expect(isIdStrategy({ property: Integer, generate: undefined })).toBe(
			false,
		);
	});

	test("rejects what is not a required property, and an id option not made by it", () => {
		expect(() => idOf({} as never)).toThrow(InvalidIdStrategy);
		const Nickname = propertyOf({
			name: "nickname",
			schema: Type.String(),
			optional: true,
		});
		expect(() => idOf(Nickname as never)).toThrow(InvalidIdStrategy);
		expect(() => idOf(Integer, 1 as never)).toThrow(InvalidIdStrategy);
		expect(() =>
			entityOf(Named, {
				id: { property: Integer, generate: undefined } as never,
			}),
		).toThrow(InvalidIdStrategy);
	});
});

describe("ownable, with owners of any id strategy", () => {
	class Note extends entityOf(
		blueprintOf(() => ({ text: Text })),
		{
			plugins: (ctx) => [ctx.ownable],
		},
	) {}

	test("a UUID v7 owner behaves as before: kept in lower case, compared in any case", () => {
		const owner = "01A173D2-051C-77BB-8166-A371E999573E";
		const note = new Note({ text: "a", ownerId: owner });
		expect(note.ownerId).toBe(owner.toLowerCase());
		expect(note.isOwnedBy(owner)).toBe(true);
		expect(note.isOwnedBy(owner.toLowerCase())).toBe(true);
		expect(note.isOwnedBy("01a173d2-051c-77bb-8166-a371e999573f")).toBe(false);
	});

	test("a v4 UUID owner", () => {
		const note = new Note({ text: "a", ownerId: V4 });
		expect(note.ownerId).toBe(V4.toLowerCase());
		expect(note.isOwnedBy(V4)).toBe(true);
	});

	test("a natural key owner is kept and compared as given", () => {
		class Setting extends entityOf(Named, { id: Key }) {}
		const owner = new Setting({ id: "Profile", name: "p" });
		const note = new Note({ text: "a", ownerId: owner.id });
		expect(note.ownerId).toBe("Profile");
		expect(note.isOwnedBy(owner.id)).toBe(true);
		expect(note.isOwnedBy("profile")).toBe(false);
	});

	test("an integer owner, compared by value", () => {
		class Member extends entityOf(Named, { id: idOf(Integer, () => 7) }) {}
		const owner = new Member({ name: "m" });
		const note = new Note({ text: "a", ownerId: owner.id });
		expect(note.ownerId).toBe(7);
		expect(note.isOwnedBy(7)).toBe(true);
		expect(note.isOwnedBy("7")).toBe(true);
		expect(note.isOwnedBy(8)).toBe(false);
		expect(note.transferTo(8).isOwnedBy(8)).toBe(true);
	});

	test("an empty owner, or one that is not a positive integer, is rejected", () => {
		expect(Note.safeParse({ text: "a", ownerId: "" }).issues).toBeDefined();
		expect(Note.safeParse({ text: "a", ownerId: 0 }).issues).toBeDefined();
		expect(Note.safeParse({ text: "a", ownerId: 1.5 }).issues).toBeDefined();
	});
});
