import { InvalidOutputStage, type Principal, toOpenAPI } from "@afora/core";
import {
	type Authenticator,
	coerceTextValues,
	type HttpOptions,
	httpOptionsIssue,
	type OperationDescriptor,
	outputValueOf,
	problemOf,
	sinkOf,
	stageCatalogOf,
	statusOf,
} from "@afora/core/adapters";
import { jwtOf } from "@afora/core/experimental";
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
	/**
	 * Who calls, from a JSON Web Token in the values of the call: the
	 * `auth` of the sinks that serve HTTP (experimental). The token is read
	 * from the value `authorization` (`Bearer <token>`; another with
	 * `header`), which `register` fills from the HTTP headers and the
	 * request `_meta`. An `authenticator` given in the hooks replaces it.
	 */
	readonly auth?: HttpOptions["auth"];
}

/** What the `mcpTools` sink takes that JSON cannot hold: `mcpTools(options, hooks)`. */
export interface McpToolsHooks {
	/**
	 * Who calls a tool: `request.header(name)` reads the values of the call
	 * (`extra.values`), and `request.native` is the `extra` itself. Asked
	 * for each operation with an `access` other than `public`; without it
	 * (and without `auth`) those tools answer a 401 problem.
	 */
	readonly authenticator?: Authenticator;
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
	/**
	 * Hints for the client, from the route the use case declares: a `get` is
	 * read-only, a `delete` destructive. Absent without a route.
	 */
	readonly annotations?: {
		readonly readOnlyHint: boolean;
		readonly destructiveHint: boolean;
	};
}

/**
 * What the host knows about a call. `values` feeds the `context` mapping of
 * the options; `register` fills it from the HTTP headers (lower-case names)
 * and the string entries of the request `_meta`.
 */
export interface McpCallExtra {
	readonly values?: Readonly<Record<string, string | undefined>>;
	/**
	 * Who calls, when the host already knows: used as is, in place of the
	 * authenticator. `null` is an anonymous caller.
	 */
	readonly principal?: Principal | null;
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
		if (
			!["name", "version", "prefix", "include", "context", "auth"].includes(key)
		) {
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
	if (given.auth !== undefined) {
		return httpOptionsIssue({ auth: options.auth } as HttpOptions, "mcpTools");
	}
	return undefined;
}

/** What the access of an operation asks of the caller, for the description of its tool. */
function accessNote(operation: OperationDescriptor): string | undefined {
	const access = operation.access;
	if (!access || access.public === true) return undefined;
	const scopes = access.scopes ?? [];
	return scopes.length > 0
		? `Requires an authenticated caller with the scopes: ${scopes.join(", ")}.`
		: "Requires an authenticated caller.";
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
 * - A call runs `operation.invoke(args, { context, principal })`. The context
 *   comes from `extra.values` through the `context` option.
 * - An operation with an `access` asks who calls: `extra.principal`, else
 *   the `authenticator` hook, else the token of `auth`. The caller is checked
 *   before the tool runs (a 401 or 403 problem), and with neither such a tool
 *   always answers 401. Its description says what it requires.
 * - Success is one text content with the response as JSON (`outputValueOf`:
 *   sensitive values masked). An error is `isError: true` with the
 *   `problemOf` JSON as text, whose `status` is the one of `statusOf`
 *   (the output `statuses` first); invalid input is a 400 with `issues`.
 * - The result has `tools`, `call(name, args, extra)`, `register(server)`
 *   (handlers on a low-level SDK `Server`) and `server()` (a ready one).
 */
export const mcpTools = sinkOf<McpTools, McpToolsOptions, McpToolsHooks>({
	name: "mcpTools",
	validate,
	build: (operations, options, { output }, hooks) => {
		let authenticator = hooks?.authenticator;
		if (!authenticator && options.auth) {
			const { header, cookie, ...jwt } = options.auth.jwt;
			authenticator = jwtOf(jwt).authenticator({
				...(header === undefined ? {} : { header }),
				...(cookie === undefined ? {} : { cookie }),
			});
		}
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
				accessNote(operation),
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
					...(operation.route
						? {
								annotations: {
									readOnlyHint: operation.route.method === "get",
									destructiveHint: operation.route.method === "delete",
								},
							}
						: {}),
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
			const options_: { context?: unknown; principal?: Principal | null } = {};
			if (operation.context) {
				const raw: Record<string, string | undefined> = {};
				for (const key of Object.keys(operation.context.properties)) {
					const source = mapping[key];
					raw[key] = source === undefined ? undefined : extra?.values?.[source];
				}
				options_.context = coerceTextValues(operation.context, raw);
			}
			try {
				if (operation.access && operation.access.public !== true) {
					const values = extra?.values ?? {};
					options_.principal =
						extra?.principal !== undefined
							? extra.principal
							: authenticator
								? await authenticator({
										header: (name) => values[name],
										cookie: () => undefined,
										operation,
										native: extra,
									})
								: null;
				}
				const response = await operation.invoke(args ?? {}, options_);
				return text(outputValueOf(response) ?? null);
			} catch (error) {
				const status = statusOf(error, operation, output.statuses);
				return text(problemOf(error, { status }), true);
			}
		};

		const register = (server: Server) => {
			server.setRequestHandler(ListToolsRequestSchema, async () => ({
				tools: tools.map(({ name, description, inputSchema, annotations }) => ({
					name,
					description,
					inputSchema,
					...(annotations ? { annotations } : {}),
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
