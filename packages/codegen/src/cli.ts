#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extractSpec } from "./extract";
import { generate, InvalidSpecError } from "./generate";
import { loadSpec, SpecLoadError } from "./load";
import type { ProviderCatalogEntry, SpecIssue } from "./spec/types";
import { validateSpec } from "./validate";
import { writeGenerated } from "./write";

const USAGE = `afora-codegen: generate @afora/core code from an afora.json

Usage:
  afora-codegen check [afora.json] [--providers module]
                                                    validate the spec
  afora-codegen generate [afora.json] [--out dir] [--providers module]
                                                    write the code (to output.dir, or --out)
  afora-codegen extract <file.ts>#App [--output-dir dir] [--import key=./file.ts#name]...
                                                    print the afora.json of an application

--providers is a module exporting \`providers\` (or a default export): an array of
{ name, module, export } entries for the providers "use" may name (inMemory is built in).
--import maps a provider created without providerOf ("provider" or
"repositories.<Name>.provider") to the export it is imported from.
extract imports the file: use Bun, or Node >= 23.6 for TypeScript files.`;

/** The provider catalog exported by a module: `providers`, or the default export. */
async function loadProviders(
	path: string | undefined,
): Promise<readonly ProviderCatalogEntry[] | undefined> {
	if (path === undefined) return undefined;
	const module = (await import(pathToFileURL(resolve(path)).href)) as Record<
		string,
		unknown
	>;
	const providers = module.providers ?? module.default;
	if (!Array.isArray(providers)) {
		throw new Error(
			`${path} must export \`providers\` (or a default export): an array of { name, module, export }.`,
		);
	}
	return providers as ProviderCatalogEntry[];
}

/** Takes every `--import key=value` out of `args`. */
function importFlags(args: string[]): Record<string, string> {
	const imports: Record<string, string> = {};
	for (
		let value = flag(args, "--import");
		value !== undefined;
		value = flag(args, "--import")
	) {
		const at = value.indexOf("=");
		if (at <= 0)
			throw new Error(`--import expects key=./file.ts#name, got "${value}".`);
		imports[value.slice(0, at)] = value.slice(at + 1);
	}
	return imports;
}

function flag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const [, value] = args.splice(index, 2);
	return value;
}

function report(issues: readonly SpecIssue[]): void {
	for (const item of issues) {
		console.error(
			`${item.path.join(".") || "(root)"}: [${item.code}] ${item.message}`,
		);
	}
	console.error(`${issues.length} problem${issues.length === 1 ? "" : "s"}.`);
}

/** Runs the CLI; returns the exit code. */
export async function main(argv: string[]): Promise<number> {
	const args = [...argv];
	const command = args.shift();
	try {
		if (command === "check" || command === "generate") {
			const out = flag(args, "--out");
			const providers = await loadProviders(flag(args, "--providers"));
			const options = providers ? { providers } : {};
			const file = resolve(args[0] ?? "afora.json");
			const { spec, extended } = await loadSpec(file);
			const issues = validateSpec(spec, extended, options);
			if (issues.length > 0) {
				report(issues);
				return 1;
			}
			if (command === "check") {
				console.log(`${file} is valid.`);
				return 0;
			}
			const files = generate(
				out ? { ...spec, output: { dir: out } } : spec,
				extended,
				options,
			);
			const result = await writeGenerated(dirname(file), files);
			if (result.refused.length > 0) {
				for (const item of result.refused) {
					console.error(`refused ${item.path}: ${item.reason}`);
				}
				return 1;
			}
			for (const path of result.written) console.log(`wrote ${path}`);
			for (const path of result.removed) console.log(`removed ${path}`);
			if (result.written.length === 0 && result.removed.length === 0) {
				console.log("Everything is up to date.");
			}
			return 0;
		}
		if (command === "extract") {
			const outputDir = flag(args, "--output-dir");
			const imports = importFlags(args);
			const target = args[0];
			if (!target?.includes("#")) {
				console.error("extract needs <file.ts>#ExportName.\n");
				console.error(USAGE);
				return 2;
			}
			const [path, name] = target.split("#") as [string, string];
			const module = (await import(
				pathToFileURL(resolve(path)).href
			)) as Record<string, unknown>;
			const app = module[name];
			if (
				typeof app !== "object" ||
				app === null ||
				typeof (app as { describe?: unknown }).describe !== "function"
			) {
				console.error(`${path} does not export an application named ${name}.`);
				return 1;
			}
			const spec = extractSpec(app as Parameters<typeof extractSpec>[0], {
				...(outputDir ? { outputDir } : {}),
				...(Object.keys(imports).length > 0 ? { imports } : {}),
			});
			console.log(JSON.stringify(spec, null, "\t"));
			return 0;
		}
		console.error(USAGE);
		return command === undefined || command === "--help" || command === "-h"
			? 0
			: 2;
	} catch (error) {
		if (error instanceof InvalidSpecError) {
			report(error.issues);
		} else if (error instanceof SpecLoadError) {
			console.error(error.message);
		} else {
			console.error(error instanceof Error ? error.message : String(error));
		}
		return 1;
	}
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
	process.exitCode = await main(process.argv.slice(2));
}
