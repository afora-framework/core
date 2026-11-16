import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { confinePath, type Spec } from "@afora/codegen";
import { run } from "./process";

const START = "\n<<<AFORA_SPEC>>>\n";
const END = "\n<<<END_AFORA_SPEC>>>\n";
const ERROR = "\n<<<AFORA_ERROR>>>";

/** The extensions of a module an application may be imported from. */
const APP_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);

/** Why the subprocess failed, by the code it printed; nothing of the module is passed on. */
const FAILURES: Readonly<
	Record<string, (file: string, name: string) => string>
> = {
	import_failed: (file) =>
		`Could not extract the application (import_failed): importing ${file} failed. Its error is not shown here; run \`bun ${file}\` in the project to see it.`,
	not_an_application: (file, name) =>
		`Could not extract the application (not_an_application): ${file} does not export an application named "${name}".`,
	extract_failed: (file) =>
		`Could not extract the application (extract_failed): ${file} was imported, but describing its application failed. Its error is not shown here.`,
};

/** Raised for a problem the agent can act on. */
export class ToolError extends Error {
	override readonly name = "ToolError";
}

function childPath(): string {
	for (const extension of ["js", "ts"]) {
		const url = new URL(`./extract-child.${extension}`, import.meta.url);
		const path = fileURLToPath(url);
		if (existsSync(path)) return path;
	}
	throw new ToolError("The extract helper is missing from the installation.");
}

/** `src/app.ts#App` taken apart. */
function parseAppReference(reference: string): {
	file: string;
	name: string;
} {
	const [file, name = "App"] = reference.split("#");
	if (!file) {
		throw new ToolError(
			'Expected "path/to/file.ts#ExportName", e.g. "src/app.ts#App".',
		);
	}
	return { file, name };
}

/**
 * The application a tool imports: `given` by the agent, else the one the
 * server was started with. When the server was started with `--app`, the
 * agent may name another export of that module, never another module: the
 * subprocess runs whatever module it imports.
 */
export function applicationOf(
	root: string,
	given: unknown,
	configured?: string,
): string | undefined {
	if (typeof given !== "string") return configured;
	if (configured !== undefined) {
		const same =
			resolve(root, parseAppReference(given).file) ===
			resolve(root, parseAppReference(configured).file);
		if (!same) {
			throw new ToolError(
				`The server was started with --app ${configured}: only that module can be imported, not ${given}.`,
			);
		}
	}
	return given;
}

/**
 * Imports the application `reference` ("src/app.ts#App", a path inside the
 * project) in a Bun subprocess and gives its spec. The subprocess runs the
 * module, so it needs Bun; nothing is written.
 */
export async function extractFromApp(
	root: string,
	reference: string,
	outputDir?: string,
	imports?: Readonly<Record<string, string>>,
): Promise<Spec> {
	return (await importApp(root, reference, outputDir, imports)) as Spec;
}

/**
 * What the application `reference` says of itself (`app.describe()`), read
 * the same way. Unlike a spec, it needs no `imports`: hand-written code is
 * described as opaque.
 */
export function describeApp(root: string, reference: string): Promise<unknown> {
	return importApp(root, reference, "--describe");
}

async function importApp(
	root: string,
	reference: string,
	outputDir?: string,
	imports?: Readonly<Record<string, string>>,
): Promise<unknown> {
	const { file, name } = parseAppReference(reference);
	if (!APP_EXTENSIONS.has(extname(file).toLowerCase())) {
		throw new ToolError(
			`The application file ${file} is not a module: give a .ts, .tsx, .mts, .js or .mjs file.`,
		);
	}
	// Inside the project, not in node_modules or .git, not through a link out.
	const confined = await confinePath(root, file);
	if (!confined.ok) {
		throw new ToolError(`The application file ${file} is ${confined.reason}.`);
	}
	if (!existsSync(confined.absolute)) {
		throw new ToolError(`The application file ${file} does not exist.`);
	}
	const real = await realpath(confined.absolute);
	const bun = process.versions.bun ? process.execPath : "bun";
	const result = await run(
		bun,
		[
			childPath(),
			real,
			name,
			outputDir ?? "",
			...(imports ? [JSON.stringify(imports)] : []),
		],
		{ cwd: root, timeoutMs: 60_000 },
	);
	if (result.missing) {
		throw new ToolError(
			"Bun is needed to import the application and was not found on PATH.",
		);
	}
	if (result.timedOut)
		throw new ToolError("Importing the application timed out.");
	const start = result.output.indexOf(START);
	const end = result.output.indexOf(END, start);
	if (result.code !== 0 || start === -1 || end === -1) {
		// What the module printed, threw or failed to parse is not passed on.
		const at = result.output.lastIndexOf(ERROR);
		const code =
			at === -1
				? undefined
				: result.output.slice(at + ERROR.length).split("\n", 1)[0];
		if (code === "extraction_error") {
			const line = result.output.slice(at + ERROR.length).split("\n", 2)[1];
			let message: unknown;
			try {
				message = JSON.parse(line ?? "");
			} catch {}
			if (typeof message === "string") {
				throw new ToolError(`Could not extract the application: ${message}`);
			}
		}
		const failure =
			code !== undefined && Object.hasOwn(FAILURES, code)
				? FAILURES[code]
				: undefined;
		throw new ToolError(
			failure
				? failure(file, name)
				: `Could not extract the application (extract_failed): the subprocess importing ${file} exited with code ${result.code}. Its output is not shown here; run \`bun ${file}\` in the project to see it.`,
		);
	}
	return JSON.parse(result.output.slice(start + START.length, end));
}
