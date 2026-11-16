/**
 * Runs in a Bun subprocess: imports the application of the project and prints
 * its spec (or, with `--describe`, its description) between markers, so what the application logs cannot be mistaken for it.
 */
import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ExtractionError, extractSpec } from "@afora/codegen";

const START = "\n<<<AFORA_SPEC>>>\n";
const END = "\n<<<END_AFORA_SPEC>>>\n";
const ERROR = "\n<<<AFORA_ERROR>>>";

/**
 * Ends with an error code and nothing of the module: what a runtime prints
 * for a module that fails (its source lines, the message it threw) goes back
 * to an agent, and the module may hold what the agent must not read.
 */
function fail(
	code: "import_failed" | "not_an_application" | "extract_failed",
): never {
	writeSync(1, `${ERROR}${code}${END}`);
	process.exit(1);
}

const [file, name, outputDir, importsJson] = process.argv.slice(2);
if (!file || !name)
	throw new Error(
		"Usage: extract-child <file> <export> [outputDir] [importsJson]",
	);

let module: Record<string, unknown>;
try {
	module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
} catch {
	fail("import_failed");
}
const app = module[name];
if (
	typeof app !== "object" ||
	app === null ||
	typeof (app as { describe?: unknown }).describe !== "function"
) {
	fail("not_an_application");
}
let result: unknown;
try {
	// `--describe` in place of the output directory: what the application says
	// of itself, which needs no mapping of what a spec cannot express.
	result =
		outputDir === "--describe"
			? (app as { describe(): unknown }).describe()
			: extractSpec(app as Parameters<typeof extractSpec>[0], {
					...(outputDir ? { outputDir } : {}),
					...(importsJson ? { imports: JSON.parse(importsJson) } : {}),
				});
} catch (error) {
	// What extractSpec cannot express is said by afora, not by the module.
	if (error instanceof ExtractionError) {
		writeSync(
			1,
			`${ERROR}extraction_error\n${JSON.stringify(error.message)}${END}`,
		);
		process.exit(1);
	}
	fail("extract_failed");
}
process.stdout.write(`${START}${JSON.stringify(result)}${END}`);
