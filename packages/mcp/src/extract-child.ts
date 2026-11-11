/**
 * Runs in a Bun subprocess: imports the application of the project and prints
 * its spec (or, with `--describe`, its description) between markers, so what the application logs cannot be mistaken for it.
 */
import { pathToFileURL } from "node:url";
import { extractSpec } from "@afora/codegen";

const START = "\n<<<AFORA_SPEC>>>\n";
const END = "\n<<<END_AFORA_SPEC>>>\n";

const [file, name, outputDir, importsJson] = process.argv.slice(2);
if (!file || !name)
	throw new Error(
		"Usage: extract-child <file> <export> [outputDir] [importsJson]",
	);

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
// `--describe` in place of the output directory: what the application says
// of itself, which needs no mapping of what a spec cannot express.
const result =
	outputDir === "--describe"
		? (app as { describe(): unknown }).describe()
		: extractSpec(app as Parameters<typeof extractSpec>[0], {
				...(outputDir ? { outputDir } : {}),
				...(importsJson ? { imports: JSON.parse(importsJson) } : {}),
			});
process.stdout.write(`${START}${JSON.stringify(result)}${END}`);
