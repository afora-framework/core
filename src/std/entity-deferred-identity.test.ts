// An entity makes the id, the date and the expiry its builder vouches for only
// once the rest of its value is valid; invalid input pays for none of them,
// and says what an entity whose builder does not vouch says.
import { expect, test } from "bun:test";
import { Type } from "typebox";
import { blueprintBuilderOf } from "../core/blueprint/blueprint";
import { entityBuilderOf } from "../core/entity/entity";
import { eventOf } from "../core/entity/event";
import { vouching } from "../core/entity/trust";
import { propertyOf } from "../core/property/property";
import { blueprintOf } from "./blueprint";
import { Id } from "./properties/identity";
import { Integer, Text } from "./properties/primitives";
import { CreatedAt, DeletedAt, ExpiresAt, UpdatedAt } from "./properties/time";

const Identity = blueprintBuilderOf()(() => ({
	id: Id,
	createdAt: CreatedAt,
	updatedAt: UpdatedAt,
	deletedAt: DeletedAt,
}));

const FIXED = "2030-01-01T00:00:00.000Z";
const ID = "01a173d2-051c-77bb-8166-a371e999573e";

/** A builder that counts its makers, and vouches for them or not. */
function builder(vouch: boolean) {
	const calls = { id: 0, now: 0 };
	const settings = {
		identity: Identity,
		generateId: () => {
			calls.id++;
			return ID;
		},
		now: () => {
			calls.now++;
			return FIXED;
		},
		expiresAt: ExpiresAt,
	};
	const entityOf = entityBuilderOf(
		vouch
			? vouching(settings, { id: () => true, createdAt: () => true })
			: settings,
	);
	return { entityOf, calls };
}

const Named = blueprintOf(() => ({ name: Text }));
const Aged = blueprintOf(() => ({ name: Text, age: Integer }));

/** The issues without the name of the class that raised them. */
const withoutSource = (issues?: readonly object[]) =>
	issues?.map((issue) => ({ ...issue, source: undefined }));

const paths = (issues?: readonly { path: readonly unknown[] }[]) =>
	issues?.map((issue) => issue.path);

test("invalid input makes no id and no date", () => {
	const { entityOf, calls } = builder(true);
	class User extends entityOf(Named) {}

	expect(User.safeParse({ name: 1 }).issues).toBeDefined();
	expect(User.safeParse({ name: "Jane", other: 1 }).issues).toBeDefined();
	expect(User.safeParse("nope").issues).toBeDefined();
	expect(User.safeParse(null).issues).toBeDefined();
	expect(() => new User({ name: 1 } as never)).toThrow();
	expect(calls).toEqual({ id: 0, now: 0 });

	expect(User.safeParse({ name: "Jane" }).issues).toBeUndefined();
	expect(calls).toEqual({ id: 1, now: 1 });
});

test("hydration with an id and a date makes neither", () => {
	const { entityOf, calls } = builder(true);
	class User extends entityOf(Named) {}

	const user = new User({ name: "Jane", id: ID, createdAt: FIXED });
	expect(user.id).toBe(ID);
	expect(calls).toEqual({ id: 0, now: 0 });
});

test("the issues are those of a builder that does not vouch", () => {
	const fast = builder(true);
	const slow = builder(false);
	class Fast extends fast.entityOf(Aged, { versioned: true }) {}
	class Slow extends slow.entityOf(Aged, { versioned: true }) {}
	class Inner extends fast.entityOf(Named) {}
	class InnerSlow extends slow.entityOf(Named) {}
	const Nested = blueprintOf(() => ({ inner: Inner, age: Integer }));
	const NestedSlow = blueprintOf(() => ({ inner: InnerSlow, age: Integer }));
	class Outer extends fast.entityOf(Nested) {}
	class OuterSlow extends slow.entityOf(NestedSlow) {}

	const inputs: unknown[] = [
		{ name: 1, age: "x" },
		{ name: "Jane", age: 1.5 },
		{ id: "not-an-id", name: 1, age: 1 },
		{ createdAt: "yesterday", name: "Jane", age: 1 },
		{ id: ID, createdAt: "yesterday", name: 1, age: 1 },
		{ createdAt: FIXED, name: 1, age: 1 },
		{ name: "Jane", age: 1, other: 1 },
		{ name: "Jane", age: 1, version: "x" },
		{ id: undefined, createdAt: undefined, name: 1, age: 1 },
		{ name: "Jane" },
		[],
		null,
		3,
	];
	for (const input of inputs) {
		const a = withoutSource(Fast.safeParse(input).issues);
		const b = withoutSource(Slow.safeParse(input).issues);
		expect(a).toBeDefined();
		expect(a).toEqual(b);
	}

	for (const input of [
		{ inner: { name: 1 }, age: 1 },
		{ inner: { name: "Jane", extra: 1 }, age: "x" },
		{ inner: { name: "Jane", id: "bad" }, age: 1 },
	]) {
		const a = withoutSource(Outer.safeParse(input).issues);
		expect(a).toBeDefined();
		expect(a).toEqual(withoutSource(OuterSlow.safeParse(input).issues));
	}
});

test("a bad configured generator is reported before the fields after it", () => {
	const { entityOf } = builder(false);
	const Bad = entityBuilderOf({
		identity: Identity,
		generateId: () => "not-an-id",
		now: () => FIXED,
	});
	class User extends Bad(Named) {}
	class Other extends entityOf(Named) {}

	expect(paths(User.safeParse({ name: 1 }).issues)).toEqual([["id"], ["name"]]);
	expect(paths(Other.safeParse({ name: 1 }).issues)).toEqual([["name"]]);
});

test("the keys of the value are in the order of the blueprint", () => {
	const { entityOf } = builder(true);
	class User extends entityOf(Named) {}
	const order = ["id", "createdAt", "name"];

	for (const input of [
		{ name: "Jane" },
		{ name: "Jane", id: undefined },
		{ id: undefined, name: "Jane", createdAt: undefined },
		{ createdAt: FIXED, name: "Jane" },
		{ name: "Jane", createdAt: FIXED, id: ID },
	]) {
		expect(Object.keys(new User(input as never).toJSON())).toEqual(order);
	}
});

test("a versioned entity is at version 1 when it has none, and a bad version is reported", () => {
	const { entityOf } = builder(true);
	class User extends entityOf(Named, { versioned: true }) {}

	expect(
		(new User({ name: "Jane" }) as unknown as { version: number }).version,
	).toBe(1);
	expect(paths(User.safeParse({ name: "Jane", version: "x" }).issues)).toEqual([
		["version"],
	]);
});

test("an expiring entity expires a lifetime after its date", () => {
	const { entityOf, calls } = builder(true);
	class Session extends entityOf(Named, {
		expires: { after: { minutes: 1 } },
	}) {}
	const expiry = (value: object) =>
		(value as unknown as { expiresAt: string }).expiresAt;
	const later = "2030-01-01T00:01:00.000Z";

	const made = new Session({ name: "Jane" });
	expect(expiry(made)).toBe(later);
	expect(Object.keys(made.toJSON())).toEqual([
		"id",
		"createdAt",
		"expiresAt",
		"name",
	]);

	const brought = new Session({
		name: "Jane",
		createdAt: "2031-01-01T00:00:00.000Z",
	});
	expect(expiry(brought)).toBe("2031-01-01T00:01:00.000Z");

	const kept = new Session({
		name: "Jane",
		expiresAt: "2040-01-01T00:00:00.000Z",
	});
	expect(expiry(kept)).toBe("2040-01-01T00:00:00.000Z");

	calls.now = 0;
	expect(Session.safeParse({ name: 1 }).issues).toBeDefined();
	expect(calls.now).toBe(0);
	expect(
		paths(Session.safeParse({ name: "Jane", expiresAt: "x" }).issues),
	).toEqual([["expiresAt"]]);
});

test("an expiry that does not check is reported", () => {
	const Short = propertyOf({
		name: "expiresAt",
		schema: Type.String({ maxLength: 5 }),
	});
	const entityOf = entityBuilderOf(
		vouching(
			{
				identity: Identity,
				generateId: () => ID,
				now: () => FIXED,
				expiresAt: Short as never,
			},
			{ id: () => true, createdAt: () => true },
		),
	);
	class Session extends entityOf(Named, {
		expires: { after: { minutes: 1 } },
	}) {}

	expect(paths(Session.safeParse({ name: "Jane" }).issues)).toEqual([
		["expiresAt"],
	]);
});

test("onCreate is queued only for a new, valid entity", () => {
	const { entityOf } = builder(true);
	// The event is made from the class it is queued for, which asks for it later.
	let Created: ReturnType<typeof eventOf>;
	class User extends entityOf(Named, { onCreate: () => Created }) {}
	Created = eventOf("created", User);

	expect(User.safeParse({ name: 1 }).issues).toBeDefined();
	expect(new User({ name: "Jane" }).pullEvents()).toHaveLength(1);
	expect(
		new User({ name: "Jane", id: ID, createdAt: FIXED }).pullEvents(),
	).toHaveLength(0);
});
