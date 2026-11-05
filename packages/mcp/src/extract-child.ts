/**
 * Runs in a Bun subprocess: imports the application of the project and prints
 * its spec between markers, so what the application logs cannot be mistaken for it.
 */
import { pathToFileURL } from "node:url";
import { extractSpec } from "@afora/codegen";

const START = "\n<<<AFORA_SPEC>>>\n";
const END = "\n<<<END_AFORA_SPEC>>>\n";

const [file, name, outputDir] = process.argv.slice(2);
if (!file || !name)
	throw new Error("Usage: extract-child <file> <export> [outputDir]");

const module = (await import(pathToFileURL(file).href)) as Record<
	string,
	unknown
>;
const app = module[name];
if (
	typeof app !== "object" ||
	app === null ||
	typeof (app as { describe?: unknown }).describe !== "function"
) {
	throw new Error(`${file} does not export an application named "${name}".`);
}
const spec = extractSpec(
	app as Parameters<typeof extractSpec>[0],
	outputDir ? { outputDir } : {},
);
process.stdout.write(`${START}${JSON.stringify(spec)}${END}`);
