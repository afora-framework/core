import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	applicationOf,
	blueprintOf,
	entityOf,
	inMemoryProvider,
	providerFrom,
	providersOf,
	repositoryOf,
} from "@afora/core";
import {
	compactSpec,
	extractSpec,
	generate,
	normalizeSpec,
	type ResolvedSpec,
	type Spec,
	validateSpec,
} from "../src";
import { makeProject, removeProject, run } from "./project";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

const spec: Spec = {
	version: 1,
	name: "notes",
	providers: {
		main: "inMemory",
		audit: { import: "../audit#audit" },
	},
	provider: "main",
	entities: {
		Note: { fields: { title: "string" } },
		Entry: { fields: { event: "string" } },
	},
	repositories: {
		Notes: { entity: "Note", actions: ["create", "count"] },
		Entries: {
			entity: "Entry",
			actions: ["create", "count"],
			provider: "audit",
		},
	},
};

/** The hand-written provider the spec imports: one made on start. */
const AUDIT = {
	"src/audit.ts": `import { inMemoryProvider, providerFrom } from "@afora/core";
export const audit = providerFrom(() => inMemoryProvider());
`,
};

const codes = (input: unknown, extended?: Record<string, ResolvedSpec>) =>
	validateSpec(input, extended).map((i) => `${i.code}@${i.path.join(".")}`);

describe("providers in afora.json", () => {
	test("validates the keys and the references", () => {
		expect(codes(spec)).toEqual([]);
		expect(
			codes({
				...spec,
				providers: { inMemory: "inMemory", Main: "inMemory", ok: "audit" },
				provider: "nope",
			}),
		).toEqual([
			"unknown_provider@provider",
			"invalid_provider_key@providers.inMemory",
			"invalid_provider_key@providers.Main",
			"unknown_provider@providers.ok",
			"unknown_provider@repositories.Entries.provider",
		]);
		const [unknown] = validateSpec({
			...spec,
			repositories: {
				Notes: { entity: "Note", actions: ["count"], provider: "audt" },
			},
		});
		expect(unknown?.message).toContain('a key of "providers": main, audit');
	});

	test("a key of an extended spec can be named; two specs cannot declare one key", () => {
		const base: ResolvedSpec = {
			spec: { version: 1, name: "base", providers: { shared: "inMemory" } },
		};
		const child = {
			version: 1,
			extends: ["../base/afora.json"],
			provider: "shared",
		};
		expect(codes(child, { "../base/afora.json": base })).toEqual([]);
		expect(
			codes(
				{ ...child, providers: { shared: { import: "./x.ts#x" } } },
				{ "../base/afora.json": base },
			),
		).toEqual(["provider_conflict@providers.shared"]);
	});

	test("normalizes and compacts each provider", () => {
		const normalized = normalizeSpec(spec);
		expect(normalized.providers).toEqual({
			audit: { import: "../audit#audit" },
			main: { use: "inMemory", options: {} },
		});
		expect(normalized.provider).toBe("main");
		expect(normalized.repositories?.Entries?.provider).toBe("audit");
		expect(compactSpec(normalized).providers).toEqual({
			audit: { import: "../audit#audit" },
			main: "inMemory",
		});
	});

	test("generates the storage and the references, which type-check and run", async () => {
		const files = generate(spec);
		const contents = (name: string) =>
			files.find((file) => file.path.endsWith(`/${name}`))?.contents ?? "";
		expect(contents("providers.ts")).toMatchSnapshot();
		expect(contents("repositories.ts")).toContain("provider: Providers.audit");
		expect(contents("application.ts")).toContain("providers: Providers,");
		expect(contents("application.ts")).toContain("provider: Providers.main,");
		expect(contents("index.ts")).toContain('export * from "./providers";');

		const dir = await makeProject(files, AUDIT, ["src"]);
		projects.push(dir);
		const tsc = await run(dir, "bunx", "tsc", "--noEmit", "-p", dir);
		expect(tsc.output).toBe("");
		const domain = await import(join(dir, "src/domain/index.ts"));
		const App = domain.App;
		await App.start({ register: false });
		await App.repositories.Entries.create({ event: "a" });
		expect(await App.repositories.Entries.count()).toBe(1);
		expect(await App.repositories.Notes.count()).toBe(0);
		expect(App.get(domain.Providers.audit)).not.toBe(
			App.get(domain.Providers.main),
		);
		await App.stop();

		expect(
			normalizeSpec(
				extractSpec(App, { imports: { "providers.audit": "../audit#audit" } }),
			),
		).toEqual(normalizeSpec(spec));
	});

	test("a reference to a key of an extended spec imports its storage", () => {
		const base: ResolvedSpec = {
			spec: {
				version: 1,
				name: "base",
				providers: { shared: "inMemory" },
				entities: { Item: { fields: { name: "string" } } },
			},
		};
		const files = generate(
			{
				version: 1,
				name: "child",
				extends: ["../base/afora.json"],
				providers: { local: "inMemory" },
				entities: { Thing: { fields: { name: "string" } } },
				repositories: {
					Things: { entity: "Thing", actions: ["count"], provider: "shared" },
					Locals: { entity: "Thing", actions: ["count"], provider: "local" },
				},
			} as Spec,
			{ "../base/afora.json": base },
		);
		const repositories =
			files.find((file) => file.path.endsWith("/repositories.ts"))?.contents ??
			"";
		expect(repositories).toContain("provider: Providers2.shared");
		expect(repositories).toContain("provider: Providers.local");
		expect(repositories).toContain(
			'import { Providers as Providers2 } from "../../../base/src/domain";',
		);
	});

	test("extracts the storage; a provider made on start needs an import", () => {
		class Note extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string })),
		) {}
		const Providers = providersOf({
			main: inMemoryProvider(),
			made: providerFrom(() => inMemoryProvider()),
		});
		const Notes = repositoryOf({
			entity: Note,
			actions: ["count"],
			provider: Providers.made,
		});
		const app = applicationOf({
			name: "notes",
			entities: { Note },
			repositories: { Notes },
			providers: Providers,
			provider: Providers.main,
		});
		expect(() => extractSpec(app)).toThrow("providers.made");
		const extracted = extractSpec(app, {
			imports: { "providers.made": "./made.ts#made" },
		});
		expect(extracted.providers).toEqual({
			main: "inMemory",
			made: { import: "./made.ts#made" },
		});
		expect(extracted.provider).toBe("main");
		expect(extracted.repositories?.Notes?.provider).toBe("made");
		// an application that extends it does not declare them again
		const child = applicationOf({ name: "child", extends: [app] });
		expect(extractSpec(child).providers).toBeUndefined();
		expect(extractSpec(child).provider).toBe("main");
	});
});
