import { describe, expect, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	type EventDefinition,
	entityOf,
	eventOf,
	InvalidRepositoryDeclaration,
	inMemoryProvider,
	openapi,
	outputOf,
	RepositoryDeleteRestricted,
	repositoryOf,
	UnregisteredRepositoryDependency,
	wrapProvider,
} from "../../index";
import { statusOf } from "../output/status";

class Course extends entityOf(blueprintOf((ctx) => ({ title: ctx.string }))) {}
class Module extends entityOf(
	blueprintOf((ctx) => ({ courseId: ctx.string, title: ctx.string })),
) {}
class Lesson extends entityOf(
	blueprintOf((ctx) => ({ moduleId: ctx.string, title: ctx.string })),
	{ onDelete: () => LessonDeleted },
) {}
const LessonDeleted: EventDefinition = eventOf("LessonDeleted", Lesson);
type OnDelete = "cascade" | "restrict";

/** A course, its modules and their lessons, each level deleting as it is told. */
function tree(
	options: {
		readonly modules?: "hard" | "soft";
		readonly lessons?: "hard" | "soft";
		readonly courses?: "hard" | "soft";
		readonly lessonsOnDelete?: OnDelete;
		readonly provider?: ReturnType<typeof inMemoryProvider>;
	} = {},
) {
	const Courses = repositoryOf({
		entity: Course,
		actions: ["create", "findById", "delete", "findMany"],
		deletion: options.courses ?? "hard",
	});
	const Modules = repositoryOf({
		entity: Module,
		actions: ["create", "findMany", "count"],
		deletion: options.modules ?? "hard",
		parents: { courseId: { repository: Courses, onDelete: "cascade" } },
	});
	const Lessons = repositoryOf({
		entity: Lesson,
		actions: ["create", "findMany", "count", "delete"],
		deletion: options.lessons ?? "hard",
		parents: {
			moduleId: {
				repository: Modules,
				onDelete: options.lessonsOnDelete ?? "cascade",
			},
		},
	});
	const Content = commandOf({
		name: "Content",
		transaction: true,
		useCases: (ctx) => ({ deleteCourse: ctx.delete(Courses) }),
	});
	const app = applicationOf({
		name: "school",
		provider: options.provider ?? inMemoryProvider(),
		entities: { Course, Module, Lesson },
		repositories: { Courses, Modules, Lessons },
		commands: { Content },
		outputs: {
			Api: outputOf({
				name: "Api",
				commands: [Content],
				pipe: [openapi({ info: { title: "School", version: "1" } })],
			}),
		},
	});
	const seed = async () => {
		const { Courses, Modules, Lessons } = app.repositories;
		const kept = await Courses.create({ title: "kept" });
		const course = await Courses.create({ title: "course" });
		const modules = [
			await Modules.create({ courseId: course.id, title: "m1" }),
			await Modules.create({ courseId: course.id, title: "m2" }),
			await Modules.create({ courseId: kept.id, title: "other" }),
		];
		for (const module of modules) {
			await Lessons.create({ moduleId: module.id, title: `${module.title}-a` });
			await Lessons.create({ moduleId: module.id, title: `${module.title}-b` });
		}
		return { course, kept, modules };
	};
	return { app, seed, declared: { Courses, Modules, Lessons } };
}

describe("parents", () => {
	test("the delete of a parent deletes its children, at any depth", async () => {
		const { app, seed } = tree();
		const { course, kept } = await seed();
		const { Courses, Modules, Lessons } = app.repositories;
		await Courses.delete(course);
		expect((await Courses.findMany()).map((c) => c.id)).toEqual([kept.id]);
		expect((await Modules.findMany()).map((m) => m.title)).toEqual(["other"]);
		expect((await Lessons.findMany()).map((l) => l.title).sort()).toEqual([
			"other-a",
			"other-b",
		]);
	});

	test("the standard delete cascades inside the transaction of its command", async () => {
		const { app, seed } = tree();
		const { course } = await seed();
		await app.commands.Content.run("deleteCourse", { id: course.id });
		expect(await app.repositories.Modules.count()).toBe(1);
		expect(await app.repositories.Lessons.count()).toBe(2);
	});

	test("a failure while cascading rolls the whole delete back", async () => {
		let failing = false;
		const provider = inMemoryProvider();
		const wrapped = wrapProvider(provider, {
			around: async (call, next) => {
				if (
					failing &&
					call.operation === "remove" &&
					call.context.name === "ModuleRepository"
				) {
					throw new Error("disk full");
				}
				return next();
			},
		});
		const { app, seed } = tree({ provider: wrapped as never });
		const { course } = await seed();
		failing = true;
		await expect(
			app.commands.Content.run("deleteCourse", { id: course.id }),
		).rejects.toThrow();
		failing = false;
		expect((await app.repositories.Courses.findMany()).length).toBe(2);
		expect(await app.repositories.Modules.count()).toBe(3);
		expect(await app.repositories.Lessons.count()).toBe(6);
	});

	test("each child deletes as its repository does: soft or hard", async () => {
		const { app, seed } = tree({ courses: "soft", modules: "soft" });
		const { course } = await seed();
		const { Courses, Modules, Lessons } = app.repositories;
		await Courses.delete(course);
		expect(await Modules.count()).toBe(1);
		expect(await Modules.count({ withDeleted: true })).toBe(3);
		const gone = await Modules.findMany({
			where: { courseId: course.id },
			withDeleted: true,
		});
		expect(gone.every((module) => module.deletedAt !== undefined)).toBe(true);
		// Hard below a soft parent: removed for good.
		expect(await Lessons.count()).toBe(2);
	});

	test("restrict refuses with a 409 while a child is left, and deletes nothing", async () => {
		const { app, seed } = tree({ lessonsOnDelete: "restrict" });
		const { course, modules } = await seed();
		const { Courses, Modules, Lessons } = app.repositories;
		const error = await Courses.delete(course).catch((caught) => caught);
		expect(error).toBeInstanceOf(RepositoryDeleteRestricted);
		expect(error.details).toMatchObject({
			child: "LessonRepository",
			key: "moduleId",
		});
		expect(statusOf(error)).toBe(409);
		expect(await Modules.count()).toBe(3);
		expect(await Lessons.count()).toBe(6);
		// Without its lessons, the module no longer holds the course back.
		for (const lesson of await Lessons.findMany()) {
			if (lesson.moduleId !== modules[2]?.id) await Lessons.delete(lesson);
		}
		await Courses.delete(course);
		expect(await Modules.count()).toBe(1);
	});

	test("the standard delete lists the restriction among its errors, and the output answers 409", async () => {
		const { app, seed } = tree({ lessonsOnDelete: "restrict" });
		const { course } = await seed();
		const bound = app.useCases as Record<
			string,
			{ errors: readonly unknown[] }
		>;
		const deleteCourse = Object.values(app.commands.Content.useCases)[0] as {
			errors: readonly unknown[];
		};
		expect(deleteCourse.errors).toContain(RepositoryDeleteRestricted);
		expect(bound).toBeDefined();
		const document = app.outputs.Api.build() as {
			paths: Record<string, Record<string, { responses: object }>>;
		};
		const operation = Object.values(document.paths)
			.flatMap((path) => Object.values(path))
			.find((entry) => JSON.stringify(entry).includes("deleteCourse"));
		expect(Object.keys(operation?.responses ?? {})).toContain("409");
		await expect(
			app.commands.Content.run("deleteCourse", { id: course.id }),
		).rejects.toMatchObject({ name: "RepositoryDeleteRestricted" });
	});

	test("a cascade without a restriction adds no error", () => {
		const { app } = tree();
		const deleteCourse = Object.values(app.commands.Content.useCases)[0] as {
			errors: readonly unknown[];
		};
		expect(deleteCourse.errors).not.toContain(RepositoryDeleteRestricted);
	});

	test("the events of the children go up with the parent", async () => {
		const { app, seed } = tree();
		const { course } = await seed();
		const deleted = await app.repositories.Courses.delete(course);
		const names = deleted.pullEvents().map((event) => event.name);
		expect(names).toEqual(Array(4).fill("LessonDeleted"));
	});

	test("describe gives the parents of each repository", () => {
		const { app } = tree({ lessonsOnDelete: "restrict" });
		const { repositories } = app.describe();
		expect(repositories.Courses?.parents).toBeUndefined();
		expect(repositories.Modules?.parents).toEqual({
			courseId: { repository: "Courses", onDelete: "cascade" },
		});
		expect(repositories.Lessons?.parents).toEqual({
			moduleId: { repository: "Modules", onDelete: "restrict" },
		});
	});

	test("only the children an application registers are deleted", async () => {
		const provider = inMemoryProvider();
		const Courses = repositoryOf({
			entity: Course,
			actions: ["create", "delete"],
			provider,
		});
		const Modules = repositoryOf({
			entity: Module,
			actions: ["create", "count"],
			provider,
			parents: { courseId: { repository: Courses, onDelete: "restrict" } },
		});
		const app = applicationOf({
			name: "courses",
			entities: { Course, Module },
			repositories: { Courses },
		});
		const course = await app.repositories.Courses.create({ title: "c" });
		await Modules.create({ courseId: course.id, title: "m" });
		await app.repositories.Courses.delete(course);
		expect(await Modules.count()).toBe(1);
	});

	test("a registered child needs its parent registered", () => {
		const Courses = repositoryOf({ entity: Course, actions: ["delete"] });
		const Modules = repositoryOf({
			entity: Module,
			actions: ["create"],
			parents: { courseId: { repository: Courses, onDelete: "cascade" } },
		});
		expect(() =>
			applicationOf({
				name: "orphans",
				entities: { Course, Module },
				repositories: { Modules },
			}),
		).toThrow(UnregisteredRepositoryDependency);
	});

	test("a transaction needs the children on the provider of the parent", () => {
		const Courses = repositoryOf({
			entity: Course,
			actions: ["findById", "delete"],
		});
		const Modules = repositoryOf({
			entity: Module,
			actions: ["create"],
			provider: inMemoryProvider(),
			parents: { courseId: { repository: Courses, onDelete: "cascade" } },
		});
		const Content = commandOf({
			name: "Content",
			transaction: true,
			useCases: (ctx) => ({ deleteCourse: ctx.delete(Courses) }),
		});
		expect(() =>
			applicationOf({
				name: "split",
				provider: inMemoryProvider(),
				entities: { Course, Module },
				repositories: { Courses, Modules },
				commands: { Content },
			}),
		).toThrow(/share one provider/);
	});

	test("the declarations stay as they were: only the bound repositories cascade", async () => {
		const { declared } = tree();
		expect(declared.Courses).toBeDefined();
		const Courses = repositoryOf({
			entity: Course,
			actions: ["create", "delete"],
		});
		const Modules = repositoryOf({
			entity: Module,
			actions: ["create", "count"],
			parents: { courseId: { repository: Courses, onDelete: "restrict" } },
		});
		const course = await Courses.create({ title: "c" });
		await Modules.create({ courseId: course.id, title: "m" });
		await Courses.delete(course);
		expect(await Modules.count()).toBe(1);
	});
});

describe("parents, declared", () => {
	const Courses = repositoryOf({ entity: Course, actions: ["delete"] });
	const declare =
		(parents: unknown, entity: typeof Module = Module) =>
		() =>
			repositoryOf({ entity, actions: ["create"], parents: parents as never });

	test("take a key of the entity holding one value, a repository and onDelete", () => {
		const cases: [unknown, RegExp][] = [
			[[], /Expected parents to be an object/],
			[{ nope: { repository: Courses, onDelete: "cascade" } }, /not a key/],
			[{ id: { repository: Courses, onDelete: "cascade" } }, /identity key/],
			[
				{ courseId: { repository: {}, onDelete: "cascade" } },
				/made by repositoryOf/,
			],
			[
				{ courseId: { repository: Courses, onDelete: "null" } },
				/"cascade" or "restrict"/,
			],
			[{ courseId: { repository: Courses } }, /"cascade" or "restrict"/],
			[
				{ courseId: { repository: Courses, onDelete: "cascade", index: true } },
				/not index/,
			],
			[{ courseId: Courses }, /made by repositoryOf/],
		];
		for (const [parents, message] of cases) {
			expect(declare(parents)).toThrow(InvalidRepositoryDeclaration);
			expect(declare(parents)).toThrow(message);
		}
	});

	test("are typed by the keys of the entity", () => {
		expect(() =>
			repositoryOf({
				entity: Module,
				actions: ["create"],
				// @ts-expect-error nope is not a key of Module
				parents: { nope: { repository: Courses, onDelete: "cascade" } },
			}),
		).toThrow(InvalidRepositoryDeclaration);
		expect(() =>
			repositoryOf({
				entity: Module,
				actions: ["create"],
				// @ts-expect-error onDelete is "cascade" or "restrict"
				parents: { courseId: { repository: Courses, onDelete: "null" } },
			}),
		).toThrow(InvalidRepositoryDeclaration);
	});

	test("reject a key holding an entity, a record or a list", () => {
		class Held extends entityOf(
			blueprintOf((ctx) => ({
				course: Course,
				courseIds: ctx.listOf(ctx.string),
			})),
		) {}
		for (const key of ["course", "courseIds"]) {
			expect(() =>
				repositoryOf({
					entity: Held,
					actions: ["create"],
					relations: [Courses],
					parents: {
						[key]: { repository: Courses, onDelete: "cascade" },
					} as never,
				}),
			).toThrow(/a single value/);
		}
	});

	test("reject a cycle", () => {
		class Category extends entityOf(
			blueprintOf((ctx) => ({ parentId: ctx.optional.string })),
		) {}
		const Roots = repositoryOf({ entity: Category, actions: ["delete"] });
		expect(() =>
			repositoryOf({
				entity: Category,
				actions: ["delete"],
				parents: { parentId: { repository: Roots, onDelete: "cascade" } },
			}),
		).toThrow(/makes a cycle/);
		const Modules = repositoryOf({
			entity: Module,
			actions: ["delete"],
			parents: { courseId: { repository: Courses, onDelete: "cascade" } },
		});
		class Loop extends entityOf(
			blueprintOf((ctx) => ({ moduleId: ctx.string })),
		) {}
		expect(
			repositoryOf({
				entity: Loop,
				actions: ["delete"],
				parents: { moduleId: { repository: Modules, onDelete: "cascade" } },
			}),
		).toBeDefined();
		expect(() =>
			repositoryOf({
				entity: Course as never,
				actions: ["delete"],
				parents: {
					title: { repository: Modules, onDelete: "cascade" },
				} as never,
			}),
		).toThrow(/makes a cycle/);
	});
});
