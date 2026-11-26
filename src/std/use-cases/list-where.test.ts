import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	entityOf,
	inMemoryProvider,
	repositoryOf,
	StdUseCases,
} from "../../index";
import { spyProvider } from "../../testing";

class Lesson extends entityOf(
	blueprintOf((ctx) => ({
		moduleId: ctx.string,
		kind: ctx.string,
		title: ctx.string,
		position: ctx.integer,
		note: ctx.optional.string,
	})),
	{ plugins: (ctx) => [ctx.ownable] },
) {}

class Tagged extends entityOf(
	blueprintOf((ctx) => ({
		labels: ctx.listOf(ctx.string),
		owner: Lesson,
	})),
) {}

function domain(
	provider: ReturnType<typeof inMemoryProvider> = inMemoryProvider(),
) {
	const Lessons = repositoryOf({
		entity: Lesson,
		provider,
		actions: ["findPage", "create"],
		indexes: { byModule: { where: ["moduleId"], orderBy: "position" } },
	});
	return { Lessons };
}

const ana = "0190a6a0-0000-7000-8000-00000000000a";
const bob = "0190a6a0-0000-7000-8000-00000000000b";

async function seed(Lessons: ReturnType<typeof domain>["Lessons"]) {
	const make = (moduleId: string, position: number, ownerId = ana) =>
		Lessons.create(
			new Lesson({
				moduleId,
				kind: "video",
				title: `${moduleId}-${position}`,
				position,
				ownerId,
			}),
		);
	await make("m1", 2);
	await make("m1", 1);
	await make("m1", 3, bob);
	await make("m2", 1);
}

describe("list with where", () => {
	test("takes each key as a required input and answers only those entities", async () => {
		const { Lessons } = domain();
		await seed(Lessons);
		const Course = commandOf({
			name: "Course",
			useCases: (ctx) => ({
				lessons: ctx.list(Lessons, {
					where: ["moduleId"],
					orderBy: [{ key: "position" }],
				}),
			}),
		});
		const page = await Course.run("lessons", { moduleId: "m1" });
		expect(page.items.map((lesson) => lesson.title)).toEqual([
			"m1-1",
			"m1-2",
			"m1-3",
		]);
		expect(page.total).toBe(3);
		expect((await Course.run("lessons", { moduleId: "m2" })).total).toBe(1);
		expect((await Course.run("lessons", { moduleId: "none" })).total).toBe(0);
		expectTypeOf<Parameters<typeof Course.run<"lessons">>[1]>().toMatchTypeOf<{
			moduleId: string;
		}>();
		// @ts-expect-error moduleId is required
		await Course.run("lessons", {}).catch(() => undefined);
	});

	test("SEC-46: a missing value is invalid input and never reaches the query", async () => {
		const spy = spyProvider(inMemoryProvider());
		const { Lessons } = domain(spy);
		await seed(Lessons);
		spy.reset();
		const Course = commandOf({
			name: "Course",
			useCases: (ctx) => ({
				lessons: ctx.list(Lessons, { where: ["moduleId"] }),
			}),
		});
		for (const moduleId of [undefined, null]) {
			await expect(
				Course.run("lessons", { moduleId } as never),
			).rejects.toThrow();
		}
		await expect(Course.run("lessons", {} as never)).rejects.toThrow();
		expect(spy.calls("Lesson")).toEqual([]);
	});

	test("works with owner, several keys and maxLimit", async () => {
		const { Lessons } = domain();
		await seed(Lessons);
		const mine = { context: "userId" } as const;
		const Course = commandOf({
			name: "Course",
			useCases: (ctx) => ({
				lessons: ctx.list(Lessons, {
					where: ["moduleId", "kind"],
					owner: mine,
					maxLimit: 2,
					orderBy: [{ key: "position", direction: "desc" }],
				}),
			}),
		});
		const page = await Course.run(
			"lessons",
			{ moduleId: "m1", kind: "video", limit: 2 },
			{ context: { userId: ana } },
		);
		expect(page.items.map((lesson) => lesson.title)).toEqual(["m1-2", "m1-1"]);
		expect(page.total).toBe(2);
		await expect(
			Course.run(
				"lessons",
				{ moduleId: "m1", kind: "video", limit: 3 },
				{ context: { userId: ana } },
			),
		).rejects.toThrow();
		expect(
			(
				await Course.run(
					"lessons",
					{ moduleId: "m1", kind: "text" },
					{ context: { userId: ana } },
				)
			).total,
		).toBe(0);
	});

	test("describe() gives the option and names the index that serves it", () => {
		const { Lessons } = domain();
		const Course = commandOf({
			name: "Course",
			useCases: (ctx) => ({
				ordered: ctx.list(Lessons, {
					name: "Ordered",
					where: ["moduleId"],
					orderBy: [{ key: "position" }],
				}),
				newest: ctx.list(Lessons, { name: "Newest", where: ["moduleId"] }),
				byKind: ctx.list(Lessons, { name: "ByKind", where: ["kind"] }),
			}),
		});
		const App = applicationOf({
			name: "school",
			entities: { Lesson },
			repositories: { Lessons },
			commands: { Course },
		});
		const { useCases } = App.describe();
		expect(useCases.Ordered?.generic?.options).toMatchObject({
			where: ["moduleId"],
		});
		expect(useCases.Ordered?.generic?.index).toBe("byModule");
		expect(useCases.Newest?.generic?.index).toBeUndefined();
		expect(useCases.ByKind?.generic?.index).toBeUndefined();
	});
});

describe("list where, at declaration", () => {
	const { Lessons } = domain();
	const Tags = repositoryOf({
		entity: Tagged,
		provider: inMemoryProvider(),
		actions: ["findPage"],
		relations: [Lessons],
	});
	const unavailable = (make: () => unknown): string => {
		try {
			make();
		} catch (error) {
			const thrown = error as { name: string; message: string };
			if (thrown.name === "UseCaseUnavailable") return thrown.message;
			throw error;
		}
		throw new Error("Expected UseCaseUnavailable.");
	};
	const ctx = StdUseCases.context;

	test("an unknown key", () => {
		// @ts-expect-error nope is not a key of Lesson
		expect(unavailable(() => ctx.list(Lessons, { where: ["nope"] }))).toContain(
			"nope",
		);
	});

	test("a key that is not scalar", () => {
		expect(unavailable(() => ctx.list(Tags, { where: ["labels"] }))).toContain(
			"scalar",
		);
		expect(unavailable(() => ctx.list(Tags, { where: ["owner"] }))).toContain(
			"scalar",
		);
	});

	test("an optional key, which the input could leave out", () => {
		expect(unavailable(() => ctx.list(Lessons, { where: ["note"] }))).toContain(
			"required",
		);
	});

	test("a list that is not made of keys, a repeated key, the owner key, a page key", () => {
		expect(
			unavailable(() =>
				// @ts-expect-error a list of keys
				ctx.list(Lessons, { where: "moduleId" }),
			),
		).toContain("list of keys");
		expect(
			unavailable(() => ctx.list(Lessons, { where: ["moduleId", "moduleId"] })),
		).toContain("twice");
		expect(
			unavailable(() =>
				ctx.list(Lessons, {
					where: ["ownerId"],
					owner: { context: "userId" },
				}),
			),
		).toContain("owner");
	});
});
