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

/** The options of the `openapi` sink. */
export interface OpenAPISinkOptions {
	readonly info: {
		readonly title: string;
		readonly version: string;
		readonly description?: string;
	};
	readonly servers?: readonly {
		readonly url: string;
		readonly description?: string;
	}[];
	/** Prefix of every path, e.g. `"/api"`. Empty by default. */
	readonly basePath?: string;
	/** Method and path by operation id, e.g. `{ "Users.login": { path: "/session" } }`. */
	readonly route?: {
		readonly [operationId: string]: {
			readonly method?: OpenAPIMethod;
			readonly path?: string;
		};
	};
}

/** An OpenAPI 3.1 document. */
export interface OpenAPIDocument {
	readonly openapi: "3.1.0";
	readonly info: OpenAPISinkOptions["info"];
	readonly servers?: OpenAPISinkOptions["servers"];
	readonly paths: { readonly [path: string]: Record<string, unknown> };
	readonly components: {
		readonly schemas: { readonly [name: string]: OpenAPISchema };
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

function isPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.startsWith("/") &&
		!/[{}?#\s]/.test(value)
	);
}

/** The options that route operations: shared by the sinks that serve HTTP. */
export interface RouteOptions {
	readonly basePath?: string;
	readonly route?: OpenAPISinkOptions["route"];
}

/** Where an operation is served. */
export interface OperationRoute {
	readonly method: OpenAPIMethod;
	/** `basePath` included. */
	readonly path: string;
}

/**
 * Why `basePath` and `route` are not valid routing options, naming them
 * `where.basePath` and `where.route`; `undefined` when they are.
 */
export function routeOptionsIssue(
	options: RouteOptions,
	where: string,
): string | undefined {
	const { basePath, route } = options as unknown as Obj;
	if (
		basePath !== undefined &&
		(typeof basePath !== "string" || (basePath !== "" && !isPath(basePath)))
	) {
		return `Expected ${where}.basePath to be "" or a path such as "/api".`;
	}
	if (route !== undefined) {
		if (!isObject(route)) return `Expected ${where}.route to be an object.`;
		for (const [id, entry] of Object.entries(route)) {
			if (!isObject(entry) || onlyKeys(entry, ["method", "path"], "route")) {
				return `Expected ${where}.route["${id}"] to be { method?, path? }.`;
			}
			if (
				entry.method !== undefined &&
				!(METHODS as readonly unknown[]).includes(entry.method)
			) {
				return `Expected ${where}.route["${id}"].method to be one of ${METHODS.join(", ")}.`;
			}
			if (entry.path !== undefined && !isPath(entry.path)) {
				return `Expected ${where}.route["${id}"].path to start with "/" and have no parameters or query.`;
			}
		}
	}
	return undefined;
}

function validate(options: OpenAPISinkOptions): string | undefined {
	const bad = onlyKeys(
		options as unknown as Obj,
		["info", "servers", "basePath", "route"],
		"openapi",
	);
	if (bad) return bad;
	const { info, servers, basePath, route } = options as unknown as Obj;
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
	return routeOptionsIssue({ basePath, route } as RouteOptions, "openapi");
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

/**
 * The route of every operation, by id: `POST {basePath}/{kebab(command)}/{kebab(operation)}`,
 * changed per operation id with `route`. Throws `InvalidOutputStage` (with
 * `source`) when `route` names an unknown operation or two operations share a
 * method and path. The routing of the `openapi` sink and of the sinks that
 * serve HTTP.
 */
export function operationRoutes(
	operations: readonly OperationDescriptor[],
	options: RouteOptions,
	source = "openapi",
): ReadonlyMap<string, OperationRoute> {
	const base = options.basePath ?? "";
	const route = options.route ?? {};
	const ids = new Set(operations.map(({ id }) => id));
	for (const id of Object.keys(route)) {
		if (!ids.has(id)) {
			invalid(`${source}.route names the unknown operation "${id}".`, source);
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
		const key = `${method} ${path}`;
		if (taken.has(key)) {
			invalid(
				`Two operations are routed to ${method.toUpperCase()} ${path}.`,
				source,
			);
		}
		taken.add(key);
		routes.set(operation.id, { method, path });
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

function responsesOf(
	operation: OperationDescriptor,
	statuses: Readonly<Record<string, number>>,
	response: OpenAPISchema,
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
	const responses: Obj = {
		"200": {
			description: "Success.",
			content: { "application/json": { schema: response } },
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
			content: problemContent,
		};
	}
	return responses;
}

function parametersOf(
	operation: OperationDescriptor,
	schema: OpenAPISchema,
): Obj[] {
	const required = new Set(schema.required ?? []);
	return Object.entries(schema.properties ?? {}).map(([name, property]) => {
		const field = operation.input.properties[name];
		const type = property.type;
		if (
			!isProperty(field) ||
			type === "object" ||
			type === "array" ||
			(Array.isArray(type) && type.some((t) => t === "object" || t === "array"))
		) {
			invalid(
				`${operation.id} uses a ${"get/delete"} route, whose input becomes query parameters, but "${name}" is not a scalar; route it with method "post".`,
			);
		}
		const { description, ...rest } = property;
		return {
			name,
			in: "query",
			required: required.has(name),
			...(typeof description === "string" ? { description } : {}),
			schema: rest,
		};
	});
}

/**
 * Builds an OpenAPI 3.1 document from the operations.
 *
 * Routes: `POST {basePath}/{kebab(command)}/{kebab(operation)}`, changed per
 * operation id with `route`; two operations on one method and path throw
 * `InvalidOutputStage`. The `operationId` is the id with its dot as an
 * underscore (`Users.register` -> `Users_register`), unique or the build
 * throws. `get` and `delete` send the input as query parameters, which needs
 * every input field to be a scalar property. Responses: `200` with the
 * response schema, `400` and `500` always, and the status of each declared
 * error (`statusOf`: `statuses` of the output, else 422). Operations carry no
 * repository dependencies, so `404` and `409` appear only when an error that
 * maps to them is declared. Records and entities reachable from inputs and
 * responses are named by class name in `components.schemas`, beside `Problem`
 * (RFC 9457). The `context` of an operation is transport-specific and not
 * part of the document; sinks that serve HTTP map it (headers, middleware).
 */
export const openapi = sinkOf<OpenAPIDocument, OpenAPISinkOptions>({
	name: "openapi",
	validate,
	build: (operations, options, { output }) => {
		const routes = operationRoutes(operations, options);

		const records = new Set<AnyRecordClass>();
		for (const operation of operations) {
			collectRecords(operation.input.properties, records);
			collectRecords(operation.response.properties, records);
		}
		const models: Record<string, BlueprintField> = {};
		const classes = new Map<string, AnyRecordClass>();
		for (const record of records) {
			const name = recordNameOf(record);
			if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "Problem") {
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
			const { method, path } = routes.get(operation.id) as OperationRoute;
			const operationId = operation.id.replaceAll(".", "_");
			if (operationIds.has(operationId)) {
				invalid(`The operationId "${operationId}" is produced twice.`);
			}
			operationIds.add(operationId);
			const slot = paths[path] ?? {};
			paths[path] = slot;

			const input = schemas[`${operation.id}#input`] as OpenAPISchema;
			const response = schemas[`${operation.id}#response`] as OpenAPISchema;
			const hasBody = method !== "get" && method !== "delete";
			const hasInput = Object.keys(input.properties ?? {}).length > 0;
			slot[method] = {
				operationId,
				summary: operation.id,
				...(operation.description
					? { description: operation.description }
					: {}),
				...(operation.tags.length > 0 ? { tags: [...operation.tags] } : {}),
				...(operation.deprecated ? { deprecated: true } : {}),
				...(!hasBody ? { parameters: parametersOf(operation, input) } : {}),
				...(hasBody && hasInput
					? {
							requestBody: {
								required: true,
								content: { "application/json": { schema: input } },
							},
						}
					: {}),
				responses: responsesOf(operation, output.statuses, response),
			};
		}

		return {
			openapi: "3.1.0",
			info: options.info,
			...(options.servers ? { servers: options.servers } : {}),
			paths,
			components: { schemas: components },
		};
	},
});
