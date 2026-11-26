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

class Lesson extends entityOf(
	blueprintOf((ctx) => ({
		moduleId: ctx.string,
		title: ctx.string,
		position: ctx.integer,
		note: ctx.optional.string,
	})),
) {}

function domain() {
	return repositoryOf({
		entity: Lesson,
		provider: inMemoryProvider(),
		actions: ["create", "findPage", "count"],
	});
}

const ctx = StdUseCases.context;

function command(Lessons: ReturnType<typeof domain>) {
	return commandOf({
		name: "Course",
		useCases: (ctx) => ({
			add: ctx.create(Lessons, {
				computed: ["position"],
				dependencies: { lessons: Lessons },
				before: async ({ input, dependencies }) => ({
					...input,
					position: await dependencies.lessons.count({
						where: { moduleId: input.moduleId },
					}),
				}),
			}),
		}),
	});
}

describe("create with computed keys", () => {
	test("before gives the required key, which the input does not take", async () => {
		const Lessons = domain();
		const Course = command(Lessons);
		const first = await Course.run("add", { moduleId: "m1", title: "a" });
		const second = await Course.run("add", { moduleId: "m1", title: "b" });
		const other = await Course.run("add", { moduleId: "m2", title: "c" });
		expect([
			first.item.position,
			second.item.position,
			other.item.position,
		]).toEqual([0, 1, 0]);
		expectTypeOf<Parameters<typeof Course.run<"add">>[1]>().toEqualTypeOf<{
			readonly moduleId: string;
			readonly title: string;
			readonly note?: string | undefined;
		}>();
	});

	test("the key is not part of the input of the description", () => {
		const Lessons = domain();
		const App = applicationOf({
			name: "school",
			entities: { Lesson },
			repositories: { Lessons },
			commands: { Course: command(Lessons) },
		});
		const { useCases } = App.describe();
		const add = useCases.CreateLesson;
		expect(Object.keys(add?.input ?? {})).toEqual([
			"moduleId",
			"title",
			"note",
		]);
		expect(add?.generic?.options).toMatchObject({ computed: ["position"] });
	});

	test("a before that forgets the key is a validation error naming it", async () => {
		const Lessons = domain();
		const Course = commandOf({
			name: "Course",
			useCases: (ctx) => ({
				add: ctx.create(Lessons, {
					computed: ["position"],
					before: (({ input }: { input: object }) => ({ ...input })) as never,
				}),
			}),
		});
		const error = await Course.run("add", { moduleId: "m1", title: "a" }).then(
			() => undefined,
			(thrown: unknown) => thrown as Error,
		);
		expect(error).toBeDefined();
		expect(JSON.stringify(error) + String(error?.message)).toContain(
			"position",
		);
	});

	test("an input that gives the key is refused", async () => {
		const Lessons = domain();
		const Course = command(Lessons);
		await expect(
			Course.run("add", { moduleId: "m1", title: "a", position: 9 } as never),
		).rejects.toThrow();
	});
});

describe("computed, at declaration", () => {
	const Lessons = domain();
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

	test("computed without before", () => {
		expect(
			unavailable(() => ctx.create(Lessons, { computed: ["position"] })),
		).toContain("before");
	});

	test("an unknown key, an identity key, a key also in omit or values", () => {
		const before = ({ input }: { input: unknown }) => input as never;
		expect(
			unavailable(() =>
				ctx.create(Lessons, { computed: ["nope" as never], before }),
			),
		).toContain("nope");
		expect(
			unavailable(() => ctx.create(Lessons, { computed: ["id"], before })),
		).toContain("identity");
		expect(
			unavailable(() =>
				ctx.create(Lessons, { computed: ["note"], omit: ["note"], before }),
			),
		).toContain("omit");
		expect(
			unavailable(() =>
				ctx.create(Lessons, {
					computed: ["position"],
					values: { position: 1 },
					before,
				}),
			),
		).toContain("values");
	});

	test("register does not take it", () => {
		expect(() =>
			// @ts-expect-error computed is an option of create
			ctx.register(Lessons, { computed: ["position"] }),
		).toThrow();
	});
});
