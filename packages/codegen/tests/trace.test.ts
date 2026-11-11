import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { applicationOf, memoryTracer } from "@afora/core";
import { extractSpec, generate, type Spec, validateSpec } from "../src";
import { makeProject, removeProject } from "./project";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

const spec: Spec = {
	version: 1,
	name: "notes",
	output: { dir: "src/domain" },
	trace: { import: "../trace#tracer" },
	blueprints: { Empty: { fields: {} } },
	useCases: {
		Ping: {
			input: "Empty",
			response: "Empty",
			implementation: { steps: [{ return: {} }] },
		},
	},
	commands: { Pings: { useCases: { ping: "Ping" } } },
};

const codes = (input: unknown) =>
	validateSpec(input).map((i) => `${i.code}@${i.path.join(".")}`);

describe("trace in afora.json", () => {
	test("is an import", () => {
		expect(codes(spec)).toEqual([]);
		expect(codes({ ...spec, trace: "otel" })).toEqual(["invalid_trace@trace"]);
		expect(codes({ ...spec, trace: { import: "x" } })).toEqual([
			"invalid_import@trace",
		]);
	});

	test("generates the trace, which traces the application", async () => {
		const files = generate(spec);
		const application = files.find((file) =>
			file.path.endsWith("application.ts"),
		)?.contents;
		expect(application).toContain("trace: tracer");
		expect(application).toContain('from "../trace"');

		const dir = await makeProject(files, {
			"src/trace.ts": `import { memoryTracer } from "@afora/core";\n\nexport const tracer = memoryTracer();\n`,
		});
		projects.push(dir);
		const domain = await import(join(dir, "src/domain/index.ts"));
		const { tracer } = await import(join(dir, "src/trace.ts"));
		expect(domain.App.describe().trace).toEqual({ kind: "opaque" });
		await domain.App.commands.Pings.run("ping", {});
		expect(tracer.spans.map((span: { name: string }) => span.name)).toEqual([
			"command Pings.ping",
			"use-case Ping",
		]);
	});

	test("extracts it back with an import", () => {
		const app = applicationOf({ name: "notes", trace: memoryTracer() });
		expect(() => extractSpec(app)).toThrow('"trace"');
		expect(
			extractSpec(app, { imports: { trace: "./trace.ts#tracer" } }).trace,
		).toEqual({ import: "./trace.ts#tracer" });
		expect(extractSpec(applicationOf({ name: "notes" })).trace).toBeUndefined();
	});
});
