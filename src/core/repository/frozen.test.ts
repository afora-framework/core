import { describe, expect, test } from "bun:test";
import {
	blueprintOf,
	ExceptionLayers,
	entityOf,
	RepositoryIsFrozen,
	repositoryOf,
} from "../../index";

class Project extends entityOf(
	blueprintOf((ctx) => ({ title: ctx.string })),
	{ name: "Project" },
) {}

const Projects = repositoryOf({
	entity: Project,
	actions: ["create", "findMany"],
});

describe("a frozen repository", () => {
	test("says why a method cannot be assigned, and where to look", () => {
		let error: unknown;
		try {
			(Projects as unknown as Record<string, unknown>).findMany = () => [];
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(RepositoryIsFrozen);
		const { message, layer } = error as { message: string; layer: string };
		expect(layer).toBe(ExceptionLayers.Repository);
		expect(message).toContain("spyProvider");
		expect(message).toContain("@afora/core/testing");
		expect(message).toContain("execute");
		expect(message).toContain("docs/testing.md#spying-on-the-database");
	});

	test("cannot be redefined or deleted, and still works", async () => {
		const repository = Projects as unknown as object;
		expect(() =>
			Object.defineProperty(repository, "findMany", { value: () => [] }),
		).toThrow(TypeError);
		expect(() =>
			Object.defineProperty(Object.getPrototypeOf(repository), "findMany", {
				value: () => [],
			}),
		).toThrow(TypeError);
		const created = await Projects.create({ title: "a" });
		expect(await Projects.findMany({})).toHaveLength(1);
		expect(created.title).toBe("a");
	});
});
