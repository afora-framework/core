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

	// A rejected entity made no id, and the record after it is checked whole.
	expect(User.safeParse({ name: 1 }).issues).toBeDefined();
	expect(
		Plain.safeParse({ name: "Jane", id: "not-an-id" }).issues?.map(
			(issue) => issue.path,
		),
	).toEqual([["id"]]);
});

/** The unix milliseconds a UUID v7 holds. */
const millisecondOf = (id: string) =>
	Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);

test("an id made with its createdAt holds the same millisecond, from one read of the clock", () => {
	const reads = Date.now;
	let count = 0;
	Date.now = () => {
		count++;
		return reads();
	};
	try {
		const user = new User({ name: "Jane" });
		expect(millisecondOf(user.id)).toBe(Date.parse(user.createdAt));
		expect(count).toBe(1);
		const parsed = User.safeParse({ name: "Ann" });
		if (parsed.issues) throw new Error("expected an entity");
		expect(millisecondOf(parsed.value.id)).toBe(
			Date.parse(parsed.value.createdAt),
		);
	} finally {
		Date.now = reads;
	}
});

test("an id made without a new createdAt reads the clock itself, never an old moment", () => {
	const old = new User({ name: "Jane" });
	const before = Date.now();
	// A createdAt brought by the value: the id is made now, not at `old`'s time.
	const user = new User({ name: "Ann", createdAt: old.createdAt });
	expect(millisecondOf(user.id)).toBeGreaterThanOrEqual(before);
	expect(user.createdAt).toBe(old.createdAt);
});

test("with a configured generator, an id made with createdAt comes from it", () => {
	let made = 0;
	configure({
		idGenerator: () =>
			`0190a6d6-7c4e-7b2a-9f3e-${String(++made).padStart(12, "0")}`,
	});
	const user = new User({ name: "Jane" });
	expect(user.id).toBe("0190a6d6-7c4e-7b2a-9f3e-000000000001");
});
