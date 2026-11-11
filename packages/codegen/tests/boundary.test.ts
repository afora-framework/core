import { describe, expect, test } from "bun:test";
import { projectBoundaryIssues } from "../src";

const root = "/work/project";
const at = (spec: unknown) =>
	projectBoundaryIssues(spec, root).map(
		({ code, path }) => `${code}@${path.join(".")}`,
	);

describe("projectBoundaryIssues", () => {
	test("accepts modules inside the project and packages", () => {
		expect(
			at({
				version: 1,
				extends: ["./auth", "@acme/billing"],
				provider: { import: "../db#provider" },
				useCases: {
					A: { implementation: { import: "../handlers/a#A" } },
					B: {
						implementation: {
							steps: [{ run: "x", fn: { import: "@acme/lib#x" } }],
						},
					},
				},
			}),
		).toEqual([]);
		expect(at(null)).toEqual([]);
		expect(at("nope")).toEqual([]);
	});

	test("a relative module resolves from the output directory", () => {
		// src/domain -> ../../ is the project root; one more leaves it.
		expect(at({ provider: { import: "../../db#provider" } })).toEqual([]);
		expect(at({ provider: { import: "../../../db#provider" } })).toEqual([
			"outside_project@provider.import",
		]);
		expect(
			at({ output: { dir: "out" }, provider: { import: "../../db#p" } }),
		).toEqual(["outside_project@provider.import"]);
	});

	test("refuses absolute paths and URLs, at any depth", () => {
		expect(
			at({
				useCases: {
					A: { implementation: { import: "/etc/a#A" } },
					B: {
						generic: "create",
						options: { before: { import: "file:///tmp/b.ts#b" } },
					},
				},
				outputs: { Api: { pipe: [{ import: "https://evil.test/s.ts#s" }] } },
				publishers: { hub: { import: "C:\\\\x\\\\hub.ts#hub" } },
			}),
		).toEqual([
			"outside_project@useCases.A.implementation.import",
			"outside_project@useCases.B.options.before.import",
			"outside_project@outputs.Api.pipe.0.import",
			"outside_project@publishers.hub.import",
		]);
	});

	test("an extended spec must be inside the project", () => {
		expect(at({ extends: ["../other", "./mine", "/abs/afora.json"] })).toEqual([
			"outside_project@extends.0",
			"outside_project@extends.2",
		]);
	});
});
