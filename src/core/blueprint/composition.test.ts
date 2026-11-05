import { expect, expectTypeOf, test } from "bun:test";
import { Type } from "typebox";
import { blueprintOf } from "../../std/blueprint";
import { Std } from "../../std/blueprint-plugin";
import { propertyOf } from "../property/property";
import { blueprintPluginOf } from "./blueprint-plugin";
import { UndeclaredBlueprintProperty } from "./exceptions";
import { optionalOf } from "./optional";
import type { BlueprintValue } from "./types/blueprint.interface";

const Street = propertyOf({ name: "street", schema: Type.String() });
const Zip = propertyOf({
	name: "zip",
	schema: Type.String({ pattern: "^\\d{5}-\\d{3}$" }),
});

const Address = blueprintOf(
	[blueprintPluginOf("address", { street: Street, zip: Zip })],
	(ctx) => ({
		street: ctx.street,
		zip: ctx.zip,
	}),
);

const Timestamps = blueprintOf((ctx) => ({
	createdAt: ctx.createdAt,
	updatedAt: ctx.updatedAt,
}));

const User = blueprintOf((ctx) => ({
	name: ctx.string,
	email: ctx.email,
	address: Address,
	billing: optionalOf(Address),
}));

const user = {
	name: "Jane",
	email: "jane@example.com",
	address: { street: "Main St", zip: "01310-100" },
};

test("a key can hold a blueprint, validated as a nested object", () => {
	expect(User.properties.address).toBe(Address);
	expect(User.schema.match(user)).toBe(true);
	expect(User.schema.match({ ...user, address: { street: "Main St" } })).toBe(
		false,
	);
	expect(
		User.schema.match({ ...user, address: { ...user.address, zip: "1" } }),
	).toBe(false);
	expect(User.schema.errors({ ...user, address: {} }).join()).toContain(
		"/address",
	);
});

test("optionalOf makes a nested blueprint an optional key", () => {
	const Billing = optionalOf(Address);

	expect(Billing.optional).toBe(true);
	expect(Billing.properties).toBe(Address.properties);
	expect(optionalOf(Address)).toBe(Billing);
	expect(optionalOf(Billing)).toBe(Billing);
	expect(User.schema.match({ ...user, billing: user.address })).toBe(true);
	expect(User.schema.match({ ...user, billing: {} })).toBe(false);
});

test("infers the nested value type", () => {
	expectTypeOf<BlueprintValue<typeof User.properties>>().toEqualTypeOf<{
		name: string;
		email: string;
		address: { street: string; zip: string };
		billing?: { street: string; zip: string };
	}>();
});

test("join keeps every field of each blueprint", () => {
	const Customer = User.join(Timestamps);

	expect(Object.keys(Customer.properties)).toEqual([
		"name",
		"email",
		"address",
		"billing",
		"createdAt",
		"updatedAt",
	]);
	expect(Customer.properties.address).toBe(Address);
	const now = new Date().toISOString();
	expect(
		Customer.schema.match({ ...user, createdAt: now, updatedAt: now }),
	).toBe(true);
	expect(Customer.schema.match(user)).toBe(false);
	expect(Customer.plugins).toEqual(User.plugins);

	expectTypeOf<BlueprintValue<typeof Customer.properties>>().toEqualTypeOf<{
		name: string;
		email: string;
		address: { street: string; zip: string };
		billing?: { street: string; zip: string };
		createdAt: string;
		updatedAt?: string;
	}>();
});

test("a later blueprint of a join replaces a key of an earlier one", () => {
	const Named = blueprintOf((ctx) => ({ name: ctx.text }));
	const Joined = User.join(Named);

	expect(Joined.properties.name).toBe(Std.properties.text);
	expectTypeOf(Joined.properties.name).toEqualTypeOf(Std.properties.text);
});

test("join takes many blueprints, and chains", () => {
	const Named = blueprintOf((ctx) => ({ name: ctx.text }));
	const Flagged = blueprintOf((ctx) => ({ active: ctx.boolean }));
	const Many = User.join(Timestamps, Named, Flagged);
	const Chained = User.join(Timestamps).join(Named).join(Flagged);

	expect(Many.properties).toEqual(Chained.properties);
	expect(Many.properties.name).toBe(Std.properties.text);
	expect(User.properties).not.toHaveProperty("active");
	expectTypeOf(Many.properties).toEqualTypeOf(Chained.properties);
});

test("a joined blueprint can be nested, and a nested one joined", () => {
	const Located = blueprintOf((ctx) => ({ id: ctx.id })).join(
		blueprintOf(() => ({ address: Address })),
	);
	const Store = blueprintOf((ctx) => ({ name: ctx.string, place: Located }));

	expect(
		Store.schema.match({
			name: "S",
			place: { id: Std.properties.id.generate().value, address: user.address },
		}),
	).toBe(true);
	expectTypeOf<
		BlueprintValue<typeof Store.properties>["place"]
	>().toEqualTypeOf<{ id: string; address: { street: string; zip: string } }>();
});

test("blueprints can be sources to pick from, next to plugins", () => {
	const Roles = blueprintPluginOf("roles", {
		role: propertyOf({ name: "role", schema: Type.String() }),
	});
	const Admin = blueprintOf([User, Roles], (ctx) => ({
		name: ctx.name,
		address: ctx.address,
		billing: ctx.optional.address,
		role: ctx.role,
		active: ctx.boolean,
	}));

	expect(Admin.properties.billing).toBe(optionalOf(Address));
	expect(Admin.plugins).toEqual([...User.plugins, Roles]);
	expect(
		Admin.schema.match({
			name: "Jane",
			address: user.address,
			role: "admin",
			active: true,
		}),
	).toBe(true);
	expectTypeOf<BlueprintValue<typeof Admin.properties>>().toEqualTypeOf<{
		name: string;
		address: { street: string; zip: string };
		billing?: { street: string; zip: string };
		role: string;
		active: boolean;
	}>();
});

test("blueprints nest at any depth", () => {
	const Company = blueprintOf((ctx) => ({ name: ctx.string, owner: User }));
	const Group = blueprintOf((ctx) => ({ name: ctx.string, company: Company }));

	expect(
		Group.schema.match({ name: "G", company: { name: "C", owner: user } }),
	).toBe(true);
	expect(
		Group.schema.match({
			name: "G",
			company: { name: "C", owner: { ...user, address: {} } },
		}),
	).toBe(false);
	expectTypeOf<
		BlueprintValue<typeof Group.properties>["company"]["owner"]["address"]
	>().toEqualTypeOf<{ street: string; zip: string }>();
});

test("a key that is neither a property nor a blueprint is rejected", () => {
	expect(() =>
		blueprintOf(() => ({ address: { street: Street } as never })),
	).toThrow(UndeclaredBlueprintProperty);
});
