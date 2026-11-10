import { isBlueprint } from "../blueprint/is-blueprint";
import { isBlueprintList } from "../blueprint/list";
import { recordFieldOf } from "../blueprint/record-field";
import type {
	AnyRecordClass,
	BlueprintField,
	IBlueprintCollection,
} from "../blueprint/types/blueprint.interface";
import { ExceptionLayers } from "../exception/enums/exception-layers";
import { Exception } from "../exception/exception";
import { toOpenAPI } from "../openapi/openapi";
import type { OpenAPISchema } from "../openapi/types/openapi.interface";
import { isProperty } from "../property/is-property";
import { recordNameOf } from "../record/name";
import { InvalidOutputStage } from "./exceptions";
import { PROBLEM_MEDIA_TYPE } from "./problem";
import { sinkOf } from "./stage";
import { statusOf } from "./status";
import type { OperationDescriptor } from "./types/output.interface";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
/** An HTTP method an operation can be routed to. */
export type OpenAPIMethod = (typeof METHODS)[number];

/** The status of a successful call of a route; `204` has no body. */
export type RouteStatus = 200 | 201 | 202 | 204;
const SUCCESS_STATUSES: readonly RouteStatus[] = [200, 201, 202, 204];

/** The header `requestId: true` reads and sets. */
const REQUEST_ID_HEADER = "x-request-id";

/**
 * A security scheme of the document (`components.securitySchemes`), as
 * OpenAPI 3.1 writes it.
 */
export type OpenAPISecurityScheme =
	| {
			readonly type: "http";
			/** `"bearer"`, `"basic"`... */
			readonly scheme: string;
			readonly bearerFormat?: string;
			readonly description?: string;
	  }
	| {
			readonly type: "apiKey";
			readonly name: string;
			readonly in: "header" | "query" | "cookie";
			readonly description?: string;
	  }
	| {
			readonly type: "oauth2";
			readonly flows: { readonly [flow: string]: unknown };
			readonly description?: string;
	  }
	| {
			readonly type: "openIdConnect";
			readonly openIdConnectUrl: string;
			readonly description?: string;
	  }
	| { readonly type: "mutualTLS"; readonly description?: string };

/** The scheme an operation needs, and its scopes (none by default). */
export interface SecurityRequirement {
	readonly scheme: string;
	readonly scopes?: readonly string[];
}

/**
 * The options that route operations: shared by the `openapi` sink and the
 * sinks that serve HTTP, so the served routes and the document agree.
 */
export interface RouteOptions {
	/** Prefix of every path, e.g. `"/api"`. Empty by default. */
	readonly basePath?: string;
	/**
	 * Method, path and success status by operation id, e.g.
	 * `{ "Entries.get": { method: "get", path: "/entries/{slug}" } }`. A
	 * `{name}` segment of the path fills the scalar input key `name`.
	 */
	readonly route?: {
		readonly [operationId: string]: {
			readonly method?: OpenAPIMethod;
			readonly path?: string;
			/** `200` by default. */
			readonly status?: RouteStatus;
		};
	};
	/** Static headers of the successful responses, by operation id. */
	readonly responses?: {
		readonly [operationId: string]: {
			readonly headers?: { readonly [name: string]: string };
		};
	};
	/**
	 * Every response carries a request id: the one the request sent in this
	 * header, else a new UUID. `true` is `"x-request-id"`.
	 */
	readonly requestId?: true | string;
	/**
	 * Security schemes and the one each operation needs, for the document
	 * (`components.securitySchemes` and `security`). `default` applies to
	 * every operation not in `operations`; `false` there marks one public.
	 * Sinks that serve HTTP do not enforce it.
	 */
	readonly security?: {
		readonly schemes: { readonly [name: string]: OpenAPISecurityScheme };
		readonly operations?: {
			readonly [operationId: string]: SecurityRequirement | false;
		};
		readonly default?: SecurityRequirement;
	};
}

/** The options of the `openapi` sink. */
export interface OpenAPISinkOptions extends RouteOptions {
	readonly info: {
		readonly title: string;
		readonly version: string;
		readonly description?: string;
	};
	readonly servers?: readonly {
		readonly url: string;
		readonly description?: string;
	}[];
}

/** An OpenAPI 3.1 document. */
export interface OpenAPIDocument {
	readonly openapi: "3.1.0";
	readonly info: OpenAPISinkOptions["info"];
	readonly servers?: OpenAPISinkOptions["servers"];
	readonly security?: readonly { readonly [scheme: string]: string[] }[];
	readonly paths: { readonly [path: string]: Record<string, unknown> };
	readonly components: {
		readonly schemas: { readonly [name: string]: OpenAPISchema };
		readonly securitySchemes?: {
			readonly [name: string]: OpenAPISecurityScheme;
		};
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

const PARAMETER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const COMPONENT_NAME = /^[A-Za-z0-9._-]+$/;

/** A path such as `/entries/{slug}`: `{name}` only as a whole segment, no `:`, `*`, query or spaces. */
function isPath(value: unknown, parameters = true): value is string {
	if (typeof value !== "string" || !value.startsWith("/")) return false;
	return value
		.split("/")
		.every(
			(segment) =>
				(parameters && PARAMETER.test(segment)) || !/[{}?#\s:*]/.test(segment),
		);
}

/** The names of the `{name}` segments of `path`, in order. */
function parametersOfPath(path: string): string[] {
	const names: string[] = [];
	for (const segment of path.split("/")) {
		const name = PARAMETER.exec(segment)?.[1];
		if (name) names.push(name);
	}
	return names;
}

/** A header value: text without control characters other than tab. */
function isHeaderValue(value: unknown): value is string {
	if (typeof value !== "string") return false;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if ((code < 0x20 && code !== 0x09) || code === 0x7f) return false;
	}
	return true;
}

function isScopes(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.every((scope) => typeof scope === "string" && scope !== ""))
	);
}

const SCHEME_KEYS: Readonly<Record<string, readonly string[]>> = {
	http: ["scheme", "bearerFormat"],
	apiKey: ["name", "in"],
	oauth2: ["flows"],
	openIdConnect: ["openIdConnectUrl"],
	mutualTLS: [],
};

function schemeIssue(scheme: unknown, where: string): string | undefined {
	if (!isObject(scheme) || typeof scheme.type !== "string") {
		return `Expected ${where} to be a security scheme with a "type".`;
	}
	const keys = Object.hasOwn(SCHEME_KEYS, scheme.type)
		? SCHEME_KEYS[scheme.type]
		: undefined;
	if (!keys) {
		return `Expected ${where}.type to be one of ${Object.keys(SCHEME_KEYS).join(", ")}.`;
	}
	const bad = onlyKeys(scheme, ["type", "description", ...keys], where);
	if (bad) return bad;
	if (
		scheme.description !== undefined &&
		typeof scheme.description !== "string"
	) {
		return `Expected ${where}.description to be a string.`;
	}
	switch (scheme.type) {
		case "http":
			if (typeof scheme.scheme !== "string" || !scheme.scheme) {
				return `Expected ${where}.scheme to be a scheme such as "bearer".`;
			}
			if (
				scheme.bearerFormat !== undefined &&
				typeof scheme.bearerFormat !== "string"
			) {
				return `Expected ${where}.bearerFormat to be a string.`;
			}
			return undefined;
		case "apiKey":
			if (typeof scheme.name !== "string" || !scheme.name) {
				return `Expected ${where}.name to be a non-empty string.`;
			}
			if (!["header", "query", "cookie"].includes(scheme.in as string)) {
				return `Expected ${where}.in to be "header", "query" or "cookie".`;
			}
			return undefined;
		case "oauth2":
			return isObject(scheme.flows)
				? undefined
				: `Expected ${where}.flows to be an object.`;
		case "openIdConnect":
			return typeof scheme.openIdConnectUrl === "string" &&
				scheme.openIdConnectUrl
				? undefined
				: `Expected ${where}.openIdConnectUrl to be a URL.`;
		default:
			return undefined;
	}
}

function requirementIssue(
	requirement: unknown,
	schemes: Obj,
	where: string,
): string | undefined {
	if (
		!isObject(requirement) ||
		onlyKeys(requirement, ["scheme", "scopes"], where) ||
		typeof requirement.scheme !== "string" ||
		!isScopes(requirement.scopes)
	) {
		return `Expected ${where} to be { scheme, scopes? }.`;
	}
	if (!Object.hasOwn(schemes, requirement.scheme)) {
		return `${where}.scheme names the unknown security scheme "${requirement.scheme}".`;
	}
	return undefined;
}

function securityIssue(security: unknown, where: string): string | undefined {
	if (!isObject(security)) return `Expected ${where} to be an object.`;
	const bad = onlyKeys(security, ["schemes", "operations", "default"], where);
	if (bad) return bad;
	const { schemes, operations } = security;
	if (!isObject(schemes)) return `Expected ${where}.schemes to be an object.`;
	for (const [name, scheme] of Object.entries(schemes)) {
		if (!COMPONENT_NAME.test(name)) {
			return `Expected the security scheme "${name}" to be named with letters, digits, ".", "_" or "-".`;
		}
		const schemeBad = schemeIssue(scheme, `${where}.schemes["${name}"]`);
		if (schemeBad) return schemeBad;
	}
	if (operations !== undefined) {
		if (!isObject(operations)) {
			return `Expected ${where}.operations to be an object.`;
		}
		for (const [id, requirement] of Object.entries(operations)) {
			if (requirement === false) continue;
			const requirementBad = requirementIssue(
				requirement,
				schemes,
				`${where}.operations["${id}"]`,
			);
			if (requirementBad) return requirementBad;
		}
	}
	if (security.default !== undefined) {
		return requirementIssue(security.default, schemes, `${where}.default`);
	}
	return undefined;
}

/** The option names of {@link RouteOptions}, for sinks that list their options. */
export const ROUTE_OPTION_KEYS = [
	"basePath",
	"route",
	"responses",
	"requestId",
	"security",
] as const;

/**
 * Why the {@link RouteOptions} (`basePath`, `route`, `responses`,
 * `requestId`, `security`) are not valid, naming them `where.<option>`;
 * `undefined` when they are. Other keys of `options` are not looked at.
 */
export function routeOptionsIssue(
	options: RouteOptions,
	where: string,
): string | undefined {
	const { basePath, route, responses, requestId, security } =
		options as unknown as Obj;
	if (
		basePath !== undefined &&
		(typeof basePath !== "string" ||
			(basePath !== "" && !isPath(basePath, false)))
	) {
		return `Expected ${where}.basePath to be "" or a path such as "/api".`;
	}
	if (route !== undefined) {
		if (!isObject(route)) return `Expected ${where}.route to be an object.`;
		for (const [id, entry] of Object.entries(route)) {
			if (
				!isObject(entry) ||
				onlyKeys(entry, ["method", "path", "status"], "route")
			) {
				return `Expected ${where}.route["${id}"] to be { method?, path?, status? }.`;
			}
			if (
				entry.method !== undefined &&
				!(METHODS as readonly unknown[]).includes(entry.method)
			) {
				return `Expected ${where}.route["${id}"].method to be one of ${METHODS.join(", ")}.`;
			}
			if (entry.path !== undefined) {
				if (!isPath(entry.path)) {
					return `Expected ${where}.route["${id}"].path to start with "/", with parameters only as whole "{name}" segments and no query.`;
				}
				const names = parametersOfPath(entry.path);
				if (new Set(names).size !== names.length) {
					return `Expected ${where}.route["${id}"].path to name each parameter once.`;
				}
			}
			if (
				entry.status !== undefined &&
				!(SUCCESS_STATUSES as readonly unknown[]).includes(entry.status)
			) {
				return `Expected ${where}.route["${id}"].status to be one of ${SUCCESS_STATUSES.join(", ")}.`;
			}
		}
	}
	if (responses !== undefined) {
		if (!isObject(responses)) {
			return `Expected ${where}.responses to be an object.`;
		}
		for (const [id, entry] of Object.entries(responses)) {
			const at = `${where}.responses["${id}"]`;
			if (
				!isObject(entry) ||
				onlyKeys(entry, ["headers"], at) ||
				(entry.headers !== undefined && !isObject(entry.headers))
			) {
				return `Expected ${at} to be { headers?: { name: value } }.`;
			}
			for (const [name, value] of Object.entries(entry.headers ?? {})) {
				if (!HEADER_NAME.test(name)) {
					return `Expected ${at}.headers to be named by header names, not "${name}".`;
				}
				if (name.toLowerCase() === "content-type") {
					return `${at}.headers cannot set "content-type": the sink sets it.`;
				}
				if (!isHeaderValue(value)) {
					return `Expected ${at}.headers["${name}"] to be text without line breaks.`;
				}
			}
		}
	}
	if (
		requestId !== undefined &&
		requestId !== true &&
		(typeof requestId !== "string" || !HEADER_NAME.test(requestId))
	) {
		return `Expected ${where}.requestId to be true or a header name.`;
	}
	if (security !== undefined) {
		return securityIssue(security, `${where}.security`);
	}
	return undefined;
}

/**
 * The header that carries the request id with these options (`"x-request-id"`
 * for `requestId: true`), or `undefined` without `requestId`.
 */
export function requestIdHeaderOf(options: RouteOptions): string | undefined {
	return options.requestId === true
		? REQUEST_ID_HEADER
		: (options.requestId ?? undefined);
}

function validate(options: OpenAPISinkOptions): string | undefined {
	const bad = onlyKeys(
		options as unknown as Obj,
		["info", "servers", ...ROUTE_OPTION_KEYS],
		"openapi",
	);
	if (bad) return bad;
	const { info, servers } = options as unknown as Obj;
	if (!isObject(info)) return "Expected openapi.info to be an object.";
	const infoBad = onlyKeys(info, ["title", "version", "description"], "info");
	if (infoBad) return infoBad;
	for (const key of ["title", "version"]) {
		if (typeof info[key] !== "string" || !info[key]) {
			return `Expected openapi.info.${key} to be a non-empty string.`;
		}
	}
	if (info.description !== undefined && typeof info.description !== "string") {
		return "Expected openapi.info.description to be a string.";
	}
	if (servers !== undefined) {
		if (!Array.isArray(servers))
			return "Expected openapi.servers to be a list.";
		for (const server of servers) {
			if (
				!isObject(server) ||
				typeof server.url !== "string" ||
				!server.url ||
				(server.description !== undefined &&
					typeof server.description !== "string") ||
				onlyKeys(server, ["url", "description"], "server")
			) {
				return "Expected each openapi.servers entry to be { url, description? }.";
			}
		}
	}
	return routeOptionsIssue(options, "openapi");
}

function invalid(reason: string, source = "openapi"): never {
	throw new InvalidOutputStage({ source, details: { reason } });
}

/** `changePassword` -> `change-password`. */
function kebab(text: string): string {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Where an operation is served, and how it answers. */
export interface OperationRoute {
	readonly method: OpenAPIMethod;
	/** `basePath` included, parameters as `{name}`. */
	readonly path: string;
	/** The input keys the `{name}` segments of `path` fill, in order. */
	readonly parameters: readonly string[];
	/** The status of a success: `200` unless `route` says otherwise. */
	readonly status: RouteStatus;
	/** The static headers of a success, from `responses`. */
	readonly headers: { readonly [name: string]: string };
}

function isScalarSchema(schema: OpenAPISchema): boolean {
	const types = [schema.type ?? []].flat();
	return !types.some((type) => type === "object" || type === "array");
}

/** Whether `name` is an input key that is a scalar property (no object, no list). */
function isScalarKey(operation: OperationDescriptor, name: string): boolean {
	if (!Object.hasOwn(operation.input.properties, name)) return false;
	const field = operation.input.properties[name];
	return isProperty(field) && isScalarSchema(toOpenAPI(field) as OpenAPISchema);
}

/**
 * The route of every operation, by id: `POST {basePath}/{kebab(command)}/{kebab(operation)}`
 * with `200`, changed per operation id with `route` and `responses`. Throws
 * `InvalidOutputStage` (with `source`) when `route`, `responses` or
 * `security.operations` name an unknown operation, a path parameter is not a
 * scalar key of the input, or two operations share a method and path. The
 * routing of the `openapi` sink and of the sinks that serve HTTP.
 */
export function operationRoutes(
	operations: readonly OperationDescriptor[],
	options: RouteOptions,
	source = "openapi",
): ReadonlyMap<string, OperationRoute> {
	const base = options.basePath ?? "";
	const route = options.route ?? {};
	const responses = options.responses ?? {};
	const ids = new Set(operations.map(({ id }) => id));
	for (const [where, entries] of [
		["route", route],
		["responses", responses],
		["security.operations", options.security?.operations ?? {}],
	] as const) {
		for (const id of Object.keys(entries)) {
			if (!ids.has(id)) {
				invalid(
					`${source}.${where} names the unknown operation "${id}".`,
					source,
				);
			}
		}
	}
	const routes = new Map<string, OperationRoute>();
	const taken = new Set<string>();
	for (const operation of operations) {
		const chosen = route[operation.id] ?? {};
		const method: OpenAPIMethod = chosen.method ?? "post";
		const path =
			base +
			(chosen.path ?? `/${kebab(operation.command)}/${kebab(operation.name)}`);
		const parameters = parametersOfPath(path);
		for (const name of parameters) {
			if (!isScalarKey(operation, name)) {
				invalid(
					`${source}.route["${operation.id}"].path has the parameter "{${name}}", which is not a scalar key of the input of ${operation.id}.`,
					source,
				);
			}
		}
		// `/a/{x}` and `/a/{y}` match the same requests.
		const key = `${method} ${path.replace(/\{[^}]*\}/g, "{}")}`;
		if (taken.has(key)) {
			invalid(
				`Two operations are routed to ${method.toUpperCase()} ${path}.`,
				source,
			);
		}
		taken.add(key);
		routes.set(operation.id, {
			method,
			path,
			parameters,
			status: chosen.status ?? 200,
			headers: { ...(responses[operation.id]?.headers ?? {}) },
		});
	}
	return routes;
}

/** Every record class reachable from `properties`, nested ones first-seen order. */
function collectRecords(
	properties: IBlueprintCollection,
	found: Set<AnyRecordClass>,
): void {
	const visit = (field: BlueprintField): void => {
		if (isBlueprintList(field)) {
			visit(field.item);
			return;
		}
		if (isBlueprint(field)) {
			collectRecords(field.properties, found);
			return;
		}
		const record = recordFieldOf(field)?.record;
		if (record && !found.has(record)) {
			found.add(record);
			collectRecords(record.blueprint.properties, found);
		}
	};
	for (const field of Object.values(properties)) visit(field);
}

function problemSchema(): OpenAPISchema {
	return {
		type: "object",
		properties: {
			type: { type: "string" },
			title: { type: "string" },
			status: { type: "integer" },
			detail: { type: "string" },
			layer: { type: "string" },
			issues: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: {
							type: "array",
							items: { type: ["string", "integer"] },
						},
						code: { type: "string" },
						message: { type: "string" },
					},
					required: ["path", "code", "message"],
				},
			},
			trace: { type: "string" },
		},
		required: ["type", "title", "status", "detail"],
	};
}

const PROBLEM_REF = "#/components/schemas/Problem";
const problemContent = {
	[PROBLEM_MEDIA_TYPE]: { schema: { $ref: PROBLEM_REF } },
};

const STATUS_TEXT: Readonly<Record<number, string>> = {
	400: "Invalid input or context.",
	404: "Not found.",
	409: "Conflict.",
	422: "Declared error of the operation.",
	500: "Internal error.",
};

const SUCCESS_TEXT: Readonly<Record<RouteStatus, string>> = {
	200: "Success.",
	201: "Created.",
	202: "Accepted.",
	204: "No content.",
};

function responsesOf(
	operation: OperationDescriptor,
	statuses: Readonly<Record<string, number>>,
	response: OpenAPISchema,
	route: OperationRoute,
	requestIdHeader: string | undefined,
): Obj {
	const names = new Map<number, string[]>([
		[400, []],
		[500, []],
	]);
	for (const Declared of operation.errors) {
		const synthetic = new Exception({
			layer: ExceptionLayers.UseCase,
			name: Declared.name,
			source: "openapi",
			message: Declared.name,
		});
		const status = statusOf(synthetic, operation, statuses);
		const list = names.get(status) ?? [];
		if (!list.includes(Declared.name)) list.push(Declared.name);
		names.set(status, list);
	}
	const idHeaders: Obj = requestIdHeader
		? {
				[requestIdHeader]: {
					description:
						"The id of the request: the one it sent in this header, else a new one.",
					schema: { type: "string" },
				},
			}
		: {};
	const successHeaders: Obj = { ...idHeaders };
	for (const [name, value] of Object.entries(route.headers)) {
		successHeaders[name] = { schema: { type: "string", const: value } };
	}
	const withHeaders = (headers: Obj) =>
		Object.keys(headers).length > 0 ? { headers } : {};
	const responses: Obj = {
		[String(route.status)]: {
			description: SUCCESS_TEXT[route.status],
			...withHeaders(successHeaders),
			...(route.status === 204
				? {}
				: { content: { "application/json": { schema: response } } }),
		},
	};
	for (const status of [...names.keys()].sort((a, b) => a - b)) {
		const declared = names.get(status) ?? [];
		const text = STATUS_TEXT[status] ?? `Error ${status}.`;
		responses[String(status)] = {
			description:
				declared.length > 0
					? `${text} Declared: ${declared.join(", ")}.`
					: text,
			...withHeaders(idHeaders),
			content: problemContent,
		};
	}
	return responses;
}

/** The parameter of the input key `name` (its schema in `schema`), in the path or the query. */
function parameterOf(
	name: string,
	property: OpenAPISchema,
	where: "path" | "query",
	required: boolean,
): Obj {
	const { description, ...rest } = property;
	return {
		name,
		in: where,
		required: where === "path" || required,
		...(typeof description === "string" ? { description } : {}),
		schema: rest,
	};
}

function queryParametersOf(
	operation: OperationDescriptor,
	schema: OpenAPISchema,
): Obj[] {
	const required = new Set(schema.required ?? []);
	return Object.entries(schema.properties ?? {}).map(([name, property]) => {
		if (
			!isProperty(operation.input.properties[name]) ||
			!isScalarSchema(property)
		) {
			invalid(
				`${operation.id} uses a get/delete route, whose input becomes query parameters, but "${name}" is not a scalar; route it with method "post".`,
			);
		}
		return parameterOf(name, property, "query", required.has(name));
	});
}

/** `schema` without the keys in `keys` (the path parameters). */
function withoutKeys(
	schema: OpenAPISchema,
	keys: readonly string[],
): OpenAPISchema {
	if (keys.length === 0) return schema;
	const properties = { ...(schema.properties ?? {}) };
	for (const key of keys) delete properties[key];
	const required = (schema.required ?? []).filter((key) => !keys.includes(key));
	const { required: _, ...rest } = schema;
	return {
		...rest,
		properties,
		...(required.length > 0 ? { required } : {}),
	};
}

function requirementOf(requirement: SecurityRequirement): {
	[scheme: string]: string[];
} {
	return { [requirement.scheme]: [...(requirement.scopes ?? [])] };
}

/**
 * Builds an OpenAPI 3.1 document from the operations.
 *
 * Routes: `POST {basePath}/{kebab(command)}/{kebab(operation)}`, changed per
 * operation id with `route`; two operations on one method and path throw
 * `InvalidOutputStage`. A `{name}` segment of a path is a required path
 * parameter, the input key `name` (a scalar), left out of the body or query.
 * The `operationId` is the id with its dot as an underscore (`Users.register`
 * -> `Users_register`), unique or the build throws. `get` and `delete` send
 * the input as query parameters, which needs every input field to be a
 * scalar property. Responses: the `route` status (`200` by default; `204`
 * without content) with the response schema and the `responses` headers,
 * `400` and `500` always, and the status of each declared error (`statusOf`:
 * `statuses` of the output, else 422); `requestId` adds its header to all of
 * them. Operations carry no repository dependencies, so `404` and `409`
 * appear only when an error that maps to them is declared. Records and
 * entities reachable from inputs and responses are named by class name in
 * `components.schemas`, beside `Problem` (RFC 9457). `security` gives
 * `components.securitySchemes`, the document `security` (`default`) and the
 * `security` of each operation. The `context` of an operation is
 * transport-specific and not part of the document; sinks that serve HTTP map
 * it (headers, middleware).
 */
export const openapi = sinkOf<OpenAPIDocument, OpenAPISinkOptions>({
	name: "openapi",
	validate,
	build: (operations, options, { output }) => {
		const routes = operationRoutes(operations, options);
		const requestIdHeader = requestIdHeaderOf(options);
		const security = options.security;

		const records = new Set<AnyRecordClass>();
		for (const operation of operations) {
			collectRecords(operation.input.properties, records);
			collectRecords(operation.response.properties, records);
		}
		const models: Record<string, BlueprintField> = {};
		const classes = new Map<string, AnyRecordClass>();
		for (const record of records) {
			const name = recordNameOf(record);
			if (!COMPONENT_NAME.test(name) || name === "Problem") {
				invalid(
					`The record class "${name}" cannot be a component name; give the class a name that is not "Problem".`,
				);
			}
			if (classes.has(name)) {
				invalid(`Two record classes are named "${name}"; rename one.`);
			}
			classes.set(name, record);
			models[name] = record;
		}
		for (const operation of operations) {
			models[`${operation.id}#input`] = operation.input;
			models[`${operation.id}#response`] = operation.response;
		}
		const { schemas } = toOpenAPI(models) as {
			schemas: Record<string, OpenAPISchema>;
		};

		const paths: Record<string, Record<string, unknown>> = {};
		const operationIds = new Set<string>();
		const components: Record<string, OpenAPISchema> = {};
		for (const name of classes.keys())
			components[name] = schemas[name] as OpenAPISchema;
		components.Problem = problemSchema();

		for (const operation of operations) {
			const route = routes.get(operation.id) as OperationRoute;
			const { method, path } = route;
			const operationId = operation.id.replaceAll(".", "_");
			if (operationIds.has(operationId)) {
				invalid(`The operationId "${operationId}" is produced twice.`);
			}
			operationIds.add(operationId);
			const slot = paths[path] ?? {};
			paths[path] = slot;

			const full = schemas[`${operation.id}#input`] as OpenAPISchema;
			const input = withoutKeys(full, route.parameters);
			const response = schemas[`${operation.id}#response`] as OpenAPISchema;
			const hasBody = method !== "get" && method !== "delete";
			const hasInput = Object.keys(input.properties ?? {}).length > 0;
			const parameters = [
				...route.parameters.map((name) =>
					parameterOf(
						name,
						full.properties?.[name] as OpenAPISchema,
						"path",
						true,
					),
				),
				...(hasBody ? [] : queryParametersOf(operation, input)),
			];
			const requirement = security?.operations?.[operation.id];
			slot[method] = {
				operationId,
				summary: operation.id,
				...(operation.description
					? { description: operation.description }
					: {}),
				...(operation.tags.length > 0 ? { tags: [...operation.tags] } : {}),
				...(operation.deprecated ? { deprecated: true } : {}),
				...(!hasBody || parameters.length > 0 ? { parameters } : {}),
				...(hasBody && hasInput
					? {
							requestBody: {
								required: true,
								content: { "application/json": { schema: input } },
							},
						}
					: {}),
				responses: responsesOf(
					operation,
					output.statuses,
					response,
					route,
					requestIdHeader,
				),
				...(requirement === false
					? { security: [] }
					: requirement
						? { security: [requirementOf(requirement)] }
						: {}),
			};
		}

		return {
			openapi: "3.1.0",
			info: options.info,
			...(options.servers ? { servers: options.servers } : {}),
			...(security?.default
				? { security: [requirementOf(security.default)] }
				: {}),
			paths,
			components: {
				schemas: components,
				...(security ? { securitySchemes: security.schemes } : {}),
			},
		};
	},
});
