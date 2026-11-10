import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	COLLECTION_KEYS,
	type CodegenOptions,
	confinePath,
	type ProviderCatalogEntry,
	type ResolvedSpec,
	resolveExtended,
	type Spec,
	type SpecIssue,
	SpecLoadError,
	type StageCatalogEntry,
	validateSpec,
} from "@afora/codegen";
import { ToolError } from "./extract";

const SPEC_FILE = "afora.json";

export interface Project {
	/** The real path of the project directory. */
	readonly root: string;
	/** `src/app.ts#App`: where to extract the spec from when there is no afora.json. */
	readonly app?: string;
	/** External providers `use` may name in the spec (`inMemory` is built in). */
	readonly providers?: readonly ProviderCatalogEntry[];
	/** External stages an output's `pipe` may name (`select` and `openapi` are built in). */
	readonly stages?: readonly StageCatalogEntry[];
}

/** What codegen needs from the project besides the spec. */
export function codegenOptionsOf(project: Project): CodegenOptions {
	return {
		...(project.providers ? { providers: project.providers } : {}),
		...(project.stages ? { stages: project.stages } : {}),
	};
}

/** The project directory, resolved; it must exist. */
export async function openProject(
	directory: string,
	app?: string,
	providers?: readonly ProviderCatalogEntry[],
	stages?: readonly StageCatalogEntry[],
): Promise<Project> {
	let root: string;
	try {
		root = await realpath(directory);
	} catch {
		throw new Error(`The project directory ${directory} does not exist.`);
	}
	return {
		root,
		...(app ? { app } : {}),
		...(providers ? { providers } : {}),
		...(stages ? { stages } : {}),
	};
}

/** The spec on disk, or undefined when there is none. */
export async function readSpec(project: Project): Promise<Spec | undefined> {
	const path = join(project.root, SPEC_FILE);
	if (!existsSync(path)) return undefined;
	const confined = await confinePath(project.root, SPEC_FILE);
	if (!confined.ok) {
		throw new ToolError(`${SPEC_FILE} is ${confined.reason}.`);
	}
	try {
		return JSON.parse(await readFile(confined.absolute, "utf8")) as Spec;
	} catch (error) {
		throw new ToolError(
			`${SPEC_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Writes the spec, tab-indented with its keys in a stable order. Confined to the project. */
export async function writeSpec(project: Project, spec: Spec): Promise<void> {
	const confined = await confinePath(project.root, SPEC_FILE);
	if (!confined.ok) {
		throw new ToolError(
			`${SPEC_FILE} is ${confined.reason}; it was not written.`,
		);
	}
	await mkdir(dirname(confined.absolute), { recursive: true });
	await writeFile(
		confined.absolute,
		`${JSON.stringify(ordered(spec), null, "\t")}\n`,
	);
}

const TOP_ORDER = [
	"$schema",
	"version",
	"name",
	"extends",
	"output",
	"provider",
	"providers",
	"log",
	...COLLECTION_KEYS,
];

function ordered(spec: Spec): Spec {
	const source = spec as unknown as Record<string, unknown>;
	const keys = [
		...TOP_ORDER.filter((key) => key in source),
		...Object.keys(source).filter((key) => !TOP_ORDER.includes(key)),
	];
	return Object.fromEntries(
		keys.map((key) => [key, source[key]]),
	) as unknown as Spec;
}

/** The specs `spec` extends, loaded from the project; a failure becomes an issue. */
async function extendedOf(
	project: Project,
	spec: Spec,
): Promise<{ extended: Record<string, ResolvedSpec>; issues: SpecIssue[] }> {
	try {
		return {
			extended: await resolveExtended(spec, join(project.root, SPEC_FILE)),
			issues: [],
		};
	} catch (error) {
		if (!(error instanceof SpecLoadError)) throw error;
		return {
			extended: {},
			issues: [
				{
					path: ["extends"],
					code: "unresolved_extends",
					message: error.message,
				},
			],
		};
	}
}

/** Validates `spec` as the project's, resolving what it extends. */
export async function validateInProject(
	project: Project,
	spec: unknown,
): Promise<{ issues: SpecIssue[]; extended: Record<string, ResolvedSpec> }> {
	const loaded =
		typeof spec === "object" && spec !== null
			? await extendedOf(project, spec as Spec)
			: { extended: {}, issues: [] };
	const issues = validateSpec(spec, loaded.extended, codegenOptionsOf(project));
	const known = new Set(
		issues.map((issue) => `${issue.code}@${issue.path.join(".")}`),
	);
	return {
		extended: loaded.extended,
		issues: [
			...issues,
			...loaded.issues.filter(
				(issue) =>
					!known.has(`${issue.code}@${issue.path.join(".")}`) &&
					!issues.some((other) => other.code === "unresolved_extends"),
			),
		],
	};
}
