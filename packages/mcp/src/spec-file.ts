import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import {
	COLLECTION_KEYS,
	type CodegenOptions,
	confinePath,
	type EventPolicyCatalogEntry,
	type ProviderCatalogEntry,
	projectBoundaryIssues,
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
	/** External event policies a command may name (`publishEvents` is built in). */
	readonly policies?: readonly EventPolicyCatalogEntry[];
}

/** What codegen needs from the project besides the spec. */
export function codegenOptionsOf(project: Project): CodegenOptions {
	return {
		...(project.providers ? { providers: project.providers } : {}),
		...(project.stages ? { stages: project.stages } : {}),
		...(project.policies ? { policies: project.policies } : {}),
	};
}

/** The project directory, resolved; it must exist. */
export async function openProject(
	directory: string,
	app?: string,
	providers?: readonly ProviderCatalogEntry[],
	stages?: readonly StageCatalogEntry[],
	policies?: readonly EventPolicyCatalogEntry[],
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
		...(policies ? { policies } : {}),
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
	let text: string;
	try {
		text = await readFile(confined.absolute, "utf8");
	} catch {
		throw new ToolError(`${SPEC_FILE} cannot be read.`);
	}
	try {
		return JSON.parse(text) as Spec;
	} catch {
		// Never the engine's message: it can quote the text of the file.
		throw new ToolError(`${SPEC_FILE} is not valid JSON.`);
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
			extended: await resolveExtended(spec, join(project.root, SPEC_FILE), {
				root: project.root,
			}),
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
					// Paths in the project are given from its root.
					message: error.message.split(`${project.root}${sep}`).join(""),
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
	// A spec that extends a file outside the project is not followed there.
	const leaves = projectBoundaryIssues(spec, project.root).some(
		(issue) => issue.path[0] === "extends",
	);
	const loaded =
		typeof spec === "object" && spec !== null && !leaves
			? await extendedOf(project, spec as Spec)
			: { extended: {}, issues: [] };
	// The spec comes from an agent: nothing it names may leave the project.
	const boundary = projectBoundaryIssues(spec, project.root);
	// When loading what it extends failed, the loader says why (a spec that
	// leaves the project, a cycle, a missing file): its message replaces the
	// "not loaded" of validateSpec.
	const failed = loaded.issues.length > 0;
	const issues = [
		...boundary,
		...validateSpec(spec, loaded.extended, codegenOptionsOf(project)).filter(
			(issue) => !failed || issue.code !== "unresolved_extends",
		),
	];
	const known = new Set(
		issues.map((issue) => `${issue.code}@${issue.path.join(".")}`),
	);
	return {
		extended: loaded.extended,
		issues: [
			...issues,
			...loaded.issues.filter(
				(issue) => !known.has(`${issue.code}@${issue.path.join(".")}`),
			),
		],
	};
}
