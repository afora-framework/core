import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	applicationOf,
	blueprintOf,
	entityOf,
	inMemoryProvider,
	providerOf,
	repositoryOf,
} from "@afora/core";
import { Value } from "typebox/value";
import {
	ExtractionError,
	extractSpec,
	generate,
	normalizeSpec,
	type ProviderCatalogEntry,
	type Spec,
	specSchema,
	validateSpec,
} from "../src";
import { BIOME, makeProject, removeProject, run } from "./project";

const projects: string[] = [];
afterAll(async () => {
	await Promise.all(projects.map(removeProject));
});

const providers: ProviderCatalogEntry[] = [
	{ name: "memory", module: "../providers", export: "memoryProvider" },
];

/** A catalog provider: named through `providerOf`, delegating to the in-memory one. */
const PROVIDERS_TS = `import { inMemoryProvider, providerOf } from "@afora/core";

export interface MemoryOptions {
	label?: string;
	store?: unknown;
	tags?: string[];
}

export const created: MemoryOptions[] = [];

export function memoryProvider(options: MemoryOptions = {}) {
	return providerOf({
		name: "memory",
		options: { label: options.label ?? null, tags: options.tags ?? [] },
		create: () => {
			created.push(options);
			return inMemoryProvider();
		},
	});
}
`;

const STORE_TS = "export const store = { id: 'the-store' };\n";

/** An anonymous provider: it delegates to the in-memory one without \`providerOf\`. */
const ANON_TS = `import { inMemoryProvider } from "@afora/core";

const base = inMemoryProvider();

export const anonymous = {
	findOne: (...args: Parameters<typeof base.findOne>) => base.findOne(...args),
	findMany: (...args: Parameters<typeof base.findMany>) => base.findMany(...args),
	insert: (...args: Parameters<typeof base.insert>) => base.insert(...args),
	update: (...args: Parameters<typeof base.update>) => base.update(...args),
	remove: (...args: Parameters<typeof base.remove>) => base.remove(...args),
	count: (...args: Parameters<typeof base.count>) => base.count(...args),
};
`;

const EXTRA = {
	"src/providers.ts": PROVIDERS_TS,
	"src/store.ts": STORE_TS,
	"src/anon.ts": ANON_TS,
};

const ACTIONS = ["create", "findMany", "exists", "findPage", "count"];

function spec(overrides: Partial<Spec> = {}, repository: object = {}): Spec {
	return {
		version: 1,
		name: "accounts",
		output: { dir: "src/domain" },
		entities: {
			User: { fields: { name: "string", age: "integer" } },
		},
		repositories: {
			Users: { entity: "User", actions: ACTIONS, ...repository },
		},
		...overrides,
	} as Spec;
}

async function build(input: Spec, options = { providers }) {
	const dir = await makeProject(generate(input, {}, options), EXTRA);
	projects.push(dir);
	return {
		dir,
		App: (await import(join(dir, "src/domain/index.ts"))).App,
	};
}

async function exercise(App: {
	repositories: { Users: Record<string, (...args: unknown[]) => unknown> };
}) {
	const Users = App.repositories.Users as unknown as {
		create(input: object): Promise<unknown>;
		findMany(query?: object): Promise<{ name: string }[]>;
		exists(query?: object): Promise<boolean>;
		findPage(
			query?: object,
		): Promise<{ items: { name: string }[]; total: number }>;
		count(query?: object): Promise<number>;
	};
	for (const [name, age] of [
		["ana", 18],
		["bia", 21],
		["caio", 30],
	] as const) {
		await Users.create({ name, age });
	}
	const found = await Users.findMany({
		where: { age: { in: [18, 21] } },
		orderBy: [{ key: "name" }],
		limit: 20,
	});
	const page = await Users.findPage({ orderBy: [{ key: "name" }], limit: 2 });
	return {
		found: found.map((user) => user.name),
		exists: [
			await Users.exists({ where: { name: "bia" } }),
			await Users.exists({ where: { name: "zed" } }),
		],
		page: { names: page.items.map((user) => user.name), total: page.total },
		count: await Users.count({ where: { age: { in: [30] } } }),
	};
}

const EXPECTED = {
	found: ["ana", "bia"],
	exists: [true, false],
	page: { names: ["ana", "bia"], total: 3 },
	count: 1,
};

describe("validation", () => {
	const at = (input: unknown, ...path: (string | number)[]) =>
		validateSpec(input, {}, { providers }).filter(
			(issue) => issue.path.join("/") === path.join("/"),
		);

	test("accepts every form, at the application and the repository", () => {
		for (const provider of [
			"inMemory",
			{ use: "inMemory" },
			{ use: "inMemory", options: {} },
			{ use: "memory" },
			{
				use: "memory",
				options: {
					label: "x",
					tags: ["a", { deep: [1, null, true] }],
					store: { import: "./store#store" },
					nested: { list: [{ import: "pkg#thing" }] },
				},
			},
			{ import: "./db.ts#provider" },
			{ import: "@scope/pkg#provider" },
		] as never[]) {
			const input = spec({ provider }, { provider });
			expect(validateSpec(input, {}, { providers })).toEqual([]);
			expect(Value.Check(specSchema, input)).toBe(true);
		}
	});

	const cases: [string, unknown, string, string][] = [
		["a bare name", "memory", "unknown_provider", "provider"],
		["an unknown string", "postgres", "unknown_provider", "provider"],
		["an unknown use", { use: "postgres" }, "unknown_provider", "provider/use"],
		["a number", 3, "invalid_provider", "provider"],
		["an array", ["inMemory"], "invalid_provider", "provider"],
		["an empty object", {}, "invalid_provider", "provider"],
		[
			"an unknown key",
			{ use: "memory", extra: 1 },
			"invalid_provider",
			"provider/extra",
		],
		[
			"options that are not an object",
			{ use: "memory", options: [] },
			"invalid_provider",
			"provider/options",
		],
		[
			"options for inMemory",
			{ use: "inMemory", options: { a: 1 } },
			"invalid_provider",
			"provider/options",
		],
		[
			"a non-finite option",
			{ use: "memory", options: { a: Number.POSITIVE_INFINITY } },
			"invalid_provider",
			"provider/options/a",
		],
		[
			"an import without a name",
			{ import: "./db.ts" },
			"invalid_import",
			"provider",
		],
		[
			"an import of a bad name",
			{ import: "./db.ts#a-b" },
			"invalid_import",
			"provider",
		],
		[
			"an import with spaces",
			{ import: "./d b.ts#x" },
			"invalid_import",
			"provider",
		],
		[
			"an import with another key",
			{ import: "./db.ts#x", use: "memory" },
			"invalid_import",
			"provider",
		],
		[
			"a malformed import in the options",
			{ use: "memory", options: { store: { import: "nope" } } },
			"invalid_import",
			"provider/options/store",
		],
		[
			"a malformed import deep in the options",
			{ use: "memory", options: { list: [{ import: 1 }] } },
			"invalid_import",
			"provider/options/list/0",
		],
	];
	for (const [name, provider, code, path] of cases) {
		test(`rejects ${name} with ${code}`, () => {
			const input = spec({ provider } as never);
			expect(at(input, ...path.split("/")).map((i) => i.code)).toContain(code);
			// The same provider on a repository is reported under its path.
			const onRepo = spec({}, { provider });
			expect(
				at(onRepo, "repositories", "Users", ...path.split("/")).map(
					(i) => i.code,
				),
			).toContain(code);
		});
	}

	test("does not know a catalog provider without the catalog", () => {
		const input = spec({ provider: { use: "memory" } });
		expect(validateSpec(input)).toContainEqual(
			expect.objectContaining({
				code: "unknown_provider",
				path: ["provider", "use"],
			}),
		);
		expect(validateSpec(input, {}, { providers })).toEqual([]);
	});

	test("the schema rejects what is not a provider", () => {
		for (const provider of [3, "memory", {}, { use: 1 }, { import: "nope" }]) {
			expect(Value.Check(specSchema, spec({ provider } as never))).toBe(false);
		}
	});

	test("rejects an invalid catalog", () => {
		for (const bad of [
			[{ name: "inMemory", module: "x", export: "y" }],
			[providers[0], providers[0]],
			[{ name: "", module: "x", export: "y" }],
			[{ name: "a", module: "", export: "y" }],
			[{ name: "a", module: "x", export: "not valid" }],
		] as ProviderCatalogEntry[][]) {
			expect(validateSpec(spec(), {}, { providers: bad })).toContainEqual(
				expect.objectContaining({ code: "invalid_provider_catalog", path: [] }),
			);
		}
	});

	test("accepts the query actions without a key and rejects look-alikes", () => {
		expect(
			validateSpec(spec({}, { actions: ["findMany", "exists", "findPage"] })),
		).toEqual([]);
		expect(
			validateSpec(spec({}, { actions: ["findManyBy"] })).map((i) => i.code),
		).toEqual(["unknown_action"]);
		expect(
			validateSpec(spec({}, { actions: ["findMany", "findMany"] })).map(
				(i) => i.code,
			),
		).toEqual(["duplicate_action"]);
	});
});

describe("normalization", () => {
	test("inMemory is its named form with empty options", () => {
		const forms = [
			"inMemory",
			{ use: "inMemory" },
			{ use: "inMemory", options: {} },
		];
		const normalized = forms.map((provider) =>
			normalizeSpec(spec({ provider } as never)),
		);
		for (const each of normalized) expect(each).toEqual(normalized[0]);
		expect(normalized[0]?.provider).toEqual({ use: "inMemory", options: {} });
		expect(generate(spec({ provider: "inMemory" }))).toEqual(
			generate(spec({ provider: { use: "inMemory", options: {} } })),
		);
	});

	test("an omitted provider is never a shared one", () => {
		const shared = spec({ provider: "inMemory" });
		const own = spec({}, { provider: "inMemory" });
		const none = spec();
		expect(normalizeSpec(none).provider).toBeUndefined();
		expect(normalizeSpec(none).repositories?.Users?.provider).toBeUndefined();
		expect(normalizeSpec(shared)).not.toEqual(normalizeSpec(none));
		expect(normalizeSpec(own)).not.toEqual(normalizeSpec(none));
		expect(normalizeSpec(own)).not.toEqual(normalizeSpec(shared));
	});
});

describe("generation", () => {
	const full = spec(
		{
			provider: {
				use: "memory",
				options: { label: "app", store: { import: "../store#store" } },
			},
		},
		{ provider: "inMemory" },
	);

	test("emits expressions and named imports", () => {
		const files = Object.fromEntries(
			generate(full, {}, { providers }).map((f) => [f.path, f.contents]),
		);
		expect(files).toMatchSnapshot();
		expect(files["src/domain/application.ts"]).toContain(
			'provider: memoryProvider({ label: "app", store })',
		);
		expect(files["src/domain/repositories.ts"]).toContain(
			"provider: inMemoryProvider()",
		);
	});

	test("imports a hand-written provider", () => {
		const files = generate(spec({ provider: { import: "../db#provider" } }));
		const application = files.find((f) => f.path.endsWith("application.ts"));
		expect(application?.contents).toContain(
			'import { provider } from "../db";',
		);
		expect(application?.contents).toContain("provider,");
	});

	test("aliases an import whose name is taken", () => {
		const input = spec(
			{
				provider: { use: "memory", options: { store: { import: "./x#User" } } },
			},
			{},
		);
		const files = generate(input, {}, { providers });
		const application = files.find((f) => f.path.endsWith("application.ts"));
		expect(application?.contents).toContain("User as User2");
		const repo = generate(input, {}, { providers }).find((f) =>
			f.path.endsWith("repositories.ts"),
		);
		expect(repo?.contents).not.toContain("provider");
	});

	test("refuses an unknown catalog provider", () => {
		expect(() => generate(spec({ provider: { use: "memory" } }))).toThrow(
			/unknown_provider|not a provider of the catalog/,
		);
	});

	test("the generated project is clean for Biome and type-checks", async () => {
		const { dir } = await build(full);
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

describe("JSON -> generate -> run -> extract", () => {
	test("inMemory at the application", async () => {
		const input = spec({ provider: "inMemory" });
		const { App } = await build(input);
		expect(await exercise(App)).toEqual(EXPECTED);
		expect(App.describe().provider).toEqual({
			kind: "provider",
			name: "inMemory",
			options: {},
		});
		expect(App.describe().repositories.Users.provider).toBeUndefined();
		expect(App.describe().repositories.Users.actions).toEqual(
			expect.arrayContaining(["findMany", "exists", "findPage"]),
		);
		const extracted = extractSpec(App);
		expect(extracted.provider).toBe("inMemory");
		expect(normalizeSpec(extracted)).toEqual(normalizeSpec(input));
	});

	test("a catalog provider with options and an import, per application and repository", async () => {
		const input = spec(
			{
				provider: {
					use: "memory",
					options: {
						label: "app",
						tags: ["a"],
						store: { import: "../store#store" },
					},
				},
			},
			{ provider: { use: "memory", options: { label: "repo" } } },
		);
		const { dir, App } = await build(input);
		expect(await exercise(App)).toEqual(EXPECTED);
		expect(App.describe().provider).toEqual({
			kind: "provider",
			name: "memory",
			options: { label: "app", tags: ["a"] },
		});
		expect(App.describe().repositories.Users.provider).toEqual({
			kind: "provider",
			name: "memory",
			options: { label: "repo", tags: [] },
		});
		// The import was evaluated by the generated code, not by the validator.
		const { created } = await import(join(dir, "src/providers.ts"));
		expect(
			created.map((options: { store?: unknown }) => options.store),
		).toContainEqual({ id: "the-store" });
		// Extracted options are the JSON ones given to providerOf.
		const extracted = extractSpec(App);
		expect(extracted.provider).toEqual({
			use: "memory",
			options: { label: "app", tags: ["a"] },
		});
		expect(extracted.repositories?.Users?.provider).toEqual({
			use: "memory",
			options: { label: "repo", tags: [] },
		});
	});

	test("a hand-written provider import", async () => {
		const input = spec({ provider: { import: "../anon#anonymous" } });
		const { App } = await build(input);
		expect(await exercise(App)).toEqual(EXPECTED);
		expect(App.describe().provider).toEqual({ kind: "opaque" });
		expect(() => extractSpec(App)).toThrow(ExtractionError);
		const extracted = extractSpec(App, {
			imports: { provider: "../anon#anonymous" },
		});
		expect(normalizeSpec(extracted)).toEqual(normalizeSpec(input));
	});
});

describe("hand-written -> extract -> generate", () => {
	class User extends entityOf(
		blueprintOf((ctx) => ({ name: ctx.string, age: ctx.integer })),
	) {}
	const handwritten = (provider: unknown, repositoryProvider?: unknown) => {
		const Users = repositoryOf({
			entity: User,
			actions: ACTIONS as never,
			...(repositoryProvider === undefined
				? {}
				: { provider: repositoryProvider as never }),
		});
		return applicationOf({
			name: "accounts",
			entities: { User },
			repositories: { Users },
			...(provider === undefined ? {} : { provider: provider as never }),
		});
	};

	test("a named provider keeps its name and options", async () => {
		const named = providerOf({
			name: "memory",
			options: { label: "hand", tags: ["x"] },
			create: () => inMemoryProvider(),
		});
		const original = handwritten(named);
		expect(await exercise(original as never)).toEqual(EXPECTED);
		const extracted = extractSpec(original);
		expect(extracted.provider).toEqual({
			use: "memory",
			options: { label: "hand", tags: ["x"] },
		});
		const { App } = await build(extracted);
		expect(await exercise(App)).toEqual(EXPECTED);
		expect(App.describe().provider).toEqual(original.describe().provider);
		expect(extractSpec(App)).toEqual(extracted);
	});

	test("inMemory at the application and on the repository", async () => {
		const original = handwritten(undefined, inMemoryProvider());
		const extracted = extractSpec(original);
		expect(extracted.provider).toBeUndefined();
		expect(extracted.repositories?.Users?.provider).toBe("inMemory");
		const { App } = await build(extracted);
		expect(await exercise(App)).toEqual(EXPECTED);
		expect(App.describe().provider).toBeUndefined();
		expect(App.describe().repositories.Users.provider).toEqual(
			original.describe().repositories.Users.provider,
		);
		expect(generate(extractSpec(App))).toEqual(generate(extracted));
	});

	test("an anonymous provider needs an import mapping", async () => {
		const anonymous = (await import((await anonDir()) as string)).anonymous;
		const app = handwritten(anonymous);
		expect(() => extractSpec(app)).toThrow(/imports.*"provider"/s);
		expect(() => extractSpec(handwritten(undefined, anonymous))).toThrow(
			/repositories\.Users\.provider/,
		);
		const extracted = extractSpec(app, {
			imports: { provider: "../anon#anonymous" },
		});
		expect(extracted.provider).toEqual({ import: "../anon#anonymous" });
		const { App } = await build(extracted);
		expect(await exercise(App)).toEqual(EXPECTED);
		expect(App.describe().provider).toEqual({ kind: "opaque" });

		const onRepository = extractSpec(handwritten(undefined, anonymous), {
			imports: { "repositories.Users.provider": "../anon#anonymous" },
		});
		expect(onRepository.repositories?.Users?.provider).toEqual({
			import: "../anon#anonymous",
		});
		const rebuilt = await build(onRepository);
		expect(await exercise(rebuilt.App)).toEqual(EXPECTED);
	});
});

async function anonDir(): Promise<string> {
	const dir = await makeProject([], EXTRA);
	projects.push(dir);
	return join(dir, "src/anon.ts");
}
