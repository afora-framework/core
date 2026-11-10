import { describe, expect, test } from "bun:test";
import { blueprintOf } from "../../std/blueprint";
import { entityOf } from "../../std/entity";
import { listOf } from "../blueprint/list";
import { optionalOf } from "../blueprint/optional";
import { recordOf } from "../record/record";
import { stripUndeclared } from "./strip";

const Address = blueprintOf((ctx) => ({
	street: ctx.string,
	zip: ctx.string,
}));

class Tag extends recordOf(blueprintOf((ctx) => ({ label: ctx.string }))) {}

const Customer = blueprintOf((ctx) => ({
	name: ctx.string,
	address: Address,
	billing: optionalOf(Address),
	addresses: listOf(Address),
	tags: listOf(Tag),
	main: optionalOf(Tag),
	matrix: listOf(listOf(ctx.string)),
}));

describe("stripUndeclared", () => {
	test("keeps only the declared keys, at any depth", () => {
		const payload = {
			id: "cus_1",
			object: "customer",
			name: "Ana",
			address: { street: "Main St", zip: "1", country: "BR" },
			billing: { street: "Side St", zip: "2", line2: "apt 3" },
			addresses: [{ street: "A", zip: "3", extra: true }],
			tags: [{ label: "vip", color: "gold" }],
			main: { label: "main", priority: 1 },
			matrix: [["a", "b"]],
		};

		expect(stripUndeclared(Customer, payload)).toEqual({
			name: "Ana",
			address: { street: "Main St", zip: "1" },
			billing: { street: "Side St", zip: "2" },
			addresses: [{ street: "A", zip: "3" }],
			tags: [{ label: "vip" }],
			main: { label: "main" },
			matrix: [["a", "b"]],
		});
	});

	test("leaves out an absent optional field and undefined values", () => {
		expect(
			stripUndeclared(Customer, {
				name: "Ana",
				billing: undefined,
				extra: 1,
			}),
		).toEqual({ name: "Ana" });
		expect(
			Object.hasOwn(
				stripUndeclared(Customer, { billing: undefined }) as object,
				"billing",
			),
		).toBe(false);
	});

	test("lets parsing accept what it would have rejected", () => {
		class Person extends recordOf(Address) {}
		const payload = { street: "Main St", zip: "1", country: "BR" };

		expect(Person.safeParse(payload).issues?.[0]?.code).toBe("undeclared_key");
		expect(
			Person.safeParse(stripUndeclared(Person, payload)).issues,
		).toBeUndefined();
	});

	test("takes a record or entity class, keeping the identity keys", () => {
		class User extends entityOf(blueprintOf((ctx) => ({ name: ctx.string }))) {}

		expect(
			stripUndeclared(User, {
				id: "1",
				createdAt: "2026-01-01",
				name: "Ana",
				role: "admin",
			}),
		).toEqual({ id: "1", createdAt: "2026-01-01", name: "Ana" });
	});

	test("returns values of the wrong type and record instances as they are", () => {
		const tag = new Tag({ label: "vip" });
		const wrong = {
			name: "Ana",
			address: "nowhere",
			addresses: {},
			tags: [tag, 1],
		};
		const stripped = stripUndeclared(Customer, wrong) as Record<
			string,
			unknown
		>;

		expect(stripped.address).toBe("nowhere");
		expect(stripped.addresses).toEqual({});
		expect((stripped.tags as unknown[])[0]).toBe(tag);
		expect((stripped.tags as unknown[])[1]).toBe(1);
		expect(stripUndeclared(Customer, "text")).toBe("text");
		expect(stripUndeclared(Customer, null)).toBeNull();
		expect(stripUndeclared(Customer, [1])).toEqual([1]);
	});

	test("keeps a property's object value whole", () => {
		const Doc = blueprintOf((ctx) => ({ schema: ctx.schema }));
		const schema = { type: "object", properties: { a: { type: "string" } } };

		expect(stripUndeclared(Doc, { schema, other: 1 })).toEqual({ schema });
	});

	test("does not change the value it is given", () => {
		const payload = {
			name: "Ana",
			address: { street: "A", zip: "1", x: 1 },
			y: 2,
		};
		const copy = structuredClone(payload);
		const stripped = stripUndeclared(Customer, payload) as Record<
			string,
			unknown
		>;

		expect(payload).toEqual(copy);
		expect(stripped).not.toBe(payload);
		expect(stripped.address).not.toBe(payload.address);
	});

	test("a declared __proto__ stays a key and an undeclared one is dropped", () => {
		const Odd = blueprintOf((ctx) => ({ ["__proto__"]: ctx.string }));
		const payload = JSON.parse('{"__proto__": "x", "polluted": true}');
		const stripped = stripUndeclared(Odd, payload) as Record<string, unknown>;

		expect(Object.getPrototypeOf(stripped)).toBe(Object.prototype);
		expect(Object.hasOwn(stripped, "__proto__")).toBe(true);
		expect(Object.hasOwn(stripped, "polluted")).toBe(false);

		const plain = stripUndeclared(
			Address,
			JSON.parse('{"__proto__": {"admin": true}}'),
		);
		expect(({} as Record<string, unknown>).admin).toBeUndefined();
		expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
	});
});
