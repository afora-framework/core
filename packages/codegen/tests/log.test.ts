import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	applicationOf,
	blueprintOf,
	consoleLogProvider,
	jsonLogProvider,
	Logger,
	logFrom,
	logProviderOf,
	useCaseOf,
} from "@afora/core";
import { extractSpec, generate, type Spec, validateSpec } from "../src";
import { makeProject, removeProject } from "./project";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

const spec: Spec = {
	version: 1,
	name: "notes",
	log: { level: "warn", providers: ["json", "console"] },
	blueprints: { Rows: { fields: { rows: "integer" } }, Empty: { fields: {} } },
	useCases: {
		Import: {
			input: "Rows",
			response: "Empty",
			dependencies: { logger: "Logger" },
			implementation: { steps: [{ return: {} }] },
		},
	},
};

const codes = (input: unknown) =>
	validateSpec(input).map((i) => `${i.code}@${i.path.join(".")}`);

describe("log in afora.json", () => {
	test("validates the level, the providers and Logger", () => {
		expect(codes(spec)).toEqual([]);
		expect(
			codes({
				...spec,
				log: { level: "loud", providers: ["file", { import: "x" }], at: 1 },
			}),
		).toEqual([
			"unknown_key@log.at",
			"invalid_log_level@log.level",
			"unknown_log_provider@log.providers.0",
			"invalid_import@log.providers.1",
		]);
		expect(codes({ ...spec, log: { import: "./log.ts#log" } })).toEqual([]);
		expect(
			codes({
				...spec,
				useCases: {
					Import: {
						...spec.useCases?.Import,
						dependencies: { logger: "Loggr" },
					},
				},
			}),
		).toEqual(["unknown_dependency@useCases.Import.dependencies.logger"]);
	});

	test("generates the log and the Logger dependency, and runs", async () => {
		const files = generate(spec);
		const application = files.find((file) =>
			file.path.endsWith("application.ts"),
		)?.contents;
		expect(application).toContain("jsonLogProvider()");
		expect(application).toContain("consoleLogProvider()");
		const useCases = files.find((file) =>
			file.path.endsWith("use-cases.ts"),
		)?.contents;
		expect(useCases).toContain("logger: Logger");

		const dir = await makeProject(files, {}, ["**/*.ts"]);
		projects.push(dir);
		const domain = await import(join(dir, "src/domain/index.ts"));
		const described = domain.App.describe();
		expect(described.log).toEqual({
			level: "warn",
			providers: [
				{ kind: "log-provider", name: "json" },
				{ kind: "log-provider", name: "console" },
			],
		});
		expect(described.useCases.Import.dependencies).toEqual({
			logger: { kind: "logger", ref: "Logger" },
		});
	});

	test("extracts it back; other providers and logFrom need an import", () => {
		class Import extends useCaseOf({
			name: "Import",
			blueprint: blueprintOf((ctx) => ({ rows: ctx.integer })),
			response: blueprintOf(() => ({})),
			dependencies: { logger: Logger },
		}) {
			override async execute() {
				return {};
			}
		}
		const named = applicationOf({
			name: "notes",
			useCases: { Import },
			log: { providers: [jsonLogProvider(), consoleLogProvider()] },
		});
		const extracted = extractSpec(named, {
			imports: { "useCases.Import": "./import.ts#Import" },
		});
		expect(extracted.log).toEqual({ providers: ["json", "console"] });
		expect(extracted.useCases?.Import?.dependencies).toEqual({
			logger: "Logger",
		});

		const custom = applicationOf({
			name: "notes",
			log: { level: "debug", providers: [logProviderOf({ write: () => {} })] },
		});
		expect(() => extractSpec(custom)).toThrow("log.providers.0");
		expect(
			extractSpec(custom, {
				imports: { "log.providers.0": "./log.ts#datadog" },
			}).log,
		).toEqual({ level: "debug", providers: [{ import: "./log.ts#datadog" }] });

		const made = applicationOf({
			name: "notes",
			log: logFrom(() => ({ providers: [] })),
		});
		expect(() => extractSpec(made)).toThrow("logFrom");
		expect(extractSpec(made, { imports: { log: "./log.ts#log" } }).log).toEqual(
			{ import: "./log.ts#log" },
		);
	});
});
