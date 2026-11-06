import { mkdir, readdir } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import {
	type CodegenOptions,
	compactSpec,
	generate,
	normalizeSpec,
	type ResolvedSpec,
	type Spec,
} from "../../src";
import { BIOME, makeProject, removeProject, run } from "../project";

// biome-ignore lint/suspicious/noExplicitAny: generated applications are loaded dynamically
export type Any = any;

const SUPPORT = resolve(import.meta.dir, "support");

/** One spec of a project: where it lives, what it extends and its own output directory. */
export interface Layout {
	/** The root of this spec inside the project (`"."` for the only one). */
	readonly root: string;
	readonly spec: Spec;
	readonly extended?: Record<string, ResolvedSpec>;
}

export interface Project {
	readonly dir: string;
	/** The `index.ts` of each root, imported. */
	readonly domains: Record<string, Any>;
	/** Output directories (absolute) of every root. */
	readonly outputs: string[];
}

const projects: string[] = [];

/** Removes every project made by `buildProject`. */
export const cleanProjects = () =>
	Promise.all(projects.splice(0).map(removeProject));

/** What `canonical` compares: the normalized, compact form of a spec. */
export const canonical = (
	spec: Spec,
	extended?: Record<string, ResolvedSpec>,
) => compactSpec(normalizeSpec(spec, extended));

async function supportFiles(): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const name of await readdir(SUPPORT)) {
		files[`support/${name}`] = await Bun.file(join(SUPPORT, name)).text();
	}
	return files;
}

/**
 * Generates every spec into a fresh project, with the shared `support/` files
 * next to the generated code of each root, and imports the applications.
 */
export async function buildProject(
	layouts: readonly Layout[],
	options: CodegenOptions = {},
	extra: Readonly<Record<string, string>> = {},
): Promise<Project> {
	const support = await supportFiles();
	const files = layouts.flatMap(({ root, spec, extended }) =>
		generate(spec, extended, options).map((file) => ({
			...file,
			path: posix.join(root, file.path),
		})),
	);
	const extras: Record<string, string> = {};
	for (const { root } of layouts) {
		for (const [path, contents] of Object.entries(support)) {
			extras[posix.join(root, "src", path)] = contents;
		}
	}
	for (const [path, contents] of Object.entries(extra)) extras[path] = contents;
	const dir = await makeProject(files, extras, ["**/*.ts"]);
	projects.push(dir);
	const domains: Record<string, Any> = {};
	const outputs: string[] = [];
	for (const { root, spec } of layouts) {
		const out = join(dir, root, spec.output?.dir ?? "src/domain");
		outputs.push(out);
		domains[root] = await import(join(out, "index.ts"));
	}
	return { dir, domains, outputs };
}

/** Biome (the repository's rules) and the TypeScript compiler find nothing in the project. */
export async function lintAndTypecheck(project: Project): Promise<void> {
	await mkdir(project.dir, { recursive: true });
	await Bun.write(
		join(project.dir, "biome.json"),
		JSON.stringify({
			formatter: { indentStyle: "tab" },
			javascript: { formatter: { quoteStyle: "double" } },
			linter: { rules: { preset: "recommended" } },
			assist: { actions: { source: { organizeImports: "on" } } },
		}),
	);
	const biome = await run(
		project.dir,
		BIOME,
		"check",
		`--config-path=${project.dir}`,
		...project.outputs,
	);
	if (biome.code !== 0 || biome.output.includes("error")) {
		throw new Error(`Biome is not clean:\n${biome.output}`);
	}
	const tsc = await run(
		project.dir,
		"bunx",
		"tsc",
		"--noEmit",
		"-p",
		project.dir,
	);
	if (tsc.code !== 0 || tsc.output !== "") {
		throw new Error(`tsc is not clean:\n${tsc.output}`);
	}
}
