import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { confinePath, type Spec } from "@afora/codegen";
import { run } from "./process";

const START = "\n<<<AFORA_SPEC>>>\n";
const END = "\n<<<END_AFORA_SPEC>>>\n";

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
 * Imports the application `reference` ("src/app.ts#App", a path inside the
 * project) in a Bun subprocess and gives its spec. The subprocess runs the
 * module, so it needs Bun; nothing is written.
 */
export async function extractFromApp(
	root: string,
	reference: string,
	outputDir?: string,
): Promise<Spec> {
	const { file, name } = parseAppReference(reference);
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
		[childPath(), real, name, ...(outputDir ? [outputDir] : [])],
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
		throw new ToolError(
			`Could not extract the application:\n${result.output.trim().slice(-2000)}`,
		);
	}
	return JSON.parse(result.output.slice(start + START.length, end)) as Spec;
}
