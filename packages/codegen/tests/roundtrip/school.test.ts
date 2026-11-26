import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { extractSpec, validateSpec } from "../../src";
import { SchoolApp } from "./apps/school";
import {
	type Any,
	buildProject,
	canonical,
	cleanProjects,
	lintAndTypecheck,
} from "./harness";

afterAll(cleanProjects);

const HONO = resolve(import.meta.dir, "../../../hono/src/index.ts");

const IMPORTS = {
	"entities.Lesson": "../handlers/lesson#Lesson",
	"useCases.PublishLesson": "../handlers/publish-lesson#PublishLesson",
	"outputs.Api.pipe.0": "../support/school-api#apiSink",
	"useCases.AddLesson.before": "../support/school-hooks#place",
};

/** What the application keeps in code: the class of an entity, a use case with its own `execute`, the sink with its hook. */
const HANDLERS = {
	"src/handlers/lesson.ts": `import { LessonBase, LessonEvents } from "../domain/lesson.entity";

export class Lesson extends LessonBase {
	publish(): void {
		this.change.status("published");
		this.emit(LessonEvents.published);
	}
}
`,
	"src/handlers/publish-lesson.ts": `import { LessonNotFound } from "../domain/exceptions";
import { PublishLessonBase } from "../domain/use-cases";

export class PublishLesson extends PublishLessonBase {
	override async execute() {
		const lesson = await this.dependencies.lessons.findById(this.input.id);
		if (!lesson) throw new LessonNotFound({ source: this.input.id });
		lesson.publish();
		return { lesson: await this.dependencies.lessons.update(lesson) };
	}
}
`,
};

/** The sink file of the application, with its import of the Hono package pointed at the source. */
async function apiFile() {
	const source = await Bun.file(
		resolve(import.meta.dir, "apps/school-api.ts"),
	).text();
	return source.replace(
		'"../../../../hono/src/index.ts"',
		JSON.stringify(HONO),
	);
}

/** Calls the API of the application like a client: JSON in, JSON out. */
function client(App: Any) {
	const api = App.outputs.Api.build();
	return async (
		operation: string,
		body: unknown,
		headers: Record<string, string> = {},
	) => {
		const response = await api.request(`/api/classroom/${operation}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
		return { status: response.status, body: (await response.json()) as Any };
	};
}

/** The same HTTP session against the application written by hand and the generated one. */
async function behave(App: Any) {
	const call = client(App);
	const teacher = { authorization: "Bearer teacher" };
	const { Modules, Lessons, Reviews, Courses } = App.repositories;

	const a = (await call("add-course", { title: "Algebra" })).body.item;
	const b = (await call("add-course", { title: "Biology" })).body.item;
	const ma = (await call("add-module", { courseId: a.id, title: "Sets" })).body
		.item;
	const mb = (await call("add-module", { courseId: b.id, title: "Cells" })).body
		.item;
	const lesson = (title: string, moduleId: string) =>
		call("add-lesson", { moduleId, title, status: "draft" });
	const first = (await lesson("Union", ma.id)).body.item;
	const second = (await lesson("Intersection", ma.id)).body.item;
	await lesson("Membrane", mb.id);
	const forbidden = await call("add-lesson", {
		moduleId: ma.id,
		title: "Forced",
		position: 9,
		status: "draft",
	});

	const listed = await call("lessons", { moduleId: ma.id });
	const other = await call("lessons", { moduleId: mb.id });
	const missing = await call("lessons", {});

	const anonymous = await call("publish-lesson", { id: first.id });
	const published = await call("publish-lesson", { id: first.id }, teacher);
	const unknown = await call("publish-lesson", { id: "nope" }, teacher);

	const found = await Lessons.findById(second.id);
	found.pullEvents();
	found.publish();
	const raised = found.pullEvents().map((event: Any) => event.name);

	await call("add-review", { courseId: a.id, stars: 5 });
	const refused = await call("delete-course", { id: a.id });
	const afterRefused = {
		courses: await Courses.count(),
		modules: await Modules.count(),
	};
	const deleted = await call("delete-course", { id: b.id });
	const described = App.describe();

	return {
		positions: [first.position, second.position],
		forbidden: forbidden.status,
		listed: {
			status: listed.status,
			titles: listed.body.items.map((item: Any) => item.title),
		},
		other: other.body.items.map((item: Any) => item.title),
		missing: missing.status,
		anonymous: anonymous.status,
		published: {
			status: published.status,
			state: published.body.lesson.status,
		},
		unknown: { status: unknown.status, title: unknown.body.title },
		raised,
		refused: { status: refused.status, title: refused.body.title },
		afterRefused,
		deleted: deleted.status,
		afterDeleted: {
			courses: await Courses.count(),
			modules: await Modules.count(),
			kept: await Modules.count({ withDeleted: true }),
			lessons: await Lessons.count(),
			reviews: await Reviews.count(),
		},
		described: {
			lesson: described.entities.Lesson.implementation,
			emits: described.entities.Lesson.events.emits,
			hooks: described.outputs.Api.pipe[0].hooks,
			parents: described.repositories.Lessons.parents,
			where: described.useCases.ListLessons.generic.options.where,
		},
	};
}

const EXPECTED = {
	positions: [0, 1],
	forbidden: 400,
	listed: { status: 200, titles: ["Union", "Intersection"] },
	other: ["Membrane"],
	missing: 400,
	anonymous: 401,
	published: { status: 200, state: "published" },
	unknown: { status: 404, title: "LessonNotFound" },
	raised: ["published"],
	refused: { status: 409, title: "RepositoryDeleteRestricted" },
	afterRefused: { courses: 2, modules: 2 },
	deleted: 200,
	afterDeleted: { courses: 1, modules: 1, kept: 2, lessons: 2, reviews: 1 },
	described: {
		lesson: "class",
		emits: [{ name: "published", handler: false }],
		hooks: true,
		parents: { moduleId: { repository: "Modules", onDelete: "cascade" } },
		where: ["moduleId"],
	},
};

describe("app -> JSON -> app: a school written by hand", () => {
	test("the original behaves", async () => {
		expect(await behave(SchoolApp)).toEqual(EXPECTED);
	});

	test("what is in code comes out as import entries", () => {
		const spec = extractSpec(SchoolApp, { imports: IMPORTS });
		expect(validateSpec(spec)).toEqual([]);
		expect(spec.entities?.Lesson?.implementation).toEqual({
			import: "../handlers/lesson#Lesson",
		});
		expect(spec.entities?.Lesson?.events).toEqual({ emits: ["published"] });
		expect(spec.useCases?.PublishLesson?.implementation).toEqual({
			import: "../handlers/publish-lesson#PublishLesson",
		});
		expect(spec.outputs?.Api?.pipe).toEqual([
			{ import: "../support/school-api#apiSink" },
		]);
		expect(spec.useCases?.AddLesson?.options).toMatchObject({
			computed: ["position"],
			before: { import: "../support/school-hooks#place" },
		});
		expect(spec.useCases?.ListLessons?.options).toMatchObject({
			where: ["moduleId"],
		});
		expect(spec.repositories?.Lessons?.parents).toEqual({
			moduleId: { repository: "Modules", onDelete: "cascade" },
		});
		expect(spec.repositories?.Reviews?.parents).toEqual({
			courseId: { repository: "Courses", onDelete: "restrict" },
		});
		expect(spec.entities?.Lesson?.fields?.status).toEqual({
			enum: ["draft", "published"],
			default: "draft",
		});
	});

	test("the generated application passes the same HTTP session and extracts to the same spec", async () => {
		const spec = extractSpec(SchoolApp, { imports: IMPORTS });
		const project = await buildProject(
			[{ root: ".", spec }],
			{},
			{ ...HANDLERS, "src/support/school-api.ts": await apiFile() },
		);
		await lintAndTypecheck(project);
		const { App } = project.domains["."] as Any;
		expect(await behave(App)).toEqual(EXPECTED);
		const again = extractSpec(App, { imports: IMPORTS });
		expect(canonical(again)).toEqual(canonical(spec));
	}, 180_000);
});
