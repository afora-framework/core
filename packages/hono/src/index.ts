import {
	coerceTextValues,
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
	stripUndeclared,
} from "@afora/core";
import { type Context, Hono } from "hono";
import { InvalidWebhookSignature, WebhookSecretMissing } from "./exceptions";
import {
	signatureHeadersOf,
	TIMESTAMPED_SCHEMES,
	verifyWebhook,
	WEBHOOK_SCHEMES,
	type WebhookOptions,
} from "./webhook";

export { InvalidWebhookSignature, WebhookSecretMissing } from "./exceptions";
export {
	verifyWebhook,
	type WebhookFailure,
	type WebhookOptions,
	type WebhookRequest,
	type WebhookScheme,
} from "./webhook";

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
	/**
	 * Operations that receive webhooks, by operation id: the signature of each
	 * request is verified over the raw body before it is parsed (a 401 problem
	 * otherwise). See {@link WebhookOptions}.
	 */
	readonly webhooks?: { readonly [operationId: string]: WebhookOptions };
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
		["basePath", "route", "docs", "debug", "context", "webhooks"],
		"hono",
	);
	if (bad) return bad;
	const routing = routeOptionsIssue(options, "hono");
	if (routing) return routing;
	if (given.debug !== undefined && typeof given.debug !== "boolean") {
		return "Expected hono.debug to be a boolean.";
	}
	const { docs, context, webhooks } = given;
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
	if (webhooks !== undefined) {
		if (!isObject(webhooks)) return "Expected hono.webhooks to be an object.";
		for (const [id, entry] of Object.entries(webhooks)) {
			const bad = webhookIssue(entry, `hono.webhooks["${id}"]`);
			if (bad) return bad;
		}
	}
	return undefined;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function webhookIssue(entry: unknown, where: string): string | undefined {
	if (!isObject(entry)) return `Expected ${where} to be an object.`;
	const bad = onlyKeys(
		entry,
		[
			"scheme",
			"secret",
			"header",
			"encoding",
			"prefix",
			"tolerance",
			"unknownKeys",
		],
		where,
	);
	if (bad) return bad;
	const { scheme, secret, header, encoding, prefix, tolerance, unknownKeys } =
		entry;
	if (!(WEBHOOK_SCHEMES as readonly unknown[]).includes(scheme)) {
		return `Expected ${where}.scheme to be one of ${WEBHOOK_SCHEMES.map((name) => `"${name}"`).join(", ")}.`;
	}
	const names = isObject(secret) ? [secret.env].flat() : [];
	if (
		!isObject(secret) ||
		onlyKeys(secret, ["env"], `${where}.secret`) ||
		names.length === 0 ||
		names.some((name) => typeof name !== "string" || name === "")
	) {
		return `Expected ${where}.secret to be { "env": "NAME" } or { "env": ["NAME", ...] }.`;
	}
	const generic = scheme === "hmac-sha256";
	for (const [key, value] of [
		["header", header],
		["encoding", encoding],
		["prefix", prefix],
	] as const) {
		if (value !== undefined && !generic) {
			return `${where}.${key} is only for the "hmac-sha256" scheme.`;
		}
	}
	if (generic && (typeof header !== "string" || !HEADER_NAME.test(header))) {
		return `Expected ${where}.header to be a header name.`;
	}
	if (encoding !== undefined && encoding !== "hex" && encoding !== "base64") {
		return `Expected ${where}.encoding to be "hex" or "base64".`;
	}
	if (prefix !== undefined && typeof prefix !== "string") {
		return `Expected ${where}.prefix to be a string.`;
	}
	if (tolerance !== undefined) {
		if (!(TIMESTAMPED_SCHEMES as readonly unknown[]).includes(scheme)) {
			return `${where}.tolerance is only for the "stripe" and "standard-webhooks" schemes.`;
		}
		if (!Number.isInteger(tolerance) || (tolerance as number) < 0) {
			return `Expected ${where}.tolerance to be a whole number of seconds, 0 or more.`;
		}
	}
	if (
		unknownKeys !== undefined &&
		unknownKeys !== "reject" &&
		unknownKeys !== "strip"
	) {
		return `Expected ${where}.unknownKeys to be "reject" or "strip".`;
	}
	return undefined;
}

/**
 * The secrets of a webhook that are set: a binding of the request (Workers,
 * or the third argument of `app.request`), else a process variable.
 */
function secretsOf(c: Context, webhook: WebhookOptions): string[] {
	const bindings = (c.env ?? {}) as Record<string, unknown>;
	const variables = (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process?.env;
	const secrets: string[] = [];
	for (const name of [webhook.secret.env].flat()) {
		const value = Object.hasOwn(bindings, name)
			? bindings[name]
			: variables?.[name];
		if (typeof value === "string" && value !== "") secrets.push(value);
	}
	return secrets;
}

/** The OpenAPI document with the signature headers and the 401 of each webhook route. */
function withWebhooks(
	document: unknown,
	webhooks: Readonly<Record<string, WebhookOptions>>,
	routes: ReadonlyMap<
		string,
		{ readonly method: string; readonly path: string }
	>,
): unknown {
	const copy = structuredClone(document) as {
		paths: Record<string, Record<string, Record<string, unknown>>>;
	};
	for (const [id, webhook] of Object.entries(webhooks)) {
		const { method, path } = routes.get(id) as { method: string; path: string };
		const operation = copy.paths[path]?.[method];
		if (!operation) continue;
		operation.parameters = [
			...((operation.parameters as unknown[] | undefined) ?? []),
			...signatureHeadersOf(webhook).map((name) => ({
				name,
				in: "header",
				required: true,
				schema: { type: "string" },
			})),
		];
		const responses = operation.responses as Record<string, unknown>;
		const merged: Record<string, unknown> = {
			...responses,
			"401": {
				description: "Missing, invalid or expired webhook signature.",
				content: {
					[PROBLEM_MEDIA_TYPE]: {
						schema: { $ref: "#/components/schemas/Problem" },
					},
				},
			},
		};
		operation.responses = Object.fromEntries(
			Object.entries(merged).sort(([a], [b]) => Number(a) - Number(b)),
		);
		operation["x-afora-webhook"] = { scheme: webhook.scheme };
	}
	return copy;
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
		const webhooks = options.webhooks ?? {};
		for (const id of Object.keys(webhooks)) {
			const route = routes.get(id);
			const reason = !route
				? `hono.webhooks["${id}"] names no operation of the output.`
				: route.method === "get" || route.method === "delete"
					? `hono.webhooks["${id}"] is routed with "${route.method}", which has no body to sign; route it with "post".`
					: undefined;
			if (reason) {
				throw new InvalidOutputStage({ source: "hono", details: { reason } });
			}
		}
		const app = new Hono();

		const fail = (error: unknown, operation?: OperationDescriptor) => {
			const status = statusOf(error, operation, output.statuses);
			return problemResponse(problemOf(error, { status, debug }), status);
		};
		/** A 401 for a bad signature, unless the output `statuses` say otherwise. */
		const unauthorized = (error: Error & { readonly name: string }) => {
			const status = Object.hasOwn(output.statuses, error.name)
				? (output.statuses[error.name] as number)
				: 401;
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
			const contextKeys = operation.context
				? Object.keys(operation.context.properties).filter((key) =>
						Object.hasOwn(headers, key),
					)
				: [];

			const webhook = Object.hasOwn(webhooks, operation.id)
				? webhooks[operation.id]
				: undefined;

			app.on(method.toUpperCase(), path, async (c) => {
				let input: unknown;
				if (webhook) {
					// The signature covers the bytes as sent: read them before any decoding.
					const body = new Uint8Array(await c.req.arrayBuffer());
					const secrets = secretsOf(c, webhook);
					if (secrets.length === 0) {
						return fail(
							new WebhookSecretMissing({
								source: "hono",
								details: { variables: [webhook.secret.env].flat() },
							}),
						);
					}
					const failure = await verifyWebhook(webhook, secrets, {
						header: (name) => c.req.header(name) ?? undefined,
						body,
					});
					if (failure) {
						return unauthorized(
							new InvalidWebhookSignature({
								source: "hono",
								details: { scheme: webhook.scheme, reason: failure },
							}),
						);
					}
					const text = new TextDecoder().decode(body);
					try {
						input = text.trim() === "" ? {} : JSON.parse(text);
					} catch {
						return requestProblem(
							"InvalidRequestBody",
							"The request body is not valid JSON.",
						);
					}
					if (webhook.unknownKeys === "strip") {
						input = stripUndeclared(operation.input, input);
					}
				} else if (hasBody) {
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
					input = coerceTextValues(operation.input, c.req.query());
				}

				const call: { context?: unknown } = {};
				if (operation.context) {
					const raw: Record<string, string | undefined> = {};
					for (const key of contextKeys) {
						raw[key] = c.req.header(headers[key] as string) ?? undefined;
					}
					call.context = coerceTextValues(operation.context, raw);
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
			const served =
				Object.keys(webhooks).length > 0
					? withWebhooks(document, webhooks, routes)
					: document;
			app.get(path, (c) => c.json(served as never));
		}

		return app;
	},
});

/** The runtime catalog of this package: the stage name `hono` resolves to the sink. */
export const HonoStages = stageCatalogOf(hono);

/** The catalog entries codegen reads (`--stages @afora/hono`): `{ name, module, export, kind }`. */
export const stages = [
	{ name: "hono", module: "@afora/hono", export: "hono", kind: "sink" },
] as const;
