// An entity does not check again the id and the date its defaults have just
// made; whatever else makes them, or brings them, is checked as any value.
import { afterEach, expect, test } from "bun:test";
import { blueprintBuilderOf } from "../core/blueprint/blueprint";
import { entityBuilderOf } from "../core/entity/entity";
import { blueprintOf } from "./blueprint";
import { entityOf } from "./entity";
import { Id } from "./properties/identity";
import { Text } from "./properties/primitives";
import { CreatedAt, DeletedAt, UpdatedAt } from "./properties/time";
import { configure, resetRuntime } from "./runtime";

afterEach(resetRuntime);

const UUID_V7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const Named = blueprintOf(() => ({ name: Text }));
class User extends entityOf(Named) {}

test("the id and the date an entity makes by default are those its properties would keep", () => {
	const user = new User({ name: "Jane" });

	expect(user.id).toMatch(UUID_V7);
	expect(user.createdAt).toMatch(ISO);
	// What was kept unchecked is what checking it gives.
	expect(new Id(user.id).value).toBe(user.id);
	expect(new CreatedAt(user.createdAt).value).toBe(user.createdAt);
	expect(Object.keys(user.toJSON())).toEqual(["id", "createdAt", "name"]);
});

test("the id of a configured generator is checked", () => {
	configure({ idGenerator: () => "not-an-id" });

	expect(() => new User({ name: "Jane" })).toThrow();
	expect(
		User.safeParse({ name: "Jane" }).issues?.map((issue) => issue.path),
	).toEqual([["id"]]);
});

test("the id of a configured generator is handled as any id", () => {
	configure({ idGenerator: () => "01A173D2-051C-77BB-8166-A371E999573E" });

	expect(new User({ name: "Jane" }).id).toBe(
		"01a173d2-051c-77bb-8166-a371e999573e",
	);
});

test("the default generator is not vouched for while another is configured, and is again after", () => {
	configure({ idGenerator: () => "not-an-id" });
	expect(User.safeParse({ name: "Jane" }).issues).toBeDefined();

	resetRuntime();
	expect(User.safeParse({ name: "Jane" }).issues).toBeUndefined();
});

test("an id and a date the value brings are checked", () => {
	const made = new User({ name: "Jane" });

	expect(
		User.safeParse({ name: "Jane", id: "not-an-id" }).issues?.map(
			(issue) => issue.path,
		),
	).toEqual([["id"]]);
	expect(
		User.safeParse({ name: "Jane", createdAt: "yesterday" }).issues?.map(
			(issue) => issue.path,
		),
	).toEqual([["createdAt"]]);
	// One brought and one made: only the made one is kept unchecked.
	expect(
		User.safeParse({
			name: "Jane",
			id: made.id,
			createdAt: "yesterday",
		}).issues?.map((issue) => issue.path),
	).toEqual([["createdAt"]]);
	expect(User.safeParse({ name: "Jane", id: "NOT" }).issues).toHaveLength(1);
});

test("a builder that vouches for nothing has its id and its date checked", () => {
	const Identity = blueprintBuilderOf()(() => ({
		id: Id,
		createdAt: CreatedAt,
		updatedAt: UpdatedAt,
		deletedAt: DeletedAt,
	}));
	const badClock = entityBuilderOf({
		identity: Identity,
		generateId: () => "01a173d2-051c-77bb-8166-a371e999573e",
		now: () => "yesterday",
	});
	const badIds = entityBuilderOf({
		identity: Identity,
		generateId: () => "not-an-id",
		now: () => new Date().toISOString(),
	});
	class Late extends badClock(Named) {}
	class Nameless extends badIds(Named) {}

	expect(
		Late.safeParse({ name: "Jane" }).issues?.map((issue) => issue.path),
	).toEqual([["createdAt"]]);
	expect(
		Nameless.safeParse({ name: "Jane" }).issues?.map((issue) => issue.path),
	).toEqual([["id"]]);
});

test("what an entity vouches for does not reach the next record", () => {
	class Plain extends entityOf(Named) {}

	// A rejected entity made its id, and the record after it is checked whole.
	expect(User.safeParse({ name: 1 }).issues).toBeDefined();
	expect(
		Plain.safeParse({ name: "Jane", id: "not-an-id" }).issues?.map(
			(issue) => issue.path,
		),
	).toEqual([["id"]]);
});
