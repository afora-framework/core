import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
	compactSpec,
	ExtractionError,
	extractSpec,
	generate,
	normalizeSpec,
	type Spec,
	specSchema,
	validateSpec,
} from "../src";
import { BIOME, makeProject, removeProject, run } from "./project";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

const SERVICES_TS = `import type { ServiceScope } from "@afora/core";

export let made = 0;

export const cache = (scope: ServiceScope) => {
	made++;
	const values = new Map<string, string>();
	return {
		name: scope.name,
		get: (key: string): string | undefined => values.get(key),
		set: (key: string, value: string): void => {
			values.set(key, value);
		},
	};
};
`;

const REMEMBER_TS = `import { RememberBase } from "../domain/remember.use-case";

export class Remember extends RememberBase {
	override async execute() {
		const { cache } = this.dependencies;
		cache.set(this.input.key, "remembered");
		return { value: cache.get(this.input.key) ?? "" };
	}
}
`;

/** Remember is hand-written and reads the cache service, which the application makes per call. */
const cached: Spec = {
	version: 1,
	name: "cached",
	output: { dir: "src/domain" },
	services: { cache: { import: "../services#cache" } },
	useCases: {
		Remember: {
			input: { fields: { key: "string" } },
			response: { fields: { value: "string" } },
			dependencies: { cache: "cache" },
			implementation: { import: "../handlers/remember#Remember" },
		},
	},
	commands: { Memory: { useCases: { remember: "Remember" } } },
};

const IMPORTS = {
	"services.cache": "../services#cache",
	"useCases.Remember": "../handlers/remember#Remember",
};

const EXTRA = {
	"src/services.ts": SERVICES_TS,
	"src/handlers/remember.ts": REMEMBER_TS,
};

const canonical = (spec: Spec) => compactSpec(normalizeSpec(spec));

// biome-ignore lint/suspicious/noExplicitAny: a JSON draft the tests mutate freely
type Draft = any;
const edit = (change: (copy: Draft) => void): Spec => {
	const copy = JSON.parse(JSON.stringify(cached));
	change(copy);
	return copy;
};
const codes = (spec: unknown) =>
	validateSpec(spec).map((i) => `${i.code}@${i.path.join(".")}`);

describe("services: validation", () => {
	test("the fixture is valid and fits the schema", () => {
		expect(validateSpec(cached)).toEqual([]);
		expect(Value.Check(specSchema, cached)).toBe(true);
	});

	const table: [string, (copy: Draft) => void, string][] = [
		[
			"services is an object",
			(c) => (c.services = []),
			"invalid_services@services",
		],
		[
			"a service is an import",
			(c) => (c.services.cache = "cache"),
			"invalid_import@services.cache",
		],
		[
			"a service name is an identifier",
			(c) => (c.services["not-ok"] = { import: "../services#cache" }),
			"invalid_name@services.not-ok",
		],
		[
			"a service name is not a declaration name",
			(c) => (c.services.Remember = { import: "../services#cache" }),
			"duplicate_name@services.Remember",
		],
		[
			"a dependency names a declared service",
			(c) => delete c.services,
			"unknown_dependency@useCases.Remember.dependencies.cache",
		],
	];
	for (const [name, change, expected] of table) {
		test(name, () => {
			expect(codes(edit(change))).toContain(expected);
		});
	}

	test("a service may come from an extended spec", () => {
		const base: Spec = {
			version: 1,
			name: "base",
			services: { cache: { import: "./services#cache" } },
		};
		const child = edit((c) => {
			c.extends = ["../base/afora.json"];
			delete c.services;
		});
		expect(
			validateSpec(child, { "../base/afora.json": { spec: base } }),
		).toEqual([]);
	});
});

describe("services: generation", () => {
	test("declares the dependency, typed by the factory, and binds the factory", () => {
		const files = generate(cached);
		const useCase = files.find((f) => f.path.endsWith("remember.use-case.ts"))
			?.contents as string;
		expect(useCase).toContain(
			'cache: serviceOf<Awaited<ReturnType<typeof cache>>>("cache")',
		);
		expect(useCase).toContain('from "../services"');
		const app = files.find((f) => f.path.endsWith("application.ts"))
			?.contents as string;
		expect(app).toContain("services: { cache }");
	});

	test("clean for Biome and type-checks", async () => {
		const dir = await makeProject(generate(cached), EXTRA);
		projects.push(dir);
		await Bun.write(
			join(dir, "biome.json"),
			JSON.stringify({
				formatter: { indentStyle: "tab" },
				javascript: { formatter: { quoteStyle: "double" } },
				linter: { rules: { preset: "recommended" } },
				assist: { actions: { source: { organizeImports: "on" } } },
			}),
		);
		const biome = await run(
			dir,
			BIOME,
			"check",
			`--config-path=${dir}`,
			join(dir, "src/domain"),
		);
		expect(biome.output).not.toContain("error");
		expect(biome.code).toBe(0);
		const tsc = await run(dir, "bunx", "tsc", "--noEmit", "-p", dir);
		expect(tsc.output).toBe("");
		expect(tsc.code).toBe(0);
	}, 120_000);
});

describe("services: round trip", () => {
	// biome-ignore lint/suspicious/noExplicitAny: the generated application is loaded dynamically
	type Any = any;

	test("JSON -> generate -> run -> extract is equal", async () => {
		const dir = await makeProject(generate(cached), EXTRA);
		projects.push(dir);
		const domain = (await import(join(dir, "src/domain/index.ts"))) as Any;
		const services = (await import(join(dir, "src/services.ts"))) as Any;
		const description = domain.App.describe();
		expect(description.services).toEqual({ cache: { from: "cached" } });
		expect(description.useCases.Remember.dependencies).toEqual({
			cache: { kind: "service", ref: "cache" },
		});
		const out = await domain.App.commands.Memory.run("remember", { key: "a" });
		expect(out).toEqual({ value: "remembered" });
		expect(services.made).toBe(1);

		expect(() => extractSpec(domain.App)).toThrow(ExtractionError);
		expect(() =>
			extractSpec(domain.App, {
				imports: { "useCases.Remember": IMPORTS["useCases.Remember"] },
			}),
		).toThrow('"services.cache"');
		const extracted = extractSpec(domain.App, { imports: IMPORTS });
		expect(canonical(extracted)).toEqual(canonical(cached));
	}, 120_000);
});
