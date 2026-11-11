import { jwtOf, jwtOptionsIssue } from "../auth/jwt";
import { Exception } from "../exception/exception";
import { HEADER_NAME } from "../use-case/route";
import type { Principal } from "../use-case/types/access.interface";
import type { RouteCookie } from "../use-case/types/route.interface";
import { coerceTextValues } from "./coerce";
import { InvalidOutputStage } from "./exceptions";
import {
	type OpenAPISinkOptions,
	type OperationRoute,
	openapi,
	operationRoutes,
	ROUTE_OPTION_KEYS,
	type RouteOptions,
	requestIdHeaderOf,
	routeOptionsIssue,
} from "./openapi-sink";
import { outputValueOf, PROBLEM_MEDIA_TYPE, problemOf } from "./problem";
import { statusOf } from "./status";
import type {
	Authenticator,
	CompiledRoute,
	CompileRoutesSettings,
	HttpOptions,
	HttpRequest,
	HttpResult,
	RouteTable,
} from "./types/http.interface";
import type {
	OperationCallOptions,
	OperationDescriptor,
	StageContext,
} from "./types/output.interface";

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

/** The option names of {@link HttpOptions}, for sinks that list their options. */
export const HTTP_OPTION_KEYS = [
	...ROUTE_OPTION_KEYS,
	"docs",
	"debug",
	"context",
	"auth",
] as const;

/**
 * Why the {@link HttpOptions} are not valid, naming them `where.<option>`;
 * `undefined` when they are. Other keys of `options` are not looked at.
 */
export function httpOptionsIssue(
	options: HttpOptions,
	where: string,
): string | undefined {
	const given = options as unknown as Obj;
	const routing = routeOptionsIssue(options, where);
	if (routing) return routing;
	if (given.debug !== undefined && typeof given.debug !== "boolean") {
		return `Expected ${where}.debug to be a boolean.`;
	}
	const { docs, context, auth } = given;
	if (auth !== undefined) {
		if (!isObject(auth) || Object.keys(auth).join() !== "jwt") {
			return `Expected ${where}.auth to be { jwt: { secret, ... } }.`;
		}
		const bad = jwtOptionsIssue(
			auth.jwt,
			`${where}.auth.jwt`,
			["header", "cookie"],
			true,
		);
		if (bad) return bad;
		const { header, cookie } = auth.jwt as Obj;
		for (const [key, value] of [
			["header", header],
			["cookie", cookie],
		] as const) {
			if (
				value !== undefined &&
				(typeof value !== "string" || !HEADER_NAME.test(value))
			) {
				return `Expected ${where}.auth.jwt.${key} to be the name of a ${key}.`;
			}
		}
	}
	if (docs !== undefined) {
		if (!isObject(docs)) return `Expected ${where}.docs to be an object.`;
		const docsBad = onlyKeys(
			docs,
			["path", "info", "servers"],
			`${where}.docs`,
		);
		if (docsBad) return docsBad;
		if (
			typeof docs.path !== "string" ||
			!docs.path.startsWith("/") ||
			/[{}?#\s:*]/.test(docs.path)
		) {
			return `Expected ${where}.docs.path to be a path such as "/openapi.json".`;
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
			return (reason ?? `Expected ${where}.docs to be valid.`).replaceAll(
				"openapi.",
				`${where}.docs.`,
			);
		}
	}
	if (context !== undefined) {
		if (!isObject(context)) return `Expected ${where}.context to be an object.`;
		const contextBad = onlyKeys(
			context,
			["headers", "variables"],
			`${where}.context`,
		);
		if (contextBad) return contextBad;
		const { headers, variables } = context;
		if (headers !== undefined) {
			if (!isObject(headers)) {
				return `Expected ${where}.context.headers to be an object.`;
			}
			for (const [key, name] of Object.entries(headers)) {
				if (typeof name !== "string" || !HEADER_NAME.test(name)) {
					return `Expected ${where}.context.headers["${key}"] to be a header name.`;
				}
			}
		}
		if (variables !== undefined) {
			if (!isObject(variables)) {
				return `Expected ${where}.context.variables to be an object.`;
			}
			for (const [key, name] of Object.entries(variables)) {
				if (typeof name !== "string" || name === "") {
					return `Expected ${where}.context.variables["${key}"] to be the name of a variable.`;
				}
				if (isObject(headers) && Object.hasOwn(headers, key)) {
					return `${where}.context maps "${key}" both from a header and from a variable; keep one.`;
				}
			}
		}
	}
	return undefined;
}

/** A request id worth propagating: visible ASCII, at most 200 characters. */
const REQUEST_ID = /^[\x21-\x7e]{1,200}$/;
const JSON_TYPE = "application/json";
const NO_COOKIES: readonly string[] = Object.freeze([]);

/** The cookies of a `cookie` header, by name; the first of each name wins. */
function cookiesOf(header: string | undefined): Map<string, string> {
	const cookies = new Map<string, string>();
	if (!header) return cookies;
	for (const pair of header.split(";")) {
		const at = pair.indexOf("=");
		if (at < 0) continue;
		const name = pair.slice(0, at).trim();
		if (name === "" || cookies.has(name)) continue;
		let value = pair.slice(at + 1).trim();
		if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
			value = value.slice(1, -1);
		}
		if (value.includes("%")) {
			try {
				value = decodeURIComponent(value);
			} catch {
				// Not percent-encoded after all: the text as sent.
			}
		}
		cookies.set(name, value);
	}
	return cookies;
}

/** Writes the `set-cookie` header of `cookie` for a value; an empty one removes the cookie. */
function cookieWriterOf(cookie: RouteCookie): (value: string) => string {
	const sameSite = cookie.sameSite ?? "lax";
	const attributes = [
		`Path=${cookie.path ?? "/"}`,
		...(cookie.domain === undefined ? [] : [`Domain=${cookie.domain}`]),
		...(cookie.httpOnly === false ? [] : ["HttpOnly"]),
		...(cookie.secure === false ? [] : ["Secure"]),
		`SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`,
	].join("; ");
	const lasting =
		cookie.maxAge === undefined ? "" : `; Max-Age=${cookie.maxAge}`;
	return (value) =>
		value === ""
			? `${cookie.name}=; ${attributes}; Max-Age=0`
			: `${cookie.name}=${encodeURIComponent(value)}; ${attributes}${lasting}`;
}

/**
 * The routes of `operations`, compiled once, for a sink that serves HTTP on
 * any server: the sink routes each `method` and `path` to `handle` and sends
 * the result as is. Everything a request needs is decided here, so a call
 * only reads, coerces and runs:
 *
 * - The input is the JSON body of a `post`, `put` or `patch` and the query
 *   of a `get` or `delete`, with the keys the route reads elsewhere over it:
 *   `{name}` segments of the path, and the query keys, headers and cookies
 *   the use case route declares. Text is coerced to the numbers and booleans
 *   the input takes; the operation validates it (a 400 problem with `issues`).
 * - The context comes from `context.headers` (coerced) and
 *   `context.variables` (as is); a missing one leaves the key out.
 * - An operation with an `access` other than `public` asks
 *   `settings.authenticator` who calls; without one, or without credentials,
 *   it is a 401.
 * - Success is the route status with the response as JSON (sensitive values
 *   masked by `toJSON`), or no body for `204`, plus the `responses` headers.
 *   Errors are `application/problem+json`, with the status of `statusOf`
 *   (the output `statuses` first). `requestId` puts the request id on every
 *   result, `notFound` and `failure` included.
 * - `docs.path` serves the `openapi` document of the same operations.
 *
 * Throws `InvalidOutputStage` (source `settings.source`) as `operationRoutes`
 * does, and when `docs.path` is taken by a `get` route.
 */
export function compileRoutes(
	operations: readonly OperationDescriptor[],
	options: HttpOptions,
	context: StageContext,
	settings: CompileRoutesSettings,
): RouteTable {
	const { source } = settings;
	const { output } = context;
	// The hook of the sink, else the token the options describe.
	let authenticator = settings.authenticator;
	if (!authenticator && options.auth) {
		const { header, cookie, ...jwt } = options.auth.jwt;
		authenticator = jwtOf(jwt).authenticator({
			...(header === undefined ? {} : { header }),
			...(cookie === undefined ? {} : { cookie }),
		});
	}
	const routes = operationRoutes(operations, options, source);
	const debug = options.debug === true;
	const contextHeaders = options.context?.headers ?? {};
	const contextVariables = options.context?.variables ?? {};
	const requestIdHeader = requestIdHeaderOf(options);

	const idOf = (request: Pick<HttpRequest, "header"> | undefined): string => {
		const sent = request?.header(requestIdHeader as string);
		return sent !== undefined && REQUEST_ID.test(sent)
			? sent
			: crypto.randomUUID();
	};
	/** `headers` plus the request id, when the output has one. */
	const headersOf = (
		headers: Readonly<Record<string, string>>,
		request: Pick<HttpRequest, "header"> | undefined,
	): Readonly<Record<string, string>> =>
		requestIdHeader === undefined
			? headers
			: { ...headers, [requestIdHeader]: idOf(request) };
	const problemHeaders = Object.freeze({ "content-type": PROBLEM_MEDIA_TYPE });
	const problem = (
		body: unknown,
		status: number,
		request: Pick<HttpRequest, "header"> | undefined,
	): HttpResult => ({
		status,
		headers: headersOf(problemHeaders, request),
		cookies: NO_COOKIES,
		body: JSON.stringify(body),
	});
	const fail = (
		error: unknown,
		operation: OperationDescriptor | undefined,
		request: Pick<HttpRequest, "header"> | undefined,
		fallback?: number,
	): HttpResult => {
		// `statusOf` looks at the output `statuses` first; a fallback only
		// replaces what it would say for a name they do not list.
		const status =
			fallback !== undefined &&
			!(
				error instanceof Exception && Object.hasOwn(output.statuses, error.name)
			)
				? fallback
				: statusOf(error, operation, output.statuses);
		return problem(problemOf(error, { status, debug }), status, request);
	};
	const failure: RouteTable["failure"] = (error, given) =>
		fail(error, given?.operation, given?.request, given?.status);

	const compiled: CompiledRoute[] = operations.map((operation) => {
		const route = routes.get(operation.id) as OperationRoute;
		const { method, path, parameters, status, body } = route;
		const queryKeys = body ? route.query : [];
		const headerKeys = Object.entries(route.requestHeaders);
		const cookieKeys = Object.entries(route.cookies);
		const placed =
			parameters.length +
				queryKeys.length +
				headerKeys.length +
				cookieKeys.length >
			0;
		const declared = operation.context
			? Object.keys(operation.context.properties)
			: [];
		const contextHeaderKeys = declared
			.filter((key) => Object.hasOwn(contextHeaders, key))
			.map((key) => [key, (contextHeaders[key] as string).toLowerCase()]);
		const contextVariableKeys = declared
			.filter((key) => Object.hasOwn(contextVariables, key))
			.map((key) => [key, contextVariables[key] as string]);
		const guarded =
			operation.access !== undefined && operation.access.public !== true;
		const setCookies = Object.entries(route.setCookies).map(
			([key, cookie]) => [key, cookieWriterOf(cookie)] as const,
		);
		const successHeaders = Object.freeze(
			status === 204
				? { ...route.headers }
				: { "content-type": JSON_TYPE, ...route.headers },
		);

		const readsCookies = cookieKeys.length > 0;
		const authenticates = guarded && authenticator !== undefined;
		const hasContext = operation.context !== undefined;

		const handle = async (request: HttpRequest): Promise<HttpResult> => {
			try {
				// Nothing is made for a request that the route does not need.
				let cookies: Map<string, string> | undefined;
				let principal: Principal | null | undefined;
				if (authenticates) {
					principal = await (authenticator as Authenticator)({
						header: (name) => request.header(name),
						cookie: (name) => {
							cookies ??= cookiesOf(request.header("cookie"));
							return cookies.get(name);
						},
						operation,
						native: request.native,
					});
				}

				let input: unknown;
				if (body) {
					const text = await request.text();
					try {
						input = text.trim() === "" ? {} : JSON.parse(text);
					} catch {
						return problem(
							{
								type: "urn:afora:exception:InvalidRequestBody",
								title: "InvalidRequestBody",
								status: 400,
								detail: "The request body is not valid JSON.",
							},
							400,
							request,
						);
					}
				} else {
					input = coerceTextValues(operation.input, request.query());
				}
				if (placed && isObject(input)) {
					const texts: Record<string, string | undefined> = {};
					if (queryKeys.length > 0) {
						const query = request.query();
						for (const key of queryKeys) texts[key] = query[key];
					}
					for (const [key, name] of headerKeys) {
						texts[key] = request.header(name);
					}
					if (readsCookies) {
						cookies ??= cookiesOf(request.header("cookie"));
						for (const [key, name] of cookieKeys)
							texts[key] = cookies.get(name);
					}
					for (const name of parameters) texts[name] = request.param(name);
					// What the route places wins over the body or the query.
					input = { ...input, ...coerceTextValues(operation.input, texts) };
				}

				let call: OperationCallOptions | undefined;
				if (hasContext) {
					const raw: Record<string, string | undefined> = {};
					for (const [key, name] of contextHeaderKeys) {
						raw[key as string] = request.header(name as string);
					}
					const values = coerceTextValues(
						operation.context as NonNullable<typeof operation.context>,
						raw,
					);
					for (const [key, name] of contextVariableKeys) {
						const value = request.variable?.(name as string);
						if (value !== undefined) values[key as string] = value;
					}
					call = guarded
						? { context: values, principal: principal ?? null }
						: { context: values };
				} else if (guarded) call = { principal: principal ?? null };

				const response = await operation.invoke(input, call);
				if (setCookies.length === 0) {
					return {
						status,
						headers: headersOf(successHeaders, request),
						cookies: NO_COOKIES,
						body: status === 204 ? null : (JSON.stringify(response) ?? "null"),
					};
				}
				// The keys sent as cookies leave the body.
				const value = outputValueOf(response);
				const sent: string[] = [];
				if (isObject(value)) {
					for (const [key, write] of setCookies) {
						const cookie = value[key];
						delete value[key];
						if (cookie !== undefined && cookie !== null) {
							sent.push(write(String(cookie)));
						}
					}
				}
				return {
					status,
					headers: headersOf(successHeaders, request),
					cookies: sent,
					body: status === 204 ? null : (JSON.stringify(value) ?? "null"),
				};
			} catch (error) {
				return fail(error, operation, request);
			}
		};
		return Object.freeze({ operation, method, path, parameters, handle });
	});

	let docs: RouteTable["docs"];
	if (options.docs) {
		const { path, info, servers } = options.docs;
		if (
			compiled.some((route) => route.method === "get" && route.path === path)
		) {
			throw new InvalidOutputStage({
				source,
				details: {
					reason: `${source}.docs.path "${path}" collides with a GET operation route.`,
				},
			});
		}
		const routing: Record<string, unknown> = {};
		for (const key of ROUTE_OPTION_KEYS) {
			if (options[key] !== undefined) routing[key] = options[key];
		}
		// The token of `auth` is the scheme of the document, unless it declares its own.
		if (options.auth && routing.security === undefined) {
			const { header, cookie } = options.auth.jwt;
			routing.security = {
				schemes:
					cookie !== undefined && header === undefined
						? { session: { type: "apiKey", in: "cookie", name: cookie } }
						: header !== undefined && header.toLowerCase() !== "authorization"
							? { token: { type: "apiKey", in: "header", name: header } }
							: {
									bearer: {
										type: "http",
										scheme: "bearer",
										bearerFormat: "JWT",
									},
								},
			};
		}
		const document = openapi({
			info,
			...(servers ? { servers } : {}),
			...(routing as RouteOptions),
		}).build(operations, context);
		const text = JSON.stringify(
			settings.document ? settings.document(document) : document,
		);
		const headers = Object.freeze({ "content-type": JSON_TYPE });
		docs = Object.freeze({
			path,
			handle: (request?: Pick<HttpRequest, "header">): HttpResult => ({
				status: 200,
				headers: headersOf(headers, request),
				cookies: NO_COOKIES,
				body: text,
			}),
		});
	}

	return Object.freeze({
		routes: Object.freeze(compiled),
		...(docs ? { docs } : {}),
		notFound: (request?: Pick<HttpRequest, "header">) =>
			problem(
				{
					type: "urn:afora:exception:NotFound",
					title: "NotFound",
					status: 404,
					detail: "No operation is served at this method and path.",
				},
				404,
				request,
			),
		failure,
	});
}
