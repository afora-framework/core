#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extractSpec } from "./extract";
import { generate, InvalidSpecError } from "./generate";
import { loadSpec, SpecLoadError } from "./load";
import {
	changeLine,
	lockOfApplication,
	schemaCheckOf,
	stubOf,
} from "./schema-lock";
import type {
	CodegenOptions,
	EventPolicyCatalogEntry,
	ProviderCatalogEntry,
	SpecIssue,
	StageCatalogEntry,
} from "./spec/types";
import { validateSpec } from "./validate";
import { writeGenerated } from "./write";

const USAGE = `afora-codegen: generate @afora/core code from an afora.json

Usage:
  afora-codegen check [afora.json] [--providers module] [--stages module] [--policies module]
                                                    validate the spec
  afora-codegen generate [afora.json] [--out dir] [--providers module] [--stages module] [--policies module]
                                                    write the code (to output.dir, or --out)
  afora-codegen extract <file.ts>#App [--output-dir dir] [--import key=./file.ts#name]...
                                                    print the afora.json of an application
  afora-codegen schema lock <file.ts>#App [--out afora.lock.json] [--force]
                                                    write the schema lock of the application
  afora-codegen schema check <file.ts>#App [--lock afora.lock.json]
                                                    fail when the lock is stale or a change
                                                    is not declared

--providers is a module exporting \`providers\` (or a default export): an array of
{ name, module, export } entries for the providers "use" may name (inMemory is built in).
--stages is the same for the stages an output pipe may name: a module exporting \`stages\`
(or a default export), an array of { name, module, export, kind? } entries (select and openapi
are built in).
--policies is the same for the event policies a command may name: a module exporting \`policies\`
(or a default export), an array of { name, module, export } entries (publishEvents is built in).
--import maps what cannot be described to the export it is imported from: a provider
created without providerOf ("provider", "repositories.<Name>.provider" or
"providers.<key>"), a use case
with a hand-written execute ("useCases.<Name>") or a run function of a steps use case
("useCases.<Name>.run.<name>"), a command handler ("commands.<Name>.events" or
"commands.<Name>.onEventError"), a publisher ("publishers.<key>"), a stage written by hand
("outputs.<Name>.pipe.<index>") or an upgrade step of an entity ("entities.<Name>.upgrade.<n>").
schema lock refuses to replace a lock when a change needs a declaration the code lacks
(a fill, renamedFrom, previousNames or an upgrade step) unless --force; schema check prints
an upgrade stub for each missing step.
extract imports the file: use Bun, or Node >= 23.6 for TypeScript files.`;

/** A catalog exported by a module: `key`, or the default export. */
async function loadCatalog<Entry>(
	path: string | undefined,
	key: "providers" | "stages" | "policies",
): Promise<readonly Entry[] | undefined> {
	if (path === undefined) return undefined;
	const module = (await import(pathToFileURL(resolve(path)).href)) as Record<
		string,
		unknown
	>;
	const entries = module[key] ?? module.default;
	if (!Array.isArray(entries)) {
		throw new Error(
			`${path} must export \`${key}\` (or a default export): an array of { name, module, export }.`,
		);
	}
	return entries as Entry[];
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

/** The application `target` (`file.ts#Name`) exports; prints why not and gives `undefined`. */
async function loadApplication(
	target: string | undefined,
	command: string,
): Promise<Parameters<typeof extractSpec>[0] | undefined> {
	if (!target?.includes("#")) {
		console.error(`${command} needs <file.ts>#ExportName.\n`);
		console.error(USAGE);
		return undefined;
	}
	const [path, name] = target.split("#") as [string, string];
	const module = (await import(pathToFileURL(resolve(path)).href)) as Record<
		string,
		unknown
	>;
	const app = module[name];
	if (
		typeof app !== "object" ||
		app === null ||
		typeof (app as { describe?: unknown }).describe !== "function"
	) {
		console.error(`${path} does not export an application named ${name}.`);
		return undefined;
	}
	return app as Parameters<typeof extractSpec>[0];
}

/** `schema lock` and `schema check`; gives the exit code. */
async function schema(args: string[]): Promise<number> {
	const sub = args.shift();
	if (sub !== "lock" && sub !== "check") {
		console.error(USAGE);
		return 2;
	}
	const file = resolve(
		flag(args, sub === "lock" ? "--out" : "--lock") ?? "afora.lock.json",
	);
	const force = args.includes("--force");
	const app = await loadApplication(
		args.find((arg) => arg !== "--force"),
		`schema ${sub}`,
	);
	if (!app) return 1;
	const current = lockOfApplication(app);
	const exists = existsSync(file);
	if (!exists && sub === "check") {
		console.error(
			`${file} does not exist: write it with afora-codegen schema lock.`,
		);
		return 1;
	}
	const check = exists
		? schemaCheckOf(JSON.parse(readFileSync(file, "utf8")), current)
		: undefined;
	const blocking =
		check !== undefined &&
		(check.unsatisfied.length > 0 ||
			check.problems.length > 0 ||
			check.missingSteps.length > 0);
	const explain = () => {
		if (!check) return;
		for (const problem of check.problems) console.error(problem);
		for (const missing of check.missingSteps) {
			if (missing.bump) {
				console.error(
					`${missing.entity}: schemaVersion must go above ${missing.locked} for its upgrade step.`,
				);
			}
		}
		if (check.missingSteps.length > 0) {
			console.error("\nAdd to the options of entityOf:\n");
			for (const missing of check.missingSteps) {
				console.error(`${stubOf(missing)}\n`);
			}
		}
	};
	if (sub === "lock") {
		if (blocking && !force) {
			for (const change of check?.unsatisfied ?? []) {
				console.error(changeLine(change));
			}
			explain();
			console.error(
				`Not written: declare what the changes need, or pass --force.`,
			);
			return 1;
		}
		writeFileSync(file, `${JSON.stringify(current, null, "\t")}\n`);
		console.log(`wrote ${file}`);
		return 0;
	}
	const changes = check?.changes ?? [];
	if (changes.length === 0 && !blocking) {
		console.log(`${file} is up to date.`);
		return 0;
	}
	for (const change of changes) console.error(changeLine(change));
	explain();
	if (changes.length > 0) {
		console.error(
			`${file} is stale: ${changes.length} change${changes.length === 1 ? "" : "s"}; update it with afora-codegen schema lock.`,
		);
	}
	return 1;
}

/** Runs the CLI; returns the exit code. */
export async function main(argv: string[]): Promise<number> {
	const args = [...argv];
	const command = args.shift();
	try {
		if (command === "check" || command === "generate") {
			const out = flag(args, "--out");
			const providers = await loadCatalog<ProviderCatalogEntry>(
				flag(args, "--providers"),
				"providers",
			);
			const stages = await loadCatalog<StageCatalogEntry>(
				flag(args, "--stages"),
				"stages",
			);
			const policies = await loadCatalog<EventPolicyCatalogEntry>(
				flag(args, "--policies"),
				"policies",
			);
			const options: CodegenOptions = {
				...(providers ? { providers } : {}),
				...(stages ? { stages } : {}),
				...(policies ? { policies } : {}),
			};
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
		if (command === "schema") return await schema(args);
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
