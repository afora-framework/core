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
import Fastify, {
	type FastifyInstance,
	type FastifyReply,
	type FastifyRequest,
	type onRequestHookHandler,
} from "fastify";

/**
 * The options of the `fastify` sink: those of every sink that serves HTTP
 * (`basePath`, `route`, `responses`, `requestId`, `security`, `docs`,
 * `debug`, `context`, `auth`). JSON, so the stage can live in an
 * `afora.json`. The `variables` of `context` are properties a hook set on
 * the request (`request.tenant`, after `decorateRequest`).
 */
export type FastifyOptions = HttpOptions;

/**
 * What the `fastify` sink takes that JSON cannot hold, as the second
 * argument of `fastify(options, hooks)`.
 */
export interface FastifyHooks {
	/**
	 * Who calls, from the credentials of a request (`request.native` is the
	 * `FastifyRequest`). Asked for each operation with an `access` other than
	 * `public`; without it (and without `auth`) those operations answer 401.
	 */
	readonly authenticator?: Authenticator;
	/** `onRequest` hooks, run in order before every route of the sink. */
	readonly middlewares?: readonly onRequestHookHandler[];
	/**
	 * The Fastify instance to add the routes to, instead of a new one: its own
	 * plugins, hooks, not found and error handlers are kept.
	 */
	readonly app?: FastifyInstance;
}

function validate(options: FastifyOptions): string | undefined {
	for (const key of Object.keys(options)) {
		if (!(HTTP_OPTION_KEYS as readonly string[]).includes(key)) {
			return `fastify has no option "${key}".`;
		}
	}
	return httpOptionsIssue(options, "fastify");
}

/** The first value of a header or of a query name. */
function first(value: unknown): string | undefined {
	if (Array.isArray(value)) return first(value[0]);
	return typeof value === "string" ? value : undefined;
}

/** A Fastify request, as the route table reads it: one object per request, no closures. */
class FastifyHttpRequest implements HttpRequest {
	constructor(readonly native: FastifyRequest) {}
	param(name: string) {
		return (this.native.params as Record<string, string>)[name];
	}
	query() {
		const query: Record<string, string | undefined> = {};
		for (const [name, value] of Object.entries(
			this.native.query as Record<string, unknown>,
		)) {
			query[name] = first(value);
		}
		return query;
	}
	header(name: string) {
		return first(this.native.headers[name]);
	}
	text() {
		return typeof this.native.body === "string" ? this.native.body : "";
	}
	variable(name: string) {
		return (this.native as unknown as Record<string, unknown>)[name];
	}
}

const requestOf = (request: FastifyRequest): HttpRequest =>
	new FastifyHttpRequest(request);

/** Sends a result of the route table, as is. */
function send(reply: FastifyReply, result: HttpResult): FastifyReply {
	reply.code(result.status).headers(result.headers);
	if (result.cookies.length > 0) reply.header("set-cookie", result.cookies);
	return result.body === null ? reply.send() : reply.send(result.body);
}

/** `/entries/{slug}` -> `/entries/:slug`. */
function fastifyPath(path: string): string {
	return path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ":$1");
}

/**
 * A Fastify instance that serves the operations of an output: the route each
 * use case declares (`route` or `@Route`), else
 * `POST {basePath}/{command}/{operation}`. The requests are handled by the
 * route table of the core (`compileRoutes`), as in every sink that serves
 * HTTP: the input from the body, the query, the path, headers and cookies,
 * the context, the access of each use case (401 and 403), statuses,
 * `application/problem+json` errors, the request id and the OpenAPI document
 * at `docs.path`.
 *
 * The routes live in a plugin of their own, where the body is read as text
 * (the table parses it, so an invalid one is a problem like the others), so
 * the content type parsers of the instance are not touched. `hooks` (the
 * second argument) holds what is not JSON: `authenticator`, `middlewares`
 * (`onRequest` hooks) and an `app` to add the routes to.
 */
export const fastify = sinkOf<FastifyInstance, FastifyOptions, FastifyHooks>({
	name: "fastify",
	validate,
	build: (operations, options, context, hooks) => {
		const table = compileRoutes(operations, options, context, {
			source: "fastify",
			...(hooks?.authenticator ? { authenticator: hooks.authenticator } : {}),
		});
		const app = hooks?.app ?? Fastify();
		if (!hooks?.app) {
			app.setNotFoundHandler((request, reply) =>
				send(reply, table.notFound(requestOf(request))),
			);
			app.setErrorHandler((error, request, reply) =>
				send(reply, table.failure(error, { request: requestOf(request) })),
			);
		}
		app.register(async (scope) => {
			// The table parses the body: here it stays the text that was sent.
			scope.removeAllContentTypeParsers();
			scope.addContentTypeParser(
				"*",
				{ parseAs: "string" },
				(_request, body, done) => done(null, body),
			);
			for (const middleware of hooks?.middlewares ?? []) {
				scope.addHook("onRequest", middleware);
			}
			for (const route of table.routes) {
				scope.route({
					method: route.method.toUpperCase() as "GET",
					url: fastifyPath(route.path),
					handler: async (request, reply) =>
						send(reply, await route.handle(requestOf(request))),
				});
			}
			const docs = table.docs;
			if (docs) {
				scope.get(docs.path, (request, reply) =>
					send(reply, docs.handle(requestOf(request))),
				);
			}
		});
		return app;
	},
});

/** The runtime catalog of this package: the stage name `fastify` resolves to the sink. */
export const FastifyStages = stageCatalogOf(fastify);

/** The catalog entries codegen reads (`--stages`): `{ name, module, export, kind }`. */
export const stages = [
	{
		name: "fastify",
		module: "@afora/fastify",
		export: "fastify",
		kind: "sink",
	},
] as const;
