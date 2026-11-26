import {
	applicationOf,
	blueprintOf,
	commandOf,
	type EventDefinition,
	ExceptionLayers,
	entityOf,
	eventOf,
	exceptionOf,
	inMemoryProvider,
	outputOf,
	repositoryOf,
	useCaseOf,
} from "@afora/core";
import { place } from "../support/school-hooks";
import { apiSink } from "./school-api";

/**
 * A hand-written application (no codegen) of a school: a lesson with a method
 * that raises an event, a use case with its own `execute`, standard use cases
 * (a list by parent, a create with a computed key, a delete that follows
 * `parents`) and an output whose sink has a hook.
 */
const LessonNotFound = exceptionOf({
	layer: ExceptionLayers.UseCase,
	name: "LessonNotFound",
	message: "No such lesson.",
});

class Course extends entityOf(blueprintOf((ctx) => ({ title: ctx.text }))) {}
class Module extends entityOf(
	blueprintOf((ctx) => ({ courseId: ctx.string, title: ctx.text })),
) {}
class Review extends entityOf(
	blueprintOf((ctx) => ({ courseId: ctx.string, stars: ctx.integer })),
) {}
class Lesson extends entityOf(
	blueprintOf((ctx) => ({
		moduleId: ctx.string,
		title: ctx.text,
		position: ctx.integer,
		status: ctx.enumOf(["draft", "published"], { default: "draft" }),
	})),
	{ change: ["status"], emits: () => [LessonEvents.published] },
) {
	publish(): void {
		this.change.status("published");
		this.emit(LessonEvents.published);
	}
}
// The annotation breaks TypeScript's circular inference through the base class.
const LessonEvents: { published: EventDefinition } = {
	published: eventOf("published", Lesson),
};

const Courses = repositoryOf({
	entity: Course,
	actions: ["create", "findById", "delete", "count"],
});
// Deleted with their course, but kept (soft deletion) for the record.
const Modules = repositoryOf({
	entity: Module,
	actions: ["create", "count"],
	deletion: "soft",
	parents: { courseId: { repository: Courses, onDelete: "cascade" } },
});
// A course that has reviews is not deleted.
const Reviews = repositoryOf({
	entity: Review,
	actions: ["create", "count"],
	parents: { courseId: { repository: Courses, onDelete: "restrict" } },
});
const Lessons = repositoryOf({
	entity: Lesson,
	actions: ["create", "findById", "update", "findPage", "count"],
	parents: { moduleId: { repository: Modules, onDelete: "cascade" } },
});

class PublishLesson extends useCaseOf({
	name: "PublishLesson",
	description: "Publishes a lesson.",
	blueprint: blueprintOf((ctx) => ({ id: ctx.string })),
	response: blueprintOf(() => ({ lesson: Lesson })),
	dependencies: { lessons: Lessons },
	errors: [LessonNotFound],
	access: { scopes: ["school:write"] },
}) {
	async execute() {
		const lesson = await this.dependencies.lessons.findById(this.input.id);
		if (!lesson) throw new LessonNotFound({ source: this.input.id });
		lesson.publish();
		return { lesson: await this.dependencies.lessons.update(lesson) };
	}
}

const Classroom = commandOf({
	name: "Classroom",
	description: "The school.",
	transaction: true,
	useCases: (ctx) => ({
		addCourse: ctx.create(Courses, { name: "AddCourse" }),
		addModule: ctx.create(Modules, { name: "AddModule" }),
		addReview: ctx.create(Reviews, { name: "AddReview" }),
		addLesson: ctx.create(Lessons, {
			name: "AddLesson",
			computed: ["position"],
			dependencies: { lessons: Lessons },
			before: place,
		}),
		lessons: ctx.list(Lessons, {
			name: "ListLessons",
			where: ["moduleId"],
			orderBy: [{ key: "position" }],
		}),
		deleteCourse: ctx.delete(Courses, { name: "DeleteCourse" }),
		publishLesson: PublishLesson,
	}),
});

const Api = outputOf({
	name: "Api",
	commands: [Classroom],
	statuses: { LessonNotFound: 404 },
	pipe: [apiSink],
});

export const SchoolApp = applicationOf({
	name: "school",
	provider: inMemoryProvider(),
	entities: { Course, Module, Review, Lesson },
	repositories: { Courses, Modules, Reviews, Lessons },
	exceptions: { LessonNotFound },
	useCases: { PublishLesson },
	commands: { Classroom },
	outputs: { Api },
});
