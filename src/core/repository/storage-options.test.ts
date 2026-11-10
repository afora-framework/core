import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
	blueprintOf,
	entityOf,
	inMemoryProvider,
	RepositoryConcurrencyConflict,
	repositoryOf,
} from "../../index";

// Versioned entities (#44), atomic increment (#34), expiry (#35) and the page
// walker (#37) together, where one feature changes what another one sees.

const START = new Date("2026-06-01T12:00:00.000Z");
const MINUTE = 60_000;

afterEach(() => {
	setSystemTime();
});

class Session extends entityOf(
	blueprintOf((ctx) => ({ user: ctx.string, hits: ctx.integer })),
	{
		name: "Session",
		change: ["hits"],
		versioned: true,
		expires: { after: { minutes: 10 } },
	},
) {}

function sessions() {
	return repositoryOf({
		entity: Session,
		actions: [
			"create",
			"update",
			"increment",
			"findById",
			"findMany",
			"forEachPage",
		],
		provider: inMemoryProvider(),
	});
}

describe("versioned and expiring entities", () => {
	test("keep both identity keys, and update checks the version", async () => {
		setSystemTime(START);
		const Sessions = sessions();
		const session = await Sessions.create(new Session({ user: "a", hits: 0 }));
		expect(session.version).toBe(1);
		expect(session.expiresAt).toBe(
			new Date(START.getTime() + 10 * MINUTE).toISOString(),
		);

		const stale = await Sessions.findById(session.id);
		session.change.hits(1);
		const saved = await Sessions.update(session);
		expect(saved.version).toBe(2);
		// The version bump keeps the expiry the entity was created with.
		expect(saved.expiresAt).toBe(session.expiresAt);

		stale?.change.hits(5);
		const error = await Sessions.update(stale as Session).catch((e) => e);
		expect(error).toBeInstanceOf(RepositoryConcurrencyConflict);
	});

	test("an increment bumps the version, then the record expires", async () => {
		setSystemTime(START);
		const Sessions = sessions();
		const session = await Sessions.create(new Session({ user: "a", hits: 0 }));
		const next = await Sessions.increment(session, { hits: 2 });
		expect([next.hits, next.version]).toEqual([2, 2]);

		setSystemTime(new Date(START.getTime() + 11 * MINUTE));
		expect(await Sessions.findById(session.id)).toBeUndefined();
		expect(
			(await Sessions.findMany({ withExpired: true })).map((s) => s.hits),
		).toEqual([2]);
	});
});

describe("forEachPage and expiry", () => {
	test("walks only live records, and sees records expire between pages", async () => {
		const Sessions = sessions();
		// Five sessions, created a minute apart: they expire a minute apart too.
		for (let index = 0; index < 5; index++) {
			setSystemTime(new Date(START.getTime() + index * MINUTE));
			await Sessions.create(new Session({ user: `u${index}`, hits: index }));
		}

		setSystemTime(new Date(START.getTime() + 10 * MINUTE + 1));
		const live: string[] = [];
		const result = await Sessions.forEachPage(
			{ orderBy: [{ key: "user", direction: "asc" }], limit: 2 },
			(items) => {
				live.push(...items.map((s) => s.user));
			},
		);
		// u0 expired at exactly +10 min.
		expect(live).toEqual(["u1", "u2", "u3", "u4"]);
		expect(result).toMatchObject({ done: true, items: 4, pages: 2 });

		// The clock is read per page: u1 and u2 expire after the first page.
		setSystemTime(new Date(START.getTime() + 10 * MINUTE + 1));
		const walked: string[] = [];
		await Sessions.forEachPage(
			{ orderBy: [{ key: "user", direction: "asc" }], limit: 1 },
			(items) => {
				walked.push(...items.map((s) => s.user));
				if (walked.length === 1) {
					setSystemTime(new Date(START.getTime() + 12 * MINUTE + 1));
				}
			},
		);
		expect(walked).toEqual(["u1", "u3", "u4"]);

		const everything: string[] = [];
		await Sessions.forEachPage(
			{
				orderBy: [{ key: "user", direction: "asc" }],
				limit: 2,
				withExpired: true,
			},
			(items) => {
				everything.push(...items.map((s) => s.user));
			},
		);
		expect(everything).toEqual(["u0", "u1", "u2", "u3", "u4"]);
	});

	test("increments every page atomically, each bumping the version", async () => {
		setSystemTime(START);
		const Sessions = sessions();
		for (let index = 0; index < 5; index++) {
			await Sessions.create(new Session({ user: `u${index}`, hits: 0 }));
		}
		const result = await Sessions.forEachPage({ limit: 2 }, async (items) => {
			await Promise.all(
				items.map((session) => Sessions.increment(session, { hits: 1 })),
			);
		});
		expect(result).toMatchObject({ done: true, items: 5 });
		const all = await Sessions.findMany();
		expect(all.map((s) => [s.hits, s.version])).toEqual(
			Array.from({ length: 5 }, () => [1, 2]),
		);
	});
});
