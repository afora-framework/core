import type { Principal } from "../../use-case/types/access.interface";
import type {
	OpenAPIMethod,
	OpenAPISinkOptions,
	RouteOptions,
} from "../openapi-sink";
import type { OperationDescriptor } from "./output.interface";

/**
 * The options every sink that serves HTTP takes. JSON, so the stage can live
 * in an `afora.json`. The routing options (`basePath`, `route`, `responses`,
 * `requestId`, `security`) are those of the `openapi` sink, so the served
 * routes and the document agree.
 */
export interface HttpOptions extends RouteOptions {
	/** Serves the OpenAPI document of the same operations at `path`. */
	readonly docs?: {
		readonly path: string;
		readonly info: OpenAPISinkOptions["info"];
		readonly servers?: OpenAPISinkOptions["servers"];
	};
	/** Adds the `trace` to problems and the real `detail` to 5xx ones. Off by default. */
	readonly debug?: boolean;
	/**
	 * The context of an operation, by context key: from request headers
	 * (`{ headers: { locale: "accept-language" } }`) and from values a
	 * middleware of the server set for the request
	 * (`{ variables: { caller: "caller" } }`).
	 */
	readonly context?: {
		readonly headers?: { readonly [contextKey: string]: string };
		readonly variables?: { readonly [contextKey: string]: string };
	};
}

/** A request, as the server of a sink gives it to the route table. */
export interface HttpRequest {
	/** The value of the `{name}` segment of the path, decoded. */
	param(name: string): string | undefined;
	/** The query string, the first value of each name. */
	query(): Readonly<Record<string, string | undefined>>;
	/** The value of a header, by its name in lower case. */
	header(name: string): string | undefined;
	/** The body, as text. Called at most once, and only by routes with a body. */
	text(): string | Promise<string>;
	/** A value a middleware of the server set for this request, by name. */
	variable?(name: string): unknown;
	/** The request of the server itself, for an authenticator that needs it. */
	readonly native?: unknown;
}

/** The answer to a request: what the server of a sink has to send, as is. */
export interface HttpResult {
	readonly status: number;
	/** `content-type` included, when there is a body. */
	readonly headers: Readonly<Record<string, string>>;
	/** One `set-cookie` header each. */
	readonly cookies: readonly string[];
	/** The body, already serialized (sensitive values masked), or `null` for none. */
	readonly body: string | null;
}

/** What an authenticator reads of a request. */
export interface AuthRequest {
	/** The value of a header, by its name in lower case. */
	header(name: string): string | undefined;
	/** The value of a cookie of the request. */
	cookie(name: string): string | undefined;
	/** The operation being called. */
	readonly operation: OperationDescriptor;
	/** The request of the server itself. */
	readonly native?: unknown;
}

/**
 * Who is calling, from the credentials of a request: a `Principal`, or
 * `null` for an anonymous caller. Called for each request to an operation
 * with an `access` other than `public`. It may throw `Unauthenticated` to
 * refuse credentials it does not accept.
 */
export type Authenticator = (
	request: AuthRequest,
) => Principal | null | Promise<Principal | null>;

/** One operation, ready to serve: the server routes `method` and `path` to `handle`. */
export interface CompiledRoute {
	readonly operation: OperationDescriptor;
	readonly method: OpenAPIMethod;
	/** `basePath` included, parameters as `{name}`. */
	readonly path: string;
	/** The names of the `{name}` segments of `path`, in order. */
	readonly parameters: readonly string[];
	/** Never rejects: an error is a problem result. */
	handle(request: HttpRequest): Promise<HttpResult>;
}

/** The routes of an output, compiled once (see `compileRoutes`). */
export interface RouteTable {
	readonly routes: readonly CompiledRoute[];
	/** The route that serves the OpenAPI document, with `docs`. */
	readonly docs?: {
		readonly path: string;
		handle(request?: Pick<HttpRequest, "header">): HttpResult;
	};
	/** The 404 problem for a request no route serves. */
	notFound(request?: Pick<HttpRequest, "header">): HttpResult;
	/**
	 * The problem for an error raised outside `handle`: its status is the one
	 * the output `statuses` give its name, else `status`, else `statusOf`.
	 */
	failure(
		error: unknown,
		options?: {
			readonly operation?: OperationDescriptor;
			readonly status?: number;
			readonly request?: Pick<HttpRequest, "header">;
		},
	): HttpResult;
}

/** What `compileRoutes` takes besides the operations and the options. */
export interface CompileRoutesSettings {
	/** The name of the sink, for the messages of `InvalidOutputStage`. */
	readonly source: string;
	readonly authenticator?: Authenticator;
	/** Changes the OpenAPI document before it is served (a sink with routes of its own kind). */
	readonly document?: (document: unknown) => unknown;
}
