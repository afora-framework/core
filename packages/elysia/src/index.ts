import {
	type Authenticator,
	compileRoutes,
	HTTP_OPTION_KEYS,
	type HttpOptions,
	type HttpRequest,
	type HttpResult,
	httpOptionsIssue,
	sinkOf,
	stageCatalogOf,
} from "@afora/core/adapters";
import { type AnyElysia, Elysia, NotFound } from "elysia";

/**
 * The options of the `elysia` sink: those of every sink that serves HTTP
 * (`basePath`, `route`, `responses`, `requestId`, `security`, `docs`,
 * `debug`, `context`, `auth`). JSON, so the stage can live in an
 * `afora.json`. The `variables` of `context` are what a plugin put in the
 * context of the request (`derive`, `resolve`, `decorate`), else in the
 * `store`.
 */
export type ElysiaOptions = HttpOptions;

/** An Elysia plugin: an instance, or a function of the app. */
export type ElysiaPlugin = AnyElysia | ((app: AnyElysia) => AnyElysia);

/**
 * What the `elysia` sink takes that JSON cannot hold, as the second argument
 * of `elysia(options, hooks)`.
 */
export interface ElysiaHooks {
	/**
	 * Who calls, from the credentials of a request (`request.native` is the
	 * Elysia context). Asked for each operation with an `access` other than
	 * `public`; without it (and without `auth`) those operations answer 401.
	 */
	readonly authenticator?: Authenticator;
	/** Elysia plugins (`cors()`, an instance with `onBeforeHandle`, your own), used in order before the routes of the sink. */
	readonly middlewares?: readonly ElysiaPlugin[];
	/**
	 * The Elysia app to add the routes to, instead of a new one: its own
	 * plugins and `onError` are kept.
	 */
	readonly app?: AnyElysia;
}

function validate(options: ElysiaOptions): string | undefined {
	for (const key of Object.keys(options)) {
		if (!(HTTP_OPTION_KEYS as readonly string[]).includes(key)) {
			return `elysia has no option "${key}".`;
		}
	}
	return httpOptionsIssue(options, "elysia");
}

/** The parts of the Elysia context the sink reads. */
interface Call {
	readonly request: Request;
	readonly params?: Record<string, string | undefined>;
	readonly query?: Record<string, unknown>;
	readonly body?: unknown;
	readonly store?: Record<string, unknown>;
}

/** The body stays the text that was sent: the table parses it. */
const TEXT_BODY = { parse: "text" } as const;

/** The part of an Elysia app the sink uses, with routes that come from data. */
interface Routable {
	onError(
		handler: (context: { error: unknown; request: Request }) => Response,
	): Routable;
	use(plugin: ElysiaPlugin): Routable;
	route(
		method: string,
		path: string,
		hook: typeof TEXT_BODY,
		handler: (call: Call) => Response | Promise<Response>,
	): Routable;
}

/** The first value of a query name. */
function first(value: unknown): string | undefined {
	if (Array.isArray(value)) return first(value[0]);
	return typeof value === "string" ? value : undefined;
}

/** An Elysia context, as the route table reads it. */
function requestOf(call: Call): HttpRequest {
	return {
		param: (name) => call.params?.[name],
		query: () => {
			const query: Record<string, string | undefined> = {};
			for (const [name, value] of Object.entries(call.query ?? {})) {
				query[name] = first(value);
			}
			return query;
		},
		header: (name) => call.request.headers.get(name) ?? undefined,
		text: () => (typeof call.body === "string" ? call.body : ""),
		variable: (name) =>
			Object.hasOwn(call, name)
				? (call as unknown as Record<string, unknown>)[name]
				: call.store?.[name],
		native: call,
	};
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

/** `/entries/{slug}` -> `/entries/:slug`. */
function elysiaPath(path: string): string {
	return path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ":$1");
}

/**
 * An Elysia app that serves the operations of an output: the route each use
 * case declares (`route` or `@Route`), else
 * `POST {basePath}/{command}/{operation}`. The requests are handled by the
 * route table of the core (`compileRoutes`), as in every sink that serves
 * HTTP: the input from the body, the query, the path, headers and cookies,
 * the context, the access of each use case (401 and 403), statuses,
 * `application/problem+json` errors, the request id and the OpenAPI document
 * at `docs.path`.
 *
 * The routes carry no Elysia schema: the blueprint of each use case
 * validates, once, and the body reaches the table as the text that was
 * sent. `hooks` (the second argument) holds what is not JSON:
 * `authenticator`, `middlewares` (Elysia plugins) and an `app` to add the
 * routes to.
 */
export const elysia = sinkOf<AnyElysia, ElysiaOptions, ElysiaHooks>({
	name: "elysia",
	validate,
	build: (operations, options, context, hooks) => {
		const table = compileRoutes(operations, options, context, {
			source: "elysia",
			...(hooks?.authenticator ? { authenticator: hooks.authenticator } : {}),
		});
		// Elysia types every route of an app; the routes here come from data.
		let app = (hooks?.app ?? new Elysia()) as unknown as Routable;
		if (!hooks?.app) {
			app = app.onError(({ error, request }) =>
				send(
					error instanceof NotFound
						? table.notFound(requestOf({ request }))
						: table.failure(error, { request: requestOf({ request }) }),
				),
			);
		}
		for (const middleware of hooks?.middlewares ?? []) {
			app = app.use(middleware);
		}
		for (const route of table.routes) {
			app = app.route(
				route.method.toUpperCase(),
				elysiaPath(route.path),
				TEXT_BODY,
				async (call) => send(await route.handle(requestOf(call))),
			);
		}
		const docs = table.docs;
		if (docs) {
			app = app.route("GET", docs.path, TEXT_BODY, (call) =>
				send(docs.handle(requestOf(call))),
			);
		}
		return app as unknown as AnyElysia;
	},
});

/** The runtime catalog of this package: the stage name `elysia` resolves to the sink. */
export const ElysiaStages = stageCatalogOf(elysia);

/** The catalog entries codegen reads (`--stages`): `{ name, module, export, kind }`. */
export const stages = [
	{
		name: "elysia",
		module: "@afora/elysia",
		export: "elysia",
		kind: "sink",
	},
] as const;
