import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
	applicationOf,
	blueprintOf,
	entityOf,
	repositoryOf,
} from "@afora/core";
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

function spec(deletion?: "hard" | "soft"): Spec {
	return {
		version: 1,
		name: "deletion",
		output: { dir: "src/domain" },
		entities: { Item: { fields: { name: "string" }, unique: ["name"] } },
		repositories: {
			Items: {
				entity: "Item",
				actions: ["create", "delete", "findById", "count"],
				...(deletion === undefined ? {} : { deletion }),
			},
		},
	};
}

async function generated(input: Spec) {
	const dir = await makeProject(generate(input));
	projects.push(dir);
	return (await import(join(dir, "src/domain/index.ts"))).App;
}

for (const deletion of [undefined, "hard", "soft"] as const) {
	test(`deletion=${deletion ?? "default"} validates, generates, executes and round trips`, async () => {
		const input = spec(deletion);
		expect(validateSpec(input)).toEqual([]);
		expect(Value.Check(specSchema, input)).toBe(true);
		const App = await generated(input);
		const Items = App.repositories.Items;
		const item = await Items.create({ name: "one" });
		const removed = await Items.delete(item.id);
		expect(removed.isDeleted).toBe(true);
		expect(await Items.findById(item.id)).toBeUndefined();
		expect(await Items.count()).toBe(0);
		if (deletion === "soft") {
			await expect(Items.create({ name: "one" })).rejects.toMatchObject({
				name: "RepositoryUniqueViolation",
			});
		} else {
			expect((await Items.create({ name: "one" })).name).toBe("one");
		}
		expect(App.describe().repositories.Items.deletion).toBe(deletion ?? "hard");
		expect(normalizeSpec(extractSpec(App))).toEqual(normalizeSpec(input));
		expect(generate(extractSpec(App))).toEqual(generate(input));
	});
}

test("hard is canonicalized to the omitted default", () => {
	expect(normalizeSpec(spec("hard"))).toEqual(normalizeSpec(spec()));
	expect(generate(spec("hard"))).toEqual(generate(spec()));
});

for (const deletion of ["archive", "", null, false, 0, {}, []]) {
	test(`rejects invalid deletion ${JSON.stringify(deletion)} with a stable issue`, () => {
		const input = {
			...spec(),
			repositories: { Items: { ...spec().repositories?.Items, deletion } },
		};
		expect(validateSpec(input)).toContainEqual({
			code: "invalid_deletion",
			path: ["repositories", "Items", "deletion"],
			message: 'Expected "hard" or "soft".',
		});
		expect(Value.Check(specSchema, input)).toBe(false);
	});
}

test("a hand-written soft repository keeps its behavior after extraction and generation", async () => {
	class Item extends entityOf(
		blueprintOf((ctx) => ({ name: ctx.string })),
		{ unique: ["name"] },
	) {}
	const Items = repositoryOf({
		entity: Item,
		actions: ["create", "delete", "findById", "count"],
		deletion: "soft",
	});
	const original = applicationOf({
		name: "deletion",
		entities: { Item },
		repositories: { Items },
	});
	const extracted = extractSpec(original);
	expect(extracted.repositories?.Items?.deletion).toBe("soft");
	const rebuilt = await generated(extracted);
	for (const app of [original, rebuilt]) {
		const repo = app.repositories.Items;
		const item = await repo.create({ name: "one" });
		await repo.delete(item);
		expect(await repo.count()).toBe(0);
		await expect(repo.create({ name: "one" })).rejects.toMatchObject({
			name: "RepositoryUniqueViolation",
		});
	}
});
