import { InvalidOutputStage, toOpenAPI } from "@afora/core";
import {
	coerceTextValues,
	type OperationDescriptor,
	outputValueOf,
	problemOf,
	sinkOf,
	stageCatalogOf,
	statusOf,
} from "@afora/core/adapters";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/** The options of the `mcpTools` sink. JSON, so the stage can live in an `afora.json`. */
export interface McpToolsOptions {
	/** Name of the MCP server that `server()` creates. */
	readonly name: string;
	/** Version of the MCP server that `server()` creates. */
	readonly version: string;
	/** Prepended to every tool name, e.g. `"blog_"`. Empty by default. */
	readonly prefix?: string;
	/** Operation ids to expose (`"Users.register"`); every operation when omitted. */
	readonly include?: readonly string[];
	/**
	 * The context of an operation, by key: `{ token: "authorization" }` fills
	 * `context.token` from the value named `authorization` in the `extra` of
	 * the call (`extra.values`). A missing value leaves the key out.
	 */
	readonly context?: { readonly [contextKey: string]: string };
}

/** One MCP tool: what `tools/list` returns for it. */
export interface McpToolDefinition {
	readonly name: string;
	readonly description: string;
	/** JSON Schema of the operation input: an inline object, with no `$ref`. */
	readonly inputSchema: {
		readonly type: "object";
		readonly [key: string]: unknown;
	};
	/** The operation id the tool runs (`"Users.register"`). */
	readonly operation: string;
}

/**
 * What the host knows about a call. `values` feeds the `context` mapping of
 * the options; `register` fills it from the HTTP headers (lower-case names)
 * and the string entries of the request `_meta`.
 */
export interface McpCallExtra {
	readonly values?: Readonly<Record<string, string | undefined>>;
}

/** The result of a tool call, as MCP expects it. */
export interface McpToolResult {
	readonly isError?: true;
	readonly content: readonly { readonly type: "text"; readonly text: string }[];
}

/** What the `mcpTools` sink builds. */
export interface McpTools {
	readonly tools: readonly McpToolDefinition[];
	/** Runs a tool. Never throws: an unknown tool or an error is `isError: true`. */
	call(
		name: string,
		args?: unknown,
		extra?: McpCallExtra,
	): Promise<McpToolResult>;
	/** Handles `tools/list` and `tools/call` on a low-level MCP SDK `Server`. */
	register(server: Server): Server;
	/** A new `Server` (capability `tools`) with the tools registered. */
	server(): Server;
}

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function validate(options: McpToolsOptions): string | undefined {
	const given = options as unknown as Obj;
	for (const key of Object.keys(given)) {
		if (!["name", "version", "prefix", "include", "context"].includes(key)) {
			return `mcpTools has no option "${key}".`;
		}
	}
	for (const key of ["name", "version"] as const) {
		if (typeof given[key] !== "string" || given[key] === "") {
			return `Expected mcpTools.${key} to be a non-empty string.`;
		}
	}
	const { prefix, include, context } = given;
	if (
		prefix !== undefined &&
		(typeof prefix !== "string" || !/^[A-Za-z0-9_.-]*$/.test(prefix))
	) {
		return "Expected mcpTools.prefix to use only letters, digits, _, . and -.";
	}
	if (
		include !== undefined &&
		(!Array.isArray(include) ||
			include.some((id) => typeof id !== "string" || id === ""))
	) {
		return "Expected mcpTools.include to be a list of operation ids.";
	}
	if (context !== undefined) {
		if (!isObject(context)) return "Expected mcpTools.context to be an object.";
		for (const [key, name] of Object.entries(context)) {
			if (typeof name !== "string" || name === "") {
				return `Expected mcpTools.context["${key}"] to be a value name.`;
			}
		}
	}
	return undefined;
}

const kebab = (text: string) =>
	text
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^A-Za-z0-9_.-]+/g, "_")
		.toLowerCase();

const text = (value: unknown, isError?: true): McpToolResult => ({
	...(isError ? { isError } : {}),
	content: [{ type: "text", text: JSON.stringify(value) }],
});

/**
 * MCP tools for the operations, one per operation, named
 * `{prefix}{command}_{operation}` in snake case (`users_register`).
 *
 * - `inputSchema` is the JSON Schema of the operation input (inline).
 * - A call runs `operation.invoke(args, { context })`. The context comes from
 *   `extra.values` through the `context` option; richer rules, such as
 *   authentication, are a `transform` stage that wraps `invoke`.
 * - Success is one text content with the response as JSON (`outputValueOf`:
 *   sensitive values masked). An error is `isError: true` with the
 *   `problemOf` JSON as text, whose `status` is the one of `statusOf`
 *   (the output `statuses` first); invalid input is a 400 with `issues`.
 * - The result has `tools`, `call(name, args, extra)`, `register(server)`
 *   (handlers on a low-level SDK `Server`) and `server()` (a ready one).
 */
export const mcpTools = sinkOf<McpTools, McpToolsOptions>({
	name: "mcpTools",
	validate,
	build: (operations, options, { output }) => {
		const prefix = options.prefix ?? "";
		const mapping = options.context ?? {};
		const include = options.include;
		if (include) {
			const known = new Set(operations.map((operation) => operation.id));
			const unknown = include.find((id) => !known.has(id));
			if (unknown !== undefined) {
				throw new InvalidOutputStage({
					source: "mcpTools",
					details: {
						reason: `mcpTools.include names "${unknown}", which is not an operation.`,
					},
				});
			}
		}

		const entries = new Map<
			string,
			{ definition: McpToolDefinition; operation: OperationDescriptor }
		>();
		for (const operation of operations) {
			if (include && !include.includes(operation.id)) continue;
			const name = `${prefix}${kebab(operation.command)}_${kebab(operation.name)}`;
			if (name.length > 128 || entries.has(name)) {
				throw new InvalidOutputStage({
					source: "mcpTools",
					details: {
						reason: `mcpTools tool name "${name}" of ${operation.id} is duplicated or longer than 128 characters.`,
					},
				});
			}
			const schema = toOpenAPI(operation.input) as Obj;
			const description = [
				operation.description ?? `${operation.command}.${operation.name}`,
				operation.deprecated ? "Deprecated." : undefined,
			]
				.filter(Boolean)
				.join(" ");
			entries.set(name, {
				operation,
				definition: Object.freeze({
					name,
					description,
					inputSchema: {
						...schema,
						type: "object",
					} as McpToolDefinition["inputSchema"],
					operation: operation.id,
				}),
			});
		}
		const tools = [...entries.values()].map((entry) => entry.definition);

		const call: McpTools["call"] = async (name, args, extra) => {
			const entry = entries.get(name);
			if (!entry) {
				return text(
					{
						type: "urn:afora:exception:NotFound",
						title: "NotFound",
						status: 404,
						detail: `Unknown tool "${name}".`,
					},
					true,
				);
			}
			const { operation } = entry;
			const options_: { context?: unknown } = {};
			if (operation.context) {
				const raw: Record<string, string | undefined> = {};
				for (const key of Object.keys(operation.context.properties)) {
					const source = mapping[key];
					raw[key] = source === undefined ? undefined : extra?.values?.[source];
				}
				options_.context = coerceTextValues(operation.context, raw);
			}
			try {
				const response = await operation.invoke(args ?? {}, options_);
				return text(outputValueOf(response) ?? null);
			} catch (error) {
				const status = statusOf(error, operation, output.statuses);
				return text(problemOf(error, { status }), true);
			}
		};

		const register = (server: Server) => {
			server.setRequestHandler(ListToolsRequestSchema, async () => ({
				tools: tools.map(({ name, description, inputSchema }) => ({
					name,
					description,
					inputSchema,
				})),
			}));
			server.setRequestHandler(
				CallToolRequestSchema,
				async (request, extra) => {
					const values: Record<string, string | undefined> = {};
					const meta = request.params._meta as Obj | undefined;
					for (const [key, value] of Object.entries(meta ?? {})) {
						if (typeof value === "string") values[key] = value;
					}
					const headers = extra.requestInfo?.headers ?? {};
					for (const [key, value] of Object.entries(headers)) {
						const one = Array.isArray(value) ? value[0] : value;
						if (one !== undefined) values[key.toLowerCase()] = one;
					}
					const result = await call(
						request.params.name,
						request.params.arguments,
						{ values },
					);
					return { ...result, content: [...result.content] };
				},
			);
			return server;
		};

		return {
			tools,
			call,
			register,
			server: () =>
				register(
					new Server(
						{ name: options.name, version: options.version },
						{ capabilities: { tools: {} } },
					),
				),
		};
	},
});

/** The runtime catalog of this module: the stage name `mcpTools` resolves to the sink. */
export const McpStages = stageCatalogOf(mcpTools);

/** The catalog entries codegen reads (`--stages @afora/mcp`). */
export const stages = [
	{
		name: "mcpTools",
		module: "@afora/mcp",
		export: "mcpTools",
		kind: "sink",
	},
] as const;
