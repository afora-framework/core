import { InvalidOutputStage, stripUndeclared } from "@afora/core";
import {
	type Authenticator,
	compileRoutes,
	HTTP_OPTION_KEYS,
	type HttpOptions,
	type HttpRequest,
	type HttpResult,
	httpOptionsIssue,
	type OperationRoute,
	operationRoutes,
	PROBLEM_MEDIA_TYPE,
	requestIdHeaderOf,
	sinkOf,
	stageCatalogOf,
} from "@afora/core/adapters";
import { type Context, Hono, type MiddlewareHandler } from "hono";
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

/**
 * The options of the `hono` sink. JSON, so the stage can live in an
 * `afora.json`: the options of every sink that serves HTTP (`basePath`,
 * `route`, `responses`, `requestId`, `security`, `docs`, `debug`,
 * `context`; the `variables` of `context` are what a Hono middleware set
 * with `c.set`), plus `webhooks`.
 */
export interface HonoOptions extends HttpOptions {
	/**
	 * Operations that receive webhooks, by operation id: the signature of each
	 * request is verified over the raw body before it is parsed (a 401 problem
	 * otherwise). See {@link WebhookOptions}.
	 */
	readonly webhooks?: { readonly [operationId: string]: WebhookOptions };
}

/**
 * What the `hono` sink takes that JSON cannot hold, as the second argument
 * of `hono(options, hooks)`.
 */
export interface HonoHooks {
	/**
	 * Who calls, from the credentials of a request (`request.native` is the
	 * Hono `Context`). Asked for each operation with an `access` other than
	 * `public`; without it those operations answer 401.
	 */
	readonly authenticator?: Authenticator;
	/** Hono middlewares, run in order before every route of the sink. */
	readonly middlewares?: readonly MiddlewareHandler[];
	/**
	 * The Hono app to add the routes to, instead of a new one: its own
	 * middlewares, `notFound` and `onError` are kept.
	 */
	readonly app?: Hono;
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
	const bad = onlyKeys(given, [...HTTP_OPTION_KEYS, "webhooks"], "hono");
	if (bad) return bad;
	const shared = httpOptionsIssue(options, "hono");
	if (shared) return shared;
	const { webhooks } = given;
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
	routes: ReadonlyMap<string, OperationRoute>,
): unknown {
	const copy = structuredClone(document) as {
		paths: Record<string, Record<string, Record<string, unknown>>>;
	};
	for (const [id, webhook] of Object.entries(webhooks)) {
		const { method, path } = routes.get(id) as OperationRoute;
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
		const responses = operation.responses as Record<
			string,
			{ headers?: unknown } | undefined
		>;
		// A problem like the others: the same headers (the request id) as the 400.
		const headers = responses["400"]?.headers;
		const merged: Record<string, unknown> = {
			...responses,
			"401": {
				description: "Missing, invalid or expired webhook signature.",
				...(headers ? { headers } : {}),
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

/** The response of a result of the route table, as is. */
function send(result: HttpResult): Response {
	if (result.cookies.length === 0) {
		return new Response(result.body, {
			status: result.status,
			headers: result.headers as Record<string, string>,
		});
	}
	const headers = new Headers(result.headers as Record<string, string>);
	for (const cookie of result.cookies) headers.append("set-cookie", cookie);
	return new Response(result.body, { status: result.status, headers });
}

/** A Hono request, as the route table reads it; `text` replaces the body, once read. */
function requestOf(c: Context, text?: string): HttpRequest {
	return {
		param: (name) => c.req.param(name),
		query: () => c.req.query(),
		header: (name) => c.req.header(name),
		text: text === undefined ? () => c.req.text() : () => text,
		variable: (name) => (c.get as (name: string) => unknown)(name),
		native: c,
	};
}

/** A request id worth propagating: visible ASCII, at most 200 characters. */
const REQUEST_ID = /^[\x21-\x7e]{1,200}$/;

/** `/entries/{slug}` -> `/entries/:slug`. */
function honoPath(path: string): string {
	return path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ":$1");
}

/**
 * A Hono app that serves the operations: `POST {basePath}/{command}/{operation}`
 * per operation (kebab-case), or the route its use case declares; `route`
 * changes the method, path and status as in the `openapi` sink, so the two
 * agree. The requests are handled by the route table of the core
 * (`compileRoutes`), as in every sink that serves HTTP:
 *
 * - Body methods read a JSON body, `get` and `delete` the query string, with
 *   what the route places over it: `{name}` segments of the path, and the
 *   query keys, headers and cookies a use case route declares. Text is
 *   coerced to the numbers and booleans the input takes, and the operation
 *   validates it (a 400 problem with `issues`).
 * - The context comes from `context.headers` (`{ contextKey: headerName }`,
 *   coerced) and `context.variables` (`{ contextKey: variableName }`, what a
 *   middleware set with `c.set`, as is); a missing one leaves the key out.
 * - An operation with an `access` asks `hooks.authenticator` who calls, and
 *   answers 401 or 403 when the caller may not.
 * - Success is the route status (`200` by default) with the response as
 *   JSON (sensitive values masked), or no body for `204`, plus the
 *   `responses` headers. Errors are `application/problem+json`, with the
 *   status of `statusOf` (the output `statuses` first). An unknown route is
 *   a 404 problem, and anything thrown outside an operation a 500 one.
 *   `requestId` puts the request id on every response.
 * - `docs.path` serves the `openapi` document of the same operations.
 *
 * `hooks` (the second argument) holds what is not JSON: `authenticator`,
 * `middlewares` and an `app` to add the routes to.
 */
export const hono = sinkOf<Hono, HonoOptions, HonoHooks>({
	name: "hono",
	validate,
	build: (operations, options, context, hooks) => {
		const webhooks = options.webhooks ?? {};
		const routes = operationRoutes(operations, options, "hono");
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
		const { webhooks: _, ...shared } = options;
		const table = compileRoutes(operations, shared, context, {
			source: "hono",
			...(hooks?.authenticator ? { authenticator: hooks.authenticator } : {}),
			...(Object.keys(webhooks).length > 0
				? {
						document: (document: unknown) =>
							withWebhooks(document, webhooks, routes),
					}
				: {}),
		});

		const app = hooks?.app ?? new Hono();
		if (!hooks?.app) {
			app.notFound((c) => send(table.notFound(requestOf(c))));
			app.onError((error, c) =>
				send(table.failure(error, { request: requestOf(c) })),
			);
		}
		// The results of the table carry the request id; this covers what the
		// table did not answer (a 404 of a parent app, a middleware response).
		const requestIdHeader = requestIdHeaderOf(options);
		if (requestIdHeader) {
			app.use(async (c, next) => {
				await next();
				if (c.res.headers.has(requestIdHeader)) return;
				const sent = c.req.header(requestIdHeader);
				c.res.headers.set(
					requestIdHeader,
					sent !== undefined && REQUEST_ID.test(sent)
						? sent
						: crypto.randomUUID(),
				);
			});
		}
		for (const middleware of hooks?.middlewares ?? []) app.use(middleware);

		for (const route of table.routes) {
			const { operation } = route;
			const webhook = Object.hasOwn(webhooks, operation.id)
				? webhooks[operation.id]
				: undefined;
			const path = honoPath(route.path);
			if (!webhook) {
				app.on(route.method.toUpperCase(), path, async (c) =>
					send(await route.handle(requestOf(c))),
				);
				continue;
			}
			app.on(route.method.toUpperCase(), path, async (c) => {
				// The signature covers the bytes as sent: read them before any decoding.
				const body = new Uint8Array(await c.req.arrayBuffer());
				const secrets = secretsOf(c, webhook);
				if (secrets.length === 0) {
					return send(
						table.failure(
							new WebhookSecretMissing({
								source: "hono",
								details: { variables: [webhook.secret.env].flat() },
							}),
							{ request: requestOf(c) },
						),
					);
				}
				const failure = await verifyWebhook(webhook, secrets, {
					header: (name) => c.req.header(name) ?? undefined,
					body,
				});
				if (failure) {
					// A 401, unless the output `statuses` say otherwise.
					return send(
						table.failure(
							new InvalidWebhookSignature({
								source: "hono",
								details: { scheme: webhook.scheme, reason: failure },
							}),
							{ status: 401, request: requestOf(c) },
						),
					);
				}
				let text = new TextDecoder().decode(body);
				if (webhook.unknownKeys === "strip" && text.trim() !== "") {
					try {
						text = JSON.stringify(
							stripUndeclared(operation.input, JSON.parse(text)),
						);
					} catch {
						// Not JSON: the route answers the 400 of an invalid body.
					}
				}
				return send(await route.handle(requestOf(c, text)));
			});
		}

		const docs = table.docs;
		if (docs) app.get(docs.path, (c) => send(docs.handle(requestOf(c))));

		return app;
	},
});

/** The runtime catalog of this package: the stage name `hono` resolves to the sink. */
export const HonoStages = stageCatalogOf(hono);

/** The catalog entries codegen reads (`--stages @afora/hono`): `{ name, module, export, kind }`. */
export const stages = [
	{ name: "hono", module: "@afora/hono", export: "hono", kind: "sink" },
] as const;
