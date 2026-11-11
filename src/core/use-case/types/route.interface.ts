/** An HTTP method an operation can be routed to. */
export type RouteMethod = "get" | "post" | "put" | "patch" | "delete";

/** The status of a successful call of a route; `204` has no body. */
export type RouteSuccessStatus = 200 | 201 | 202 | 204;

/** How a cookie a route sets is sent. The defaults are the safe ones for a session. */
export interface RouteCookie {
	/** The name of the cookie. */
	readonly name: string;
	/** Not readable by scripts of the page. `true` by default. */
	readonly httpOnly?: boolean;
	/** Sent over HTTPS only. `true` by default. */
	readonly secure?: boolean;
	/** `"lax"` by default. */
	readonly sameSite?: "strict" | "lax" | "none";
	/** `"/"` by default. */
	readonly path?: string;
	readonly domain?: string;
	/** The seconds the cookie lives; without it, until the browser closes. */
	readonly maxAge?: number;
}

/**
 * Where a use case is served over HTTP, as data: declared with the `route`
 * setting of `useCaseOf` or with `@Route`, and read by the sinks that serve
 * or document HTTP. The blueprint of the use case stays the only description
 * of its input: a route only says where each key comes from.
 */
export interface RouteDeclaration {
	readonly method: RouteMethod;
	/**
	 * The path, after the `basePath` of the sink, e.g. `"/posts/{slug}"`. A
	 * `{name}` segment fills the scalar input key `name`. Without it, the path
	 * is the default of the sink: `/{kebab(command)}/{kebab(operation)}`.
	 */
	readonly path?: string;
	/** `200` by default. */
	readonly status?: RouteSuccessStatus;
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
 * What the `route` setting and `@Route` take: a {@link RouteDeclaration}
 * whose method may be written in upper case.
 */
export interface RouteSettings extends Omit<RouteDeclaration, "method"> {
	readonly method: RouteMethod | Uppercase<RouteMethod>;
}
