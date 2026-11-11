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
import createExpress, {
	type ErrorRequestHandler,
	type Express,
	type Request,
	type RequestHandler,
	type Response,
} from "express";

/**
 * The options of the `express` sink: those of every sink that serves HTTP
 * (`basePath`, `route`, `responses`, `requestId`, `security`, `docs`,
 * `debug`, `context`, `auth`). JSON, so the stage can live in an
 * `afora.json`. The `variables` of `context` are what a middleware set in
 * `res.locals`, else on the request (`req.user`).
 */
export type ExpressOptions = HttpOptions;

/**
 * What the `express` sink takes that JSON cannot hold, as the second
 * argument of `express(options, hooks)`.
 */
export interface ExpressHooks {
	/**
	 * Who calls, from the credentials of a request (`request.native` is the
	 * Express `Request`). Asked for each operation with an `access` other
	 * than `public`; without it (and without `auth`) those operations answer
	 * 401.
	 */
	readonly authenticator?: Authenticator;
	/** Express middlewares (`cors()`, `helmet()`, your own), run in order before every route of the sink. */
	readonly middlewares?: readonly RequestHandler[];
	/**
	 * The Express app to add the routes to, instead of a new one: its own
	 * middlewares and handlers are kept, and the sink adds no not found or
	 * error handler.
	 */
	readonly app?: Express;
}

function validate(options: ExpressOptions): string | undefined {
	for (const key of Object.keys(options)) {
		if (!(HTTP_OPTION_KEYS as readonly string[]).includes(key)) {
			return `express has no option "${key}".`;
		}
	}
	return httpOptionsIssue(options, "express");
}

/** The first value of a header or of a query name. */
function first(value: unknown): string | undefined {
	if (Array.isArray(value)) return first(value[0]);
	return typeof value === "string" ? value : undefined;
}

/** The body as text: as sent, unless a parser of the app already read it. */
function textOf(request: Request): string | Promise<string> {
	const parsed: unknown = request.body;
	if (typeof parsed === "string") return parsed;
	if (parsed instanceof Uint8Array) return new TextDecoder().decode(parsed);
	if (parsed !== undefined && parsed !== null && request.readableEnded) {
		return JSON.stringify(parsed);
	}
	return new Promise((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
		request.on("end", () => {
			let size = 0;
			for (const chunk of chunks) size += chunk.byteLength;
			const bytes = new Uint8Array(size);
			let at = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, at);
				at += chunk.byteLength;
			}
			resolve(new TextDecoder().decode(bytes));
		});
		request.on("error", reject);
	});
}

/** An Express request, as the route table reads it. */
function requestOf(request: Request, response: Response): HttpRequest {
	return {
		param: (name) => first(request.params[name]),
		query: () => {
			const query: Record<string, string | undefined> = {};
			for (const [name, value] of Object.entries(request.query)) {
				query[name] = first(value);
			}
			return query;
		},
		header: (name) => first(request.headers[name]),
		text: () => textOf(request),
		variable: (name) =>
			Object.hasOwn(response.locals, name)
				? response.locals[name]
				: (request as unknown as Record<string, unknown>)[name],
		native: request,
	};
}

/** Sends a result of the route table, as is. */
function send(response: Response, result: HttpResult): void {
	response.status(result.status);
	for (const [name, value] of Object.entries(result.headers)) {
		response.setHeader(name, value);
	}
	if (result.cookies.length > 0) {
		response.setHeader("set-cookie", [...result.cookies]);
	}
	if (result.body === null) response.end();
	else response.end(result.body);
}

/** `/entries/{slug}` -> `/entries/:slug`. */
function expressPath(path: string): string {
	return path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ":$1");
}

/**
 * An Express app that serves the operations of an output: the route each use
 * case declares (`route` or `@Route`), else
 * `POST {basePath}/{command}/{operation}`. The requests are handled by the
 * route table of the core (`compileRoutes`), as in every sink that serves
 * HTTP: the input from the body, the query, the path, headers and cookies,
 * the context, the access of each use case (401 and 403), statuses,
 * `application/problem+json` errors, the request id and the OpenAPI document
 * at `docs.path`.
 *
 * The body is read as text and parsed by the table, so it needs no
 * `express.json()`; behind one, the parsed body is used. `hooks` (the second
 * argument) holds what is not JSON: `authenticator`, `middlewares` and an
 * `app` to add the routes to.
 */
export const express = sinkOf<Express, ExpressOptions, ExpressHooks>({
	name: "express",
	validate,
	build: (operations, options, context, hooks) => {
		const table = compileRoutes(operations, options, context, {
			source: "express",
			...(hooks?.authenticator ? { authenticator: hooks.authenticator } : {}),
		});
		const app = hooks?.app ?? createExpress();
		if (!hooks?.app) app.disable("x-powered-by");
		const middlewares = hooks?.middlewares ?? [];
		for (const route of table.routes) {
			app[route.method](
				expressPath(route.path),
				...middlewares,
				async (request: Request, response: Response) => {
					send(response, await route.handle(requestOf(request, response)));
				},
			);
		}
		const docs = table.docs;
		if (docs) {
			app.get(docs.path, ...middlewares, (request, response) => {
				send(response, docs.handle(requestOf(request, response)));
			});
		}
		if (!hooks?.app) {
			app.use((request, response) => {
				send(response, table.notFound(requestOf(request, response)));
			});
			const failed: ErrorRequestHandler = (error, request, response, _next) => {
				send(
					response,
					table.failure(error, { request: requestOf(request, response) }),
				);
			};
			app.use(failed);
		}
		return app;
	},
});

/** The runtime catalog of this package: the stage name `express` resolves to the sink. */
export const ExpressStages = stageCatalogOf(express);

/** The catalog entries codegen reads (`--stages`): `{ name, module, export, kind }`. */
export const stages = [
	{
		name: "express",
		module: "@afora/express",
		export: "express",
		kind: "sink",
	},
] as const;
