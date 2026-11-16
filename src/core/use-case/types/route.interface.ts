/** An HTTP method an operation can be routed to. */
export type RouteMethod = "get" | "post" | "put" | "patch" | "delete";

/** The status of a successful call of a route; `204` has no body. */
export type RouteSuccessStatus = 200 | 201 | 202 | 204;

/** How a cookie a route sets is sent. The defaults are the safe ones for a session. */
export interface RouteCookie {
	/** The name of the cookie. */
	readonly name: string;
	/**
	 * Not readable by scripts of the page.
	 *
	 * @default true
	 */
	readonly httpOnly?: boolean;
	/**
	 * Sent over HTTPS only.
	 *
	 * @default true
	 */
	readonly secure?: boolean;
	/**
	 * The `SameSite` attribute of the cookie.
	 *
	 * @default "lax"
	 */
	readonly sameSite?: "strict" | "lax" | "none";
	/**
	 * The `Path` attribute of the cookie.
	 *
	 * @default "/"
	 */
	readonly path?: string;
	readonly domain?: string;
	/** The seconds the cookie lives; without it, until the browser closes. */
	readonly maxAge?: number;
}

/**
 * What a route says besides its method and `body`: the shared part of
 * {@link RouteDeclaration} and {@link RouteSettings}.
 */
export interface RouteFields {
	/**
	 * The path, after the `basePath` of the sink, e.g. `"/posts/{slug}"`. A
	 * `{name}` segment fills the scalar input key `name`. Without it, the path
	 * is the default of the sink: `/{kebab(command)}/{kebab(operation)}`.
	 */
	readonly path?: string;
	/**
	 * The status of a successful response.
	 *
	 * @default 200
	 */
	readonly status?: RouteSuccessStatus;
	/**
	 * The other statuses `execute` may choose with `withStatus`, each with the
	 * same response as `status`: `[503]` for a health check that answers 200
	 * or 503. From 200 to 599, except 204 and 304 (they have no body), and not
	 * `status` itself. An HTTP sink answers a status it does not list with
	 * `UndeclaredStatus`.
	 */
	readonly statuses?: readonly number[];
	/**
	 * Scalar input keys read from the query string. A `get` or `delete` route
	 * reads from the query every key that has no other place, so this is for
	 * the routes with a body.
	 */
	readonly query?: readonly string[];
	/** Scalar input keys read from request headers: `{ locale: "accept-language" }`. */
	readonly headers?: { readonly [inputKey: string]: string };
	/** Scalar input keys read from cookies: `{ session: "sid" }`. */
	readonly cookie?: { readonly [inputKey: string]: string };
	/**
	 * Scalar keys of the response sent as cookies instead of in the body:
	 * `{ token: { name: "sid" } }`. An empty text removes the cookie, and an
	 * absent value sets none.
	 */
	readonly setCookie?: { readonly [responseKey: string]: RouteCookie };
}

/**
 * The `body` of a route of `Method`: a `delete` may read a JSON body
 * (`body: true`); any other method takes no `body`, since a `get` never reads
 * one and a `post`, `put` or `patch` always does.
 */
export type RouteBody<Method extends string> =
	Lowercase<Method> extends "delete"
		? {
				/**
				 * Only for a `delete` route: `true` reads the input keys with no
				 * other place from a JSON body, as `post`, `put` and `patch` do,
				 * instead of from the query. An empty body is `{}`.
				 *
				 * @default false
				 */
				readonly body?: boolean;
			}
		: { readonly body?: never };

/**
 * Where a use case is served over HTTP, as data: declared with the `route`
 * setting of `useCaseOf` or with `@Route`, and read by the sinks that serve
 * or document HTTP. The blueprint of the use case stays the only description
 * of its input: a route only says where each key comes from. `body` is only
 * allowed on a `delete` (see {@link RouteBody}).
 */
export type RouteDeclaration = RouteFields &
	(
		| ({ readonly method: Exclude<RouteMethod, "delete"> } & RouteBody<"get">)
		| ({ readonly method: "delete" } & RouteBody<"delete">)
	);

/**
 * What the `route` setting and `@Route` take: a {@link RouteDeclaration}
 * whose method may be written in upper case.
 */
export type RouteSettings = RouteFields &
	(
		| ({
				readonly method:
					| Exclude<RouteMethod, "delete">
					| Uppercase<Exclude<RouteMethod, "delete">>;
		  } & RouteBody<"get">)
		| ({ readonly method: "delete" | "DELETE" } & RouteBody<"delete">)
	);
