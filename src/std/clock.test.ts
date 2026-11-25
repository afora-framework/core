import { afterEach, describe, expect, test } from "bun:test";
import { jwtOf } from "../adapters";
import {
	Archivable,
	blueprintOf,
	configure,
	DateTime,
	entityOf,
	Id,
	inMemoryProvider,
	Publishable,
	repositoryOf,
	resetRuntime,
} from "../index";
import { manualClock } from "../testing";
import { uuidv7 } from "./runtime";

const START = "2026-03-01T12:00:00.000Z";
const secret = "a-secret-of-at-least-thirty-two-characters";

afterEach(() => resetRuntime());

class Note extends entityOf(blueprintOf((ctx) => ({ title: ctx.string }))) {}
class Tick extends entityOf(
	blueprintOf((ctx) => ({ n: ctx.integer })),
	{
		expires: { after: { minutes: 10 } },
	},
) {}

describe("configure({ clock })", () => {
	test("drives the stamps of an entity, and the cache follows the clock", () => {
		const clock = manualClock(START);
		configure({ clock });
		const note = new Note({ title: "a" });
		expect(note.createdAt).toBe(START);
		expect(new Note({ title: "b" }).createdAt).toBe(START);
		clock.advance({ hours: 1 });
		expect(new Note({ title: "c" }).createdAt).toBe("2026-03-01T13:00:00.000Z");
	});

	test("drives the time of the default ids", () => {
		configure({ clock: manualClock(START) });
		const at = Date.parse(START);
		expect(
			new Note({ title: "a" }).id.startsWith(Id.generate().value.slice(0, 8)),
		).toBe(true);
		expect(Id.generate().value.replaceAll("-", "").slice(0, 12)).toBe(
			at.toString(16).padStart(12, "0"),
		);
	});

	test("a clock going back does not reorder ids", () => {
		const clock = manualClock(START);
		configure({ clock });
		const first = uuidv7();
		clock.advance(-60_000);
		const second = uuidv7();
		expect(second > first).toBe(true);
	});

	test("drives publish, archive and DateTime.now", () => {
		configure({ clock: manualClock(START) });
		class Post extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string })),
			{ plugins: [Publishable, Archivable] },
		) {}
		const post = new Post({ title: "a" });
		post.publish();
		post.archive();
		expect(post.publishedAt).toBe(START);
		expect(post.archivedAt).toBe(START);
		expect(DateTime.now().value).toBe(START);
	});

	test("drives the claims of a token and their checks", async () => {
		const clock = manualClock(START);
		configure({ clock });
		const jwt = jwtOf({ secret });
		const token = await jwt.sign({ subject: "u1" });
		const payload = JSON.parse(
			atob(
				(token.split(".")[1] as string)
					.replaceAll("-", "+")
					.replaceAll("_", "/"),
			),
		);
		expect(payload.iat).toBe(Date.parse(START) / 1000);
		expect(payload.exp).toBe(payload.iat + 900);
		expect(await jwt.verify(token)).toMatchObject({ subject: "u1" });
		clock.advance({ minutes: 16 });
		await expect(jwt.verify(token)).rejects.toThrow();
	});

	test("drives the expiry of a query", async () => {
		const clock = manualClock(START);
		configure({ clock });
		const Ticks = repositoryOf({
			entity: Tick,
			actions: ["create", "count"],
			provider: inMemoryProvider(),
		});
		await Ticks.create(new Tick({ n: 1 }));
		expect(await Ticks.count()).toBe(1);
		clock.advance({ minutes: 11 });
		expect(await Ticks.count()).toBe(0);
		expect(await Ticks.count({ withExpired: true })).toBe(1);
	});

	test("drives the until deadline of a walk", async () => {
		const clock = manualClock(START);
		configure({ clock });
		const Notes = repositoryOf({
			entity: Note,
			actions: ["create", "forEachPage"],
			provider: inMemoryProvider(),
		});
		await Notes.create(new Note({ title: "a" }));
		const until = clock() + 1000;
		let pages = 0;
		const result = await Notes.forEachPage(
			{},
			() => {
				pages++;
			},
			{ until },
		);
		expect(result.done).toBe(true);
		clock.advance(2000);
		const late = await Notes.forEachPage(
			{},
			() => {
				pages++;
			},
			{ until },
		);
		expect(late).toMatchObject({ done: false, pages: 0 });
		expect(pages).toBe(1);
	});

	test("resetRuntime gives the platform clock back", () => {
		configure({ clock: manualClock(START) });
		resetRuntime();
		expect(Date.parse(new Note({ title: "a" }).createdAt)).toBeGreaterThan(
			Date.parse(START),
		);
	});
});
