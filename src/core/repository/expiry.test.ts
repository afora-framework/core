import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
	blueprintOf,
	EntitySettings,
	entityOf,
	ImmutableEntityKey,
	InvalidEntityExpiry,
	InvalidRepositoryQuery,
	type IRepositoryProvider,
	inMemoryProvider,
	optionalOf,
	type RepositoryContext,
	type RepositoryQuery,
	RepositoryUniqueViolation,
	ReservedEntityKey,
	repositoryOf,
} from "../../index";

const DAY = 86_400_000;
const START = new Date("2026-01-01T00:00:00.000Z");

afterEach(() => {
	setSystemTime();
});

class AuditEvent extends entityOf(
	blueprintOf((ctx) => ({ action: ctx.string, key: ctx.string })),
	{
		name: "AuditEvent",
		unique: ["key"],
		expires: { after: { days: 400 } },
	},
) {}

class Window extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string, until: optionalOf(ctx.dateTime) })),
	{ name: "Window", expires: { at: "until" } },
) {}

describe("entityOf expires", () => {
	test("{ after } keeps createdAt + duration in a read-only expiresAt", () => {
		setSystemTime(START);
		const event = new AuditEvent({ action: "login", key: "a" });
		expect(event.expiresAt).toBe(
			new Date(START.getTime() + 400 * DAY).toISOString(),
		);
		expect(event.toJSON()).toMatchObject({ expiresAt: event.expiresAt });
		expect(AuditEvent.blueprint.properties).toHaveProperty("expiresAt");
		expect(() =>
			(event as unknown as { set(key: string, value: unknown): void }).set(
				"expiresAt",
				START.toISOString(),
			),
		).toThrow(ImmutableEntityKey);
		// Loaded with its own value, it keeps it.
		const loaded = new AuditEvent({
			...event.toJSON(),
			expiresAt: "2030-01-01T00:00:00.000Z",
		});
		expect(loaded.expiresAt).toBe("2030-01-01T00:00:00.000Z");
		// Loaded without one, it gets it from createdAt.
		const { expiresAt: _expiresAt, ...stored } = event.toJSON();
		expect(new AuditEvent(stored).expiresAt).toBe(event.expiresAt);
	});

	test("{ after } adds up every unit", () => {
		class Short extends entityOf(
			blueprintOf((ctx) => ({ n: ctx.integer })),
			{
				expires: { after: { days: 1, hours: 2, minutes: 3, seconds: 4.5 } },
			},
		) {}
		const short = new Short({ n: 1, createdAt: START.toISOString() });
		expect(short.expiresAt).toBe(
			new Date(
				START.getTime() + DAY + 2 * 3_600_000 + 3 * 60_000 + 4500,
			).toISOString(),
		);
	});

	test("{ at } uses the key of the blueprint and adds no expiresAt", () => {
		expect(Window.blueprint.properties).not.toHaveProperty("expiresAt");
		expect(
			(Window as unknown as Record<symbol, unknown>)[EntitySettings],
		).toEqual({
			versioned: false,
			expires: { at: "until" },
			schemaVersioned: false,
			schemaVersion: 1,
			upgrade: {},
			previousNames: [],
		});
	});

	test("an entity that does not expire may have a key named expiresAt", () => {
		class Token extends entityOf(
			blueprintOf((ctx) => ({ expiresAt: ctx.dateTime })),
			{ expires: { at: "expiresAt" } },
		) {}
		expect(Token.blueprint.properties).toHaveProperty("expiresAt");
	});

	test("rejects an invalid declaration", () => {
		const blueprint = blueprintOf((ctx) => ({
			name: ctx.string,
			until: ctx.dateTime,
			day: ctx.date,
			expiresAt: ctx.dateTime,
		}));
		const declare = (expires: unknown) => () =>
			entityOf(blueprint, { expires } as never);
		expect(() =>
			// @ts-expect-error: `at` takes a key of the blueprint
			entityOf(blueprint, { expires: { at: "missing" } }),
		).toThrow(InvalidEntityExpiry);
		expect(declare({ at: "name" })).toThrow(InvalidEntityExpiry);
		expect(declare({ at: "until" })).not.toThrow();
		expect(declare({ at: "day" })).not.toThrow();
		expect(declare({ after: {} })).toThrow(InvalidEntityExpiry);
		expect(declare({ after: { days: 0 } })).toThrow(InvalidEntityExpiry);
		expect(declare({ after: { days: -1 } })).toThrow(InvalidEntityExpiry);
		expect(declare({ after: { days: Number.POSITIVE_INFINITY } })).toThrow(
			InvalidEntityExpiry,
		);
		expect(declare({ after: { weeks: 1 } })).toThrow(InvalidEntityExpiry);
		expect(declare({ after: { toString: 1 } })).toThrow(InvalidEntityExpiry);
		expect(declare({ after: "1d" })).toThrow(InvalidEntityExpiry);
		expect(declare({})).toThrow(InvalidEntityExpiry);
		expect(declare({ at: "until", after: { days: 1 } })).toThrow(
			InvalidEntityExpiry,
		);
		// With `after`, expiresAt belongs to the identity.
		expect(declare({ after: { days: 1 } })).toThrow(ReservedEntityKey);
		expect(() =>
			entityOf(
				blueprintOf((ctx) => ({ name: ctx.string })),
				{
					expires: { after: { days: 1 } },
					change: ["expiresAt" as never],
				},
			),
		).toThrow(ImmutableEntityKey);
	});
});

describe("repositories of entities that expire", () => {
	const actions = [
		"create",
		"update",
		"delete",
		"count",
		"exists",
		"findMany",
		"findPage",
		"findCursor",
		"findById",
		"findByKey",
		"findManyByAction",
	] as const;

	async function seeded() {
		const Events = repositoryOf({ entity: AuditEvent, actions });
		setSystemTime(START);
		const old = await Events.create({ action: "login", key: "old" });
		setSystemTime(new Date(START.getTime() + 300 * DAY));
		const recent = await Events.create({ action: "login", key: "recent" });
		setSystemTime(new Date(START.getTime() + 500 * DAY));
		return { Events, old, recent };
	}

	test("every read leaves expired records out", async () => {
		const { Events, old, recent } = await seeded();
		expect((await Events.findMany()).map((e) => e.key)).toEqual(["recent"]);
		expect(await Events.count()).toBe(1);
		expect(await Events.exists({ where: { key: "old" } })).toBe(false);
		expect(await Events.findById(old.id)).toBe(undefined);
		expect(await Events.findByKey("old")).toBe(undefined);
		expect((await Events.findById(recent.id))?.key).toBe("recent");
		expect((await Events.findManyByAction("login")).length).toBe(1);
		const page = await Events.findPage();
		expect(page.total).toBe(1);
		expect(page.items.map((e) => e.key)).toEqual(["recent"]);
		const cursor = await Events.findCursor({ limit: 1 });
		expect(cursor.items.map((e) => e.key)).toEqual(["recent"]);
		expect(cursor.next).toBe(undefined);
	});

	test("expires exactly at its date", async () => {
		const { Events, recent } = await seeded();
		setSystemTime(new Date(recent.expiresAt));
		expect(await Events.count()).toBe(0);
		setSystemTime(new Date(Date.parse(recent.expiresAt) - 1));
		expect(await Events.count()).toBe(1);
	});

	test("withExpired gives them back", async () => {
		const { Events } = await seeded();
		const all: RepositoryQuery<typeof AuditEvent> = { withExpired: true };
		expect(await Events.count(all)).toBe(2);
		expect((await Events.findMany(all)).map((e) => e.key)).toEqual([
			"old",
			"recent",
		]);
		expect((await Events.findPage(all)).total).toBe(2);
		const first = await Events.findCursor({ withExpired: true, limit: 1 });
		expect(first.items.map((e) => e.key)).toEqual(["old"]);
		const second = await Events.findCursor({
			withExpired: true,
			limit: 1,
			after: first.next,
		});
		expect(second.items.map((e) => e.key)).toEqual(["recent"]);
		expect(
			await Events.exists({ where: { key: "old" }, withExpired: true }),
		).toBe(true);
	});

	test("rejects a withExpired that is not boolean", async () => {
		const { Events } = await seeded();
		await expect(
			Events.findMany({ withExpired: "yes" } as never),
		).rejects.toThrow(InvalidRepositoryQuery);
	});

	test("unique keys still count expired records", async () => {
		const { Events } = await seeded();
		await expect(Events.create({ action: "x", key: "old" })).rejects.toThrow(
			RepositoryUniqueViolation,
		);
	});

	test("update and delete of an expired entity work on the entity", async () => {
		const { Events, old } = await seeded();
		await Events.update(old);
		await Events.delete(old);
		expect(await Events.count({ withExpired: true })).toBe(1);
	});

	test("{ at } expires on the date of the key, and never without one", async () => {
		const Windows = repositoryOf({
			entity: Window,
			actions: ["create", "findMany", "count"],
		});
		setSystemTime(START);
		await Windows.create({
			name: "past",
			until: new Date(START.getTime() - 1).toISOString(),
		});
		await Windows.create({
			name: "future",
			until: new Date(START.getTime() + DAY).toISOString(),
		});
		await Windows.create({ name: "always" });
		expect((await Windows.findMany()).map((w) => w.name)).toEqual([
			"future",
			"always",
		]);
		setSystemTime(new Date(START.getTime() + 2 * DAY));
		expect((await Windows.findMany()).map((w) => w.name)).toEqual(["always"]);
		expect(await Windows.count({ withExpired: true })).toBe(3);
	});

	test("gives the provider the expiry key, now and withExpired", async () => {
		const seen: { context: RepositoryContext; query: unknown }[] = [];
		const base = inMemoryProvider();
		const provider: IRepositoryProvider = {
			...base,
			capabilities: base.capabilities,
			findMany: (context, query) => {
				seen.push({ context, query });
				return base.findMany(context, query);
			},
		};
		const Events = repositoryOf({
			entity: AuditEvent,
			actions: ["findMany"],
			provider,
		});
		setSystemTime(START);
		await Events.findMany();
		expect(seen[0]?.context.expiry).toEqual({ key: "expiresAt" });
		expect(seen[0]?.query).toMatchObject({
			withExpired: false,
			now: START.toISOString(),
		});
	});

	test("an entity that does not expire gives no expiry, now nor withExpired", async () => {
		class Plain extends entityOf(blueprintOf((ctx) => ({ n: ctx.integer }))) {}
		const seen: unknown[] = [];
		const base = inMemoryProvider();
		const Plains = repositoryOf({
			entity: Plain,
			actions: ["findMany"],
			provider: {
				...base,
				findMany: (context, query) => {
					seen.push(context.expiry, query);
					return base.findMany(context, query);
				},
			},
		});
		await Plains.findMany();
		expect(seen).toEqual([undefined, { withDeleted: true }]);
	});

	test("needs a provider with capabilities.expiry", async () => {
		const base = inMemoryProvider();
		const Events = repositoryOf({
			entity: AuditEvent,
			actions: ["create", "findMany", "count", "findCursor"],
			provider: {
				...base,
				capabilities: { transactions: true, keyset: true },
			},
		});
		// Writes do not read.
		await Events.create({ action: "login", key: "a" });
		await expect(Events.findMany()).rejects.toThrow(InvalidRepositoryQuery);
		await expect(Events.count()).rejects.toThrow(InvalidRepositoryQuery);
		await expect(Events.findCursor()).rejects.toThrow(InvalidRepositoryQuery);
	});

	test("relations load expired references", async () => {
		class Note extends entityOf(
			blueprintOf(() => ({ event: AuditEvent })),
			{ name: "Note" },
		) {}
		const Events = repositoryOf({
			entity: AuditEvent,
			actions: ["create", "findById"],
		});
		const Notes = repositoryOf({
			entity: Note,
			actions: ["create", "findMany"],
			relations: [Events],
		});
		setSystemTime(START);
		const event = await Events.create({ action: "login", key: "a" });
		await Notes.create({ event });
		setSystemTime(new Date(START.getTime() + 500 * DAY));
		expect(await Events.findById(event.id)).toBe(undefined);
		const [note] = await Notes.findMany();
		expect(note?.event.id).toBe(event.id);
	});
});
