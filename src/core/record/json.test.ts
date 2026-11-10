import { expect, expectTypeOf, test } from "bun:test";
import {
	blueprintOf,
	entityOf,
	listOf,
	MASK,
	type Masked,
	optionalOf,
	Password,
	type RecordJson,
	recordOf,
	recordPluginOf,
} from "../../index";

const HASH = Password.demo().value;

test("toJSON gives every key, typed as the plain value", () => {
	const Address = blueprintOf((ctx) => ({ street: ctx.string }));
	class User extends recordOf(
		blueprintOf((ctx) => ({
			name: ctx.string,
			age: ctx.integer,
			nickname: ctx.optional.string,
			address: Address,
			tags: listOf(ctx.string),
		})),
	) {}
	const json = new User({
		name: "Ana",
		age: 30,
		address: { street: "Main" },
		tags: ["a"],
	}).toJSON();

	// No `Partial`: a required key is not `undefined`.
	expectTypeOf(json.name).toEqualTypeOf<string>();
	expectTypeOf(json.age).toEqualTypeOf<number>();
	expectTypeOf(json.nickname).toEqualTypeOf<string | undefined>();
	expectTypeOf(json.address.street).toEqualTypeOf<string>();
	expectTypeOf(json.tags).toEqualTypeOf<string[]>();
	expect(json).toEqual({
		name: "Ana",
		age: 30,
		address: { street: "Main" },
		tags: ["a"],
	});
	() => {
		// @ts-expect-error the value is read-only
		json.name = "Bia";
		// @ts-expect-error not a key of the record
		json.other;
	};
});

test("the keys of options.sensitive are typed as masked", () => {
	const Box = blueprintOf((ctx) => ({ size: ctx.integer, label: ctx.string }));
	class Account extends recordOf(
		blueprintOf((ctx) => ({
			name: ctx.string,
			balance: ctx.integer,
			limit: ctx.optional.integer,
			scores: listOf(ctx.integer),
			box: Box,
		})),
		{ sensitive: ["balance", "limit", "scores", "box"] },
	) {}
	const json = new Account({
		name: "Ana",
		balance: 10,
		scores: [1, 2],
		box: { size: 1, label: "a" },
	}).toJSON();

	expectTypeOf(json.name).toEqualTypeOf<string>();
	expectTypeOf(json.balance).toEqualTypeOf<string>();
	expectTypeOf(json.limit).toEqualTypeOf<string | undefined>();
	expectTypeOf(json.scores).toEqualTypeOf<string[]>();
	expectTypeOf(json.box).toEqualTypeOf<{
		readonly size: string;
		readonly label: string;
	}>();
	expect(json).toEqual({
		name: "Ana",
		balance: MASK,
		scores: [MASK, MASK],
		box: { size: MASK, label: MASK },
	});
});

test("a property declared sensitive is masked in the type at any depth", () => {
	const Secret = blueprintOf((ctx) => ({ code: ctx.integer }));
	class Vault extends recordOf(
		blueprintOf((ctx) => ({
			password: ctx.password,
			previous: listOf(ctx.password),
			nested: blueprintOf((inner) => ({
				password: inner.password,
				hint: inner.string,
			})),
			secret: Secret,
		})),
	) {}
	const json = new Vault({
		password: HASH,
		previous: [HASH],
		nested: { password: HASH, hint: "x" },
		secret: { code: 1 },
	}).toJSON();

	// A masked string is still a string.
	expectTypeOf(json.password).toEqualTypeOf<string>();
	expectTypeOf(json.previous).toEqualTypeOf<string[]>();
	expectTypeOf(json.nested.hint).toEqualTypeOf<string>();
	expectTypeOf(json.secret.code).toEqualTypeOf<number>();
	expect(json).toEqual({
		password: MASK,
		previous: [MASK],
		nested: { password: MASK, hint: "x" },
		secret: { code: 1 },
	});
	expectTypeOf<Masked<{ a: number; b: (boolean | null)[] }>>().toEqualTypeOf<{
		readonly a: string;
		readonly b: (string | null)[];
	}>();
});

test("a record field gives the toJSON of its record", () => {
	class Card extends recordOf(
		blueprintOf((ctx) => ({ holder: ctx.string, cvv: ctx.integer })),
		{ sensitive: ["cvv"] },
	) {}
	class Wallet extends recordOf(
		blueprintOf(() => ({
			main: Card,
			spare: optionalOf(Card),
			cards: listOf(Card),
		})),
	) {}
	const card = { holder: "Ana", cvv: 123 };
	const json = new Wallet({ main: card, cards: [card] }).toJSON();

	expectTypeOf(json.main.holder).toEqualTypeOf<string>();
	expectTypeOf(json.main.cvv).toEqualTypeOf<string>();
	expectTypeOf(json.cards[0]?.cvv).toEqualTypeOf<string | undefined>();
	expectTypeOf(json.spare?.cvv).toEqualTypeOf<string | undefined>();
	expect(json).toEqual({
		main: { holder: "Ana", cvv: MASK },
		cards: [{ holder: "Ana", cvv: MASK }],
	});
});

test("entities and plugins carry their sensitive keys", () => {
	class Pinned extends recordOf(
		blueprintOf((ctx) => ({ pin: ctx.integer })),
		{ sensitive: ["pin"] },
	) {}
	const WithPin = recordPluginOf("pinned", Pinned);
	class Member extends entityOf(
		blueprintOf((ctx) => ({ name: ctx.string, salary: ctx.integer })),
		{ sensitive: ["salary"], plugins: [WithPin] },
	) {}
	const json = new Member({ name: "Ana", salary: 10, pin: 1234 }).toJSON();

	expectTypeOf(json.id).toEqualTypeOf<string>();
	expectTypeOf(json.name).toEqualTypeOf<string>();
	expectTypeOf(json.salary).toEqualTypeOf<string>();
	expectTypeOf(json.pin).toEqualTypeOf<string>();
	expect(json).toMatchObject({ name: "Ana", salary: MASK, pin: MASK });
	expectTypeOf<RecordJson<{ readonly name: typeof Password }>>().toEqualTypeOf<{
		readonly name: string;
	}>();
});
