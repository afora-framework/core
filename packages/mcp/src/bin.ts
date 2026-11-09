#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { ProviderCatalogEntry, StageCatalogEntry } from "@afora/codegen";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server";

const USAGE = `afora-mcp: an MCP server (stdio) to build a domain from an afora.json

Usage: afora-mcp [--project <dir>] [--app <file.ts#Export>] [--providers <module>] [--stages <module>]

  --project  the project directory; all writes stay inside it (default: the current directory)
  --app      an application to extract the spec from when the project has no afora.json, e.g. src/app.ts#App
  --providers a module (path from the project) exporting \`providers\` (or a default export): an array of
              { name, module, export } for the providers the spec's "use" may name (inMemory is built in)
  --stages   the same for the stages an output's pipe may name: \`stages\` (or a default export), an array of
              { name, module, export, kind? } (select and openapi are built in)`;

async function loadCatalog<Entry>(
	path: string,
	key: "providers" | "stages",
): Promise<Entry[]> {
	const module = (await import(pathToFileURL(path).href)) as Record<
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

/** Starts the server on stdio. */
export async function main(argv: string[]): Promise<number> {
	let values: {
		project?: string;
		app?: string;
		providers?: string;
		stages?: string;
		help?: boolean;
	};
	try {
		({ values } = parseArgs({
			args: argv,
			options: {
				project: { type: "string" },
				app: { type: "string" },
				providers: { type: "string" },
				stages: { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		}));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.error(USAGE);
		return 2;
	}
	if (values.help) {
		console.error(USAGE);
		return 0;
	}
	try {
		const providers = values.providers
			? await loadCatalog<ProviderCatalogEntry>(
					resolve(values.project ?? ".", values.providers),
					"providers",
				)
			: undefined;
		const stages = values.stages
			? await loadCatalog<StageCatalogEntry>(
					resolve(values.project ?? ".", values.stages),
					"stages",
				)
			: undefined;
		const server = await createServer({
			...(providers ? { providers } : {}),
			...(stages ? { stages } : {}),
			...(values.project ? { project: values.project } : {}),
			...(values.app ? { app: values.app } : {}),
		});
		await server.connect(new StdioServerTransport());
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
	const code = await main(process.argv.slice(2));
	if (code !== 0) process.exit(code);
}
