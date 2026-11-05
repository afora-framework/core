import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	blueprintOf,
	type EventDefinition,
	entityOf,
	eventOf,
	recordOf,
} from "../../index";

const Blueprint = blueprintOf((ctx) => ({ name: ctx.string }));
const ID = "01a173d2-051c-77bb-8166-a371e999573e";
const createdAt = "2026-01-01T00:00:00.000Z";

class User extends entityOf(Blueprint, {
	change: ["name"],
	onCreate: () => Created,
	onUpdate: () => [Updated, Updated],
	onDelete: () => Deleted,
}) {
	publish(event: EventDefinition): void {
		this.emit(event);
	}
	greet(): string {
		return this.name;
	}
	invalid(): void {
		this.set("id", ID);
	}
}
const Created: EventDefinition = eventOf("created", User, async (user) => {
	expectTypeOf(user).toEqualTypeOf<User>();
});
const Updated: EventDefinition = eventOf("updated", User, async () => {});
const Deleted: EventDefinition = eventOf("deleted", User, async () => {});

function loaded(): User {
	return new User({ name: "Jane", id: ID, createdAt });
}

describe("entity events", () => {
	test("queues synchronously, preserves duplicates and order, drains and isolates", async () => {
		const calls: User[] = [];
		const Manual = eventOf("manual", User, async (user) => {
			calls.push(user);
		});
		const user = loaded();
		const other = loaded();
		user.publish(Manual);
		user.publish(Manual);
		user.publish(Updated);
		expect(calls).toEqual([]);
		expect(other.pullEvents()).toEqual([]);
		const events = user.pullEvents();
		expect(events.map((event) => event.name)).toEqual([
			"manual",
			"manual",
			"updated",
		]);
		expect(user.pullEvents()).toEqual([]);
		user.publish(Manual);
		expect(user.pullEvents()).toHaveLength(1);
		for (const event of events) await event.handle();
		expect(calls).toEqual([user, user]);
		expect(events[0]?.entity).toBe(user);
		expect(Object.isFrozen(Manual)).toBe(true);
	});

	test("handles the original subclass with its current state, and allows repeat handling", async () => {
		class Admin extends User {
			role = "admin";
		}
		const user = new Admin({ name: "Jane", id: ID });
		let calls = 0;
		const Event = eventOf("admin", Admin, async (entity) => {
			expect(entity).toBe(user);
			expect(entity.greet()).toBe("Ann");
			expect(entity.role).toBe("admin");
			calls++;
		});
		user.publish(Event);
		user.publish(Updated); // A base-class event accepts a subclass.
		const [event] = user.pullEvents();
		user.change.name("Ann");
		await event?.handle();
		await event?.handle();
		expect(calls).toBe(2);
	});

	test("propagates asynchronous handler failures", async () => {
		const failure = new Error("failed");
		const Event = eventOf("failure", User, async () => {
			throw failure;
		});
		const user = loaded();
		user.publish(Event);
		await expect(user.pullEvents()[0]?.handle()).rejects.toBe(failure);
	});

	test("validates event classes, definitions and instance compatibility", () => {
		class Record extends recordOf(Blueprint) {}
		// @ts-expect-error records are not entity classes
		expect(() => eventOf("record", Record, async () => {})).toThrow(TypeError);
		expect(() => eventOf("invalid", {} as never, async () => {})).toThrow(
			TypeError,
		);
		class Other extends entityOf(Blueprint) {}
		const Event = eventOf("other", Other, async () => {});
		const user = loaded();
		expect(() => user.publish(Event)).toThrow(TypeError);
		expect(() => user.publish({ name: "fake" } as EventDefinition)).toThrow(
			TypeError,
		);
		expect(user.pullEvents()).toEqual([]);
	});

	test("creation only applies to entirely new identity, including parsing", () => {
		expect(new User({ name: "Jane" }).pullEvents().map((e) => e.name)).toEqual([
			"created",
		]);
		for (const identity of [{ id: ID }, { createdAt }, { id: ID, createdAt }]) {
			expect(new User({ name: "Jane", ...identity }).pullEvents()).toEqual([]);
		}
		const parsed = User.safeParse({ name: "Jane" });
		if (parsed.issues) throw new Error("parse failed");
		expect(parsed.value.pullEvents()).toHaveLength(1);
		const existing = User.safeParse({ name: "Jane", id: ID });
		if (existing.issues) throw new Error("parse failed");
		expect(existing.value.pullEvents()).toEqual([]);
		expect(User.safeParse({ name: 1 }).issues).toBeDefined();
		const user = loaded();
		const same = User.safeParse(user);
		if (same.issues) throw new Error("parse failed");
		expect(same.value).toBe(user);
		expect(user.pullEvents()).toEqual([]);
	});

	test("invalid operations enqueue nothing; valid equal values and deletion enqueue", () => {
		const user = loaded();
		expect(() => user.change.name(1 as never)).toThrow();
		expect(() => user.invalid()).toThrow();
		expect(user.pullEvents()).toEqual([]);
		user.change.name("Jane");
		expect(user.updatedAt).toBeDefined();
		user.destroy();
		expect(user.deletedAt).toBeDefined();
		expect(() => user.destroy()).toThrow();
		expect(() => user.change.name("Ann")).toThrow();
		expect(user.pullEvents().map((e) => e.name)).toEqual([
			"updated",
			"updated",
			"deleted",
		]);
	});

	test("accepts direct definitions and lists, and preserves hook order", () => {
		const order: string[] = [];
		const Base = entityOf(Blueprint);
		const Event = eventOf("base", Base, async () => {});
		class Hooks extends entityOf(Blueprint, {
			onCreate: Event,
			onUpdate: [Event],
			onDelete: Event,
		}) {}
		// Unrelated entities cannot emit the base's event, even from a lifecycle.
		expect(() => new Hooks({ name: "Jane" })).toThrow(TypeError);
		const Any = eventOf("hook", User, async () => {});
		class HookUser extends User {
			protected override onSetAll(): void {
				expect(this.updatedAt).toBeDefined();
				expect(this.pullEvents()).toHaveLength(2);
				order.push("all");
			}
			protected override onSet() {
				return {
					name: () => {
						order.push("key");
						this.publish(Any);
						throw new Error("hook");
					},
				};
			}
			protected override onDestroy(): void {
				throw new Error("destroy");
			}
		}
		const user = new HookUser({ name: "Jane", id: ID });
		expect(() => user.change.name("Ann")).toThrow("hook");
		expect(order).toEqual(["all", "key"]);
		expect(user.name).toBe("Ann");
		expect(user.pullEvents()).toHaveLength(1);
		expect(() => user.destroy()).toThrow("destroy");
		expect(user.pullEvents().map((e) => e.name)).toEqual(["deleted"]);
	});

	test("retains lifecycle events when update hooks throw", () => {
		class Throwing extends User {
			protected override onSetAll(): void {
				throw new Error("hook");
			}
		}
		const user = new Throwing({ name: "Jane", id: ID });
		expect(() => user.change.name("Ann")).toThrow("hook");
		expect(user.name).toBe("Ann");
		expect(user.pullEvents().map((event) => event.name)).toEqual([
			"updated",
			"updated",
		]);
	});

	test("resolves references only in their cycle after validation and accepts direct lists", () => {
		let calls = 0;
		const events: EventDefinition[] = [];
		class Listed extends entityOf(Blueprint, {
			change: ["name"],
			onCreate: events,
			onUpdate: () => {
				calls++;
				return events;
			},
			onDelete: events,
		}) {}
		expect(calls).toBe(0);
		events.push(eventOf("listed", Listed, async () => {}));
		const user = new Listed({ name: "Jane" });
		expect(user.pullEvents()).toHaveLength(1);
		expect(() => user.change.name(1 as never)).toThrow();
		expect(calls).toBe(0);
		user.change.name("Ann");
		expect(calls).toBe(1);
		user.destroy();
		expect(user.pullEvents()).toHaveLength(2);
	});

	test("reserves entity event members without changing record fields or serialization", () => {
		for (const key of ["emit", "pullEvents"]) {
			const blueprint = blueprintOf((ctx) => ({ [key]: ctx.string }));
			expect(() => entityOf(blueprint)).toThrow();
			const Record = recordOf(blueprint);
			expect(new Record({ [key]: "allowed" }).toJSON()).toEqual({
				[key]: "allowed",
			});
		}
		const user = loaded();
		const json = JSON.stringify(user);
		user.publish(Created);
		expect(JSON.stringify(user)).toBe(json);
		expect(user.toJSON()).toEqual({ name: "Jane", id: ID, createdAt });
	});
});

// Compile-only checks; never invoke protected members at runtime.
function _types(user: User): void {
	// @ts-expect-error emit is protected
	user.emit(Created);
	// @ts-expect-error handlers must return Promise<void>
	eventOf("sync", User, () => {});
	// @ts-expect-error handlers must resolve to void
	eventOf("value", User, async () => 1);
	// @ts-expect-error generated change methods preserve value types
	user.change.name(123);
	const [event] = user.pullEvents();
	if (event) expectTypeOf(event.entity).toEqualTypeOf<User>();
}
