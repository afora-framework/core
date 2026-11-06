import {
	catalog,
	type ProviderCatalogEntry,
	type StageCatalogEntry,
	specSchema,
} from "@afora/codegen";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ToolError } from "./extract";
import { GUIDE } from "./guide";
import { openProject, type Project } from "./spec-file";
import { tools } from "./tools";

export interface ServerOptions {
	/** The project directory; every write stays inside it. The current directory by default. */
	readonly project?: string;
	/** `src/app.ts#App`: an application to extract the spec from when there is no afora.json. */
	readonly app?: string;
	/** External providers the spec's `provider.use` may name; `inMemory` is built in. */
	readonly providers?: readonly ProviderCatalogEntry[];
	/** External stages an output's `pipe` may name; `select` and `openapi` are built in. */
	readonly stages?: readonly StageCatalogEntry[];
}

const RESOURCES = [
	{
		uri: "afora://spec/schema",
		name: "afora.json JSON Schema",
		description: "The JSON Schema of afora.json (version 1).",
		mimeType: "application/json",
		read: () => JSON.stringify(specSchema, null, 2),
	},
	{
		uri: "afora://catalog",
		name: "afora catalog",
		description:
			"Std properties and their `with` options, record plugins, reserved keys and repository rules, read from @afora/core.",
		mimeType: "application/json",
		read: () => JSON.stringify(catalog(), null, 2),
	},
	{
		uri: "afora://spec/guide",
		name: "afora.json guide",
		description:
			"A short guide to writing afora.json: workflow, shape, fields and the rules the validator enforces.",
		mimeType: "text/markdown",
		read: () => GUIDE,
	},
] as const;

/**
 * An MCP server for the project: tools to read, edit, validate and generate
 * its afora.json, and resources with the schema, the catalog and a guide.
 * Connect it to any transport.
 */
export async function createServer(
	options: ServerOptions = {},
): Promise<Server> {
	const project: Project = await openProject(
		options.project ?? process.cwd(),
		options.app,
		options.providers,
		options.stages,
	);
	const server = new Server(
		{ name: "afora", version: "1.0.0" },
		{
			capabilities: { tools: {}, resources: {} },
			instructions:
				"Builds a domain from an afora.json: afora_catalog to see what exists, afora_spec_read, then afora_spec_upsert (one declaration at a time) or afora_spec_write, afora_spec_validate and afora_generate. Read the resource afora://spec/guide for the format and rules. Never edit the generated files; change the spec.",
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema as { type: "object" },
			annotations: {
				readOnlyHint: tool.readOnly,
				destructiveHint: false,
				openWorldHint: false,
			},
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = tools.find(
			(candidate) => candidate.name === request.params.name,
		);
		if (!tool) {
			return {
				isError: true,
				content: [
					{ type: "text", text: `Unknown tool "${request.params.name}".` },
				],
			};
		}
		try {
			const result = await tool.handle(
				(request.params.arguments ?? {}) as Record<string, unknown>,
				project,
			);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		} catch (error) {
			const message =
				error instanceof ToolError || error instanceof Error
					? error.message
					: String(error);
			return { isError: true, content: [{ type: "text", text: message }] };
		}
	});

	server.setRequestHandler(ListResourcesRequestSchema, async () => ({
		resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({
			uri,
			name,
			description,
			mimeType,
		})),
	}));

	server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
		const resource = RESOURCES.find(
			(candidate) => candidate.uri === request.params.uri,
		);
		if (!resource) throw new Error(`Unknown resource ${request.params.uri}.`);
		return {
			contents: [
				{
					uri: resource.uri,
					mimeType: resource.mimeType,
					text: resource.read(),
				},
			],
		};
	});

	return server;
}
