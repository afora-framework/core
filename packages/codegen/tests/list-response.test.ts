import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
	compactSpec,
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

function spec(useCases: Record<string, unknown> = {}): Spec {
	return {
		version: 1,
		name: "lists",
		output: { dir: "src/domain" },
		blueprints: { Summary: { fields: { title: "string" } } },
		entities: { Article: { fields: { title: "string", body: "text" } } },
		useCases: {
			Recent: {
				input: { fields: {} },
				response: { type: "Summary", list: { maxItems: 2 } },
				implementation: {
					steps: [{ return: [{ title: "a" }, { title: "b" }] }],
				},
			},
			Titles: {
				input: { fields: { titles: "string[]" } },
				response: "string[]",
				implementation: { steps: [{ return: "$input.titles" }] },
			},
			Pairs: {
				input: { fields: {} },
				response: { fields: { key: "string" }, list: true },
				implementation: { steps: [{ return: [{ key: "k" }] }] },
			},
			Articles: {
				input: { fields: {} },
				response: "Article[]",
				implementation: { steps: [{ return: [] }] },
			},
			...useCases,
		},
	} as unknown as Spec;
}

const codes = (input: Spec) =>
	validateSpec(input).map((issue) => `${issue.path.join(".")}: ${issue.code}`);

test("a list response validates, generates, runs and round trips", async () => {
	const input = spec();
	expect(validateSpec(input)).toEqual([]);
	expect(Value.Check(specSchema, input)).toBe(true);
	const files = generate(input);
	const useCases = files.find((file) => file.path.endsWith("use-cases.ts"));
	expect(useCases?.contents).toContain(
		"response: listOf(Summary, { maxItems: 2 })",
	);
	expect(useCases?.contents).toContain("response: listOf(StringProperty)");
	expect(useCases?.contents).toContain("response: listOf(Article)");
	const dir = await makeProject(files);
	projects.push(dir);
	const { App } = await import(join(dir, "src/domain/index.ts"));
	expect(await new App.useCases.Recent({}).execute()).toEqual([
		{ title: "a" },
		{ title: "b" },
	]);
	expect(
		await new App.useCases.Titles({ titles: ["x", "y"] }).execute(),
	).toEqual(["x", "y"]);
	expect(await new App.useCases.Pairs({}).execute()).toEqual([{ key: "k" }]);
	const extracted = extractSpec(App);
	expect(extracted.useCases?.Titles).toMatchObject({ response: "string[]" });
	expect(compactSpec(normalizeSpec(input)).useCases?.Recent).toMatchObject({
		response: { type: "Summary", list: { maxItems: 2 } },
	});
	expect(normalizeSpec(extracted)).toEqual(normalizeSpec(input));
	expect(generate(extracted)).toEqual(generate(input));
});

test("a list response is a list, not optional, and not of variants", () => {
	const withResponse = (response: unknown) =>
		codes(
			spec({
				Wrong: {
					input: { fields: {} },
					response,
					implementation: { steps: [{ return: [] }] },
				},
			}),
		);
	expect(withResponse("string")).toEqual([
		"useCases.Wrong.response: invalid_blueprint",
	]);
	expect(withResponse("Summary[]?")).toEqual([
		"useCases.Wrong.response: invalid_blueprint",
	]);
	expect(withResponse({ type: "Summary" })).toEqual([
		"useCases.Wrong.response: invalid_blueprint",
	]);
	expect(withResponse("Nope[]")).toEqual([
		"useCases.Wrong.response.type: unknown_type",
	]);
});

test("setCookie is rejected with a list response", () => {
	expect(
		codes(
			spec({
				Cookies: {
					input: { fields: {} },
					response: "Summary[]",
					route: { method: "get", setCookie: { title: { name: "t" } } },
					implementation: { steps: [{ return: [] }] },
				},
			}),
		),
	).toEqual(["useCases.Cookies.route.setCookie: invalid_route"]);
});
