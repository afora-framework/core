import {
	InvalidOutputStage,
	type OpenAPISinkOptions,
	type OperationDescriptor,
	openapi,
	operationRoutes,
	outputValueOf,
	PROBLEM_MEDIA_TYPE,
	problemOf,
	routeOptionsIssue,
	sinkOf,
	stageCatalogOf,
	statusOf,
	toOpenAPI,
} from "@afora/core";
import { Hono } from "hono";

/** The options of the `hono` sink. JSON, so the stage can live in an `afora.json`. */
export interface HonoOptions {
	/** Prefix of every route, e.g. `"/api"`. Empty by default. */
	readonly basePath?: OpenAPISinkOptions["basePath"];
	/** Method and path by operation id, as in the `openapi` sink. */
	readonly route?: OpenAPISinkOptions["route"];
	/** Serves the OpenAPI document of the same operations at `path`. */
	readonly docs?: {
		readonly path: string;
		readonly info: OpenAPISinkOptions["info"];
		readonly servers?: OpenAPISinkOptions["servers"];
	};
	/** Adds the `trace` to problems and the real `detail` to 5xx ones. Off by default. */
	readonly debug?: boolean;
	/** The context of an operation, from request headers: `{ headers: { token: "authorization" } }`. */
	readonly context?: {
		readonly headers?: { readonly [contextKey: string]: string };
	};
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Obj, allowed: readonly string[], where: string) {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) return `${where} has no option "${key}".`;
	}
	return undefined;
}

function validate(options: HonoOptions): string | undefined {
	const given = options as unknown as Obj;
	const bad = onlyKeys(
		given,
		["basePath", "route", "docs", "debug", "context"],
		"hono",
	);
	if (bad) return bad;
	const routing = routeOptionsIssue(options, "hono");
	if (routing) return routing;
	if (given.debug !== undefined && typeof given.debug !== "boolean") {
		return "Expected hono.debug to be a boolean.";
	}
	const { docs, context } = given;
	if (docs !== undefined) {
		if (!isObject(docs)) return "Expected hono.docs to be an object.";
		const docsBad = onlyKeys(docs, ["path", "info", "servers"], "hono.docs");
		if (docsBad) return docsBad;
		if (
			typeof docs.path !== "string" ||
			!docs.path.startsWith("/") ||
			/[{}?#\s:*]/.test(docs.path)
		) {
			return 'Expected hono.docs.path to be a path such as "/openapi.json".';
		}
		// info and servers are checked by the openapi sink, with its messages.
		try {
			openapi({
				info: docs.info,
				...(docs.servers ? { servers: docs.servers } : {}),
			} as OpenAPISinkOptions);
		} catch (error) {
			const reason = (error as { details?: { reason?: string } }).details
				?.reason;
			return (reason ?? "Expected hono.docs to be valid.").replaceAll(
				"openapi.",
				"hono.docs.",
			);
		}
	}
	if (context !== undefined) {
		if (!isObject(context)) return "Expected hono.context to be an object.";
		const contextBad = onlyKeys(context, ["headers"], "hono.context");
		if (contextBad) return contextBad;
		const { headers } = context;
		if (headers !== undefined) {
			if (!isObject(headers)) {
				return "Expected hono.context.headers to be an object.";
			}
			for (const [key, name] of Object.entries(headers)) {
				if (
					typeof name !== "string" ||
					!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)
				) {
					return `Expected hono.context.headers["${key}"] to be a header name.`;
				}
			}
		}
	}
	return undefined;
}

/** What a scalar field of `blueprint` takes, by key (from its OpenAPI type). */
function scalarTypesOf(
	blueprint: OperationDescriptor["input"],
): Readonly<Record<string, readonly string[]>> {
	const schema = toOpenAPI(blueprint) as {
		properties?: Record<string, { type?: string | string[] }>;
	};
	const types: Record<string, readonly string[]> = {};
	for (const [key, property] of Object.entries(schema.properties ?? {})) {
		types[key] = [property.type ?? []].flat();
	}
	return types;
}

/**
 * `text` as the field takes it: a number or boolean when the field is one
 * (and not a string), else as is; invalid text is kept for the blueprint to
 * reject, like environment variables.
 */
function coerce(text: string, types: readonly string[] | undefined): unknown {
	if (!types || types.includes("string")) return text;
	const trimmed = text.trim();
	if (
		types.includes("boolean") &&
		(trimmed === "true" || trimmed === "false")
	) {
		return trimmed === "true";
	}
	if (types.includes("integer") || types.includes("number")) {
		const number = trimmed === "" ? Number.NaN : Number(trimmed);
		if (Number.isFinite(number)) return number;
	}
	return text;
}

function coerceAll(
	values: Readonly<Record<string, string | undefined>>,
	types: Readonly<Record<string, readonly string[]>>,
): Obj {
	const out: Obj = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) out[key] = coerce(value, types[key]);
	}
	return out;
}

function problemResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": PROBLEM_MEDIA_TYPE },
	});
}

function requestProblem(title: string, detail: string): Response {
	return problemResponse(
		{ type: `urn:afora:exception:${title}`, title, status: 400, detail },
		400,
	);
}

/**
 * A Hono app that serves the operations: `POST {basePath}/{command}/{operation}`
 * per operation (kebab-case; `route` changes the method and path as in the
 * `openapi` sink, so the two documents agree).
 *
 * - Body methods read a JSON body, `get` and `delete` the query string, whose
 *   scalars are coerced to numbers and booleans where the input takes them.
 *   The input is validated by the operation (a 400 problem with `issues`).
 * - The context comes from `context.headers` (`{ contextKey: headerName }`);
 *   a missing header leaves the key out. Anything richer, such as
 *   authentication, is a `transform` stage that wraps `invoke`.
 * - Success is a `200` with the response as JSON (`outputValueOf`: sensitive
 *   values masked). Errors are `application/problem+json`, with the status of
 *   `statusOf` (the output `statuses` first). An unknown route is a 404
 *   problem, and anything thrown outside an operation a 500 one.
 * - `docs.path` serves the `openapi` document of the same operations.
 */
export const hono = sinkOf<Hono, HonoOptions>({
	name: "hono",
	validate,
	build: (operations, options, { output }) => {
		const routes = operationRoutes(operations, options, "hono");
		const debug = options.debug === true;
		const headers = options.context?.headers ?? {};
		const app = new Hono();

		const fail = (error: unknown, operation?: OperationDescriptor) => {
			const status = statusOf(error, operation, output.statuses);
			return problemResponse(problemOf(error, { status, debug }), status);
		};

		app.notFound(() =>
			problemResponse(
				{
					type: "urn:afora:exception:NotFound",
					title: "NotFound",
					status: 404,
					detail: "No operation is served at this method and path.",
				},
				404,
			),
		);
		app.onError((error) => fail(error));

		for (const operation of operations) {
			const { method, path } = routes.get(operation.id) as {
				method: string;
				path: string;
			};
			const hasBody = method !== "get" && method !== "delete";
			const inputTypes = hasBody ? {} : scalarTypesOf(operation.input);
			const contextKeys = operation.context
				? Object.keys(operation.context.properties).filter((key) =>
						Object.hasOwn(headers, key),
					)
				: [];
			const contextTypes = operation.context
				? scalarTypesOf(operation.context)
				: {};

			app.on(method.toUpperCase(), path, async (c) => {
				let input: unknown;
				if (hasBody) {
					const text = await c.req.text();
					try {
						input = text.trim() === "" ? {} : JSON.parse(text);
					} catch {
						return requestProblem(
							"InvalidRequestBody",
							"The request body is not valid JSON.",
						);
					}
				} else {
					input = coerceAll(c.req.query(), inputTypes);
				}

				const call: { context?: unknown } = {};
				if (operation.context) {
					const raw: Record<string, string | undefined> = {};
					for (const key of contextKeys) {
						raw[key] = c.req.header(headers[key] as string) ?? undefined;
					}
					call.context = coerceAll(raw, contextTypes);
				}

				try {
					const response = await operation.invoke(input, call);
					return c.json((outputValueOf(response) ?? null) as never, 200);
				} catch (error) {
					return fail(error, operation);
				}
			});
		}

		if (options.docs) {
			const { path, info, servers } = options.docs;
			const taken = [...routes.values()].some(
				(route) => route.method === "get" && route.path === path,
			);
			if (taken) {
				throw new InvalidOutputStage({
					source: "hono",
					details: {
						reason: `hono.docs.path "${path}" collides with a GET operation route.`,
					},
				});
			}
			const document = openapi({
				info,
				...(servers ? { servers } : {}),
				...(options.basePath ? { basePath: options.basePath } : {}),
				...(options.route ? { route: options.route } : {}),
			}).build(operations, { output });
			app.get(path, (c) => c.json(document as never));
		}

		return app;
	},
});

/** The runtime catalog of this package: the stage name `hono` resolves to the sink. */
export const HonoStages = stageCatalogOf(hono);

/** The catalog entries codegen reads (`--stages @afora/hono`): `{ name, module, export }`. */
export const stages = [
	{ name: "hono", module: "@afora/hono", export: "hono" },
] as const;
