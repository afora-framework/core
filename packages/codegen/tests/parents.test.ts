import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
	extractSpec,
	generate,
	normalizeSpec,
	type Spec,
	specSchema,
	validateSpec,
} from "../src";
import { makeProject, removeProject } from "./project";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

function spec(
	lessons: Record<string, unknown> = {},
	entities: Record<string, unknown> = {},
): Spec {
	return {
		version: 1,
		name: "school",
		output: { dir: "src/domain" },
		provider: "inMemory",
		entities: {
			Course: { fields: { title: "string" } },
			Module: { fields: { courseId: "string", title: "string" } },
			Lesson: {
				fields: { moduleId: "string", title: "string", tags: "string[]" },
			},
			...entities,
		},
		repositories: {
			Courses: {
				entity: "Course",
				actions: ["create", "findById", "delete", "count"],
			},
			Modules: {
				entity: "Module",
				actions: ["create", "count"],
				deletion: "soft",
				parents: { courseId: { repository: "Courses", onDelete: "cascade" } },
			},
			Lessons: {
				entity: "Lesson",
				actions: ["create", "count"],
				parents: { moduleId: { repository: "Modules", onDelete: "cascade" } },
				...lessons,
			},
		},
		useCases: {
			DeleteCourse: { generic: "delete", repository: "Courses" },
		},
		commands: {
			Content: {
				useCases: { deleteCourse: "DeleteCourse" },
				transaction: true,
			},
		},
	} as Spec;
}

test("parents validate, generate, cascade and round trip", async () => {
	const input = spec();
	expect(validateSpec(input)).toEqual([]);
	expect(Value.Check(specSchema, input)).toBe(true);
	const files = generate(input);
	expect(JSON.stringify(files)).toContain(
		'parents: { courseId: { repository: Courses, onDelete: \\"cascade\\" } }',
	);
	const dir = await makeProject(files);
	projects.push(dir);
	const { App } = await import(join(dir, "src/domain/index.ts"));
	const { Courses, Modules, Lessons } = App.repositories;
	const course = await Courses.create({ title: "c" });
	const module = await Modules.create({ courseId: course.id, title: "m" });
	await Lessons.create({ moduleId: module.id, title: "l", tags: [] });
	await App.commands.Content.run("deleteCourse", { id: course.id });
	expect(await Courses.count()).toBe(0);
	expect(await Modules.count()).toBe(0);
	expect(await Modules.count({ withDeleted: true })).toBe(1);
	expect(await Lessons.count()).toBe(0);
	expect(App.describe().repositories.Lessons.parents).toEqual({
		moduleId: { repository: "Modules", onDelete: "cascade" },
	});
	expect(normalizeSpec(extractSpec(App))).toEqual(normalizeSpec(input));
	expect(generate(extractSpec(App))).toEqual(generate(input));
});

test("restrict round trips and answers RepositoryDeleteRestricted", async () => {
	const input = spec({
		parents: { moduleId: { repository: "Modules", onDelete: "restrict" } },
	});
	expect(validateSpec(input)).toEqual([]);
	const dir = await makeProject(generate(input));
	projects.push(dir);
	const { App } = await import(join(dir, "src/domain/index.ts"));
	const { Courses, Modules, Lessons } = App.repositories;
	const course = await Courses.create({ title: "c" });
	const module = await Modules.create({ courseId: course.id, title: "m" });
	await Lessons.create({ moduleId: module.id, title: "l", tags: [] });
	await expect(
		App.commands.Content.run("deleteCourse", { id: course.id }),
	).rejects.toMatchObject({ name: "RepositoryDeleteRestricted" });
	expect(await Modules.count()).toBe(1);
	expect(normalizeSpec(extractSpec(App))).toEqual(normalizeSpec(input));
});

test("parents are canonical by key, and none when empty", () => {
	const two = spec({
		parents: {
			title: { repository: "Courses", onDelete: "restrict" },
			moduleId: { repository: "Modules", onDelete: "cascade" },
		},
	});
	const sorted = normalizeSpec(two) as unknown as {
		repositories: Record<string, { parents?: object }>;
	};
	expect(Object.keys(sorted.repositories.Lessons?.parents ?? {})).toEqual([
		"moduleId",
		"title",
	]);
	expect(normalizeSpec(spec({ parents: {} }))).toEqual(
		normalizeSpec(spec({ parents: undefined })),
	);
});

const issuesOf = (input: Spec) =>
	validateSpec(input).map((issue) => `${issue.code}@${issue.path.join(".")}`);

test("rejects parents that are not valid", () => {
	const at = "repositories.Lessons.parents";
	const cases: [Record<string, unknown>, string][] = [
		[{ parents: [] }, `invalid_parents@${at}`],
		[
			{ parents: { nope: { repository: "Modules", onDelete: "cascade" } } },
			`invalid_parents@${at}.nope`,
		],
		[
			{ parents: { tags: { repository: "Modules", onDelete: "cascade" } } },
			`invalid_parents@${at}.tags`,
		],
		[
			{ parents: { moduleId: { repository: "Modules", onDelete: "null" } } },
			`invalid_parents@${at}.moduleId`,
		],
		[
			{ parents: { moduleId: { repository: "Nope", onDelete: "cascade" } } },
			`unknown_repository@${at}.moduleId.repository`,
		],
	];
	for (const [lessons, expected] of cases) {
		expect(issuesOf(spec(lessons))).toContain(expected);
	}
});

test("rejects a cycle of parents", () => {
	const input = spec(
		{},
		{ Category: { fields: { parentId: "string?" } } },
	) as unknown as { repositories: Record<string, unknown> };
	input.repositories.Categories = {
		entity: "Category",
		actions: ["delete"],
		parents: { parentId: { repository: "Categories", onDelete: "cascade" } },
	};
	expect(issuesOf(input as unknown as Spec)).toContain(
		"parent_cycle@repositories.Categories.parents.parentId.repository",
	);
});
