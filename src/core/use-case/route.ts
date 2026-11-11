import type {
	AnyBlueprint,
	BlueprintField,
} from "../blueprint/types/blueprint.interface";
import { toOpenAPI } from "../openapi/openapi";
import type { OpenAPISchema } from "../openapi/types/openapi.interface";
import { isProperty } from "../property/is-property";
import type {
	RouteDeclaration,
	RouteMethod,
	RouteSuccessStatus,
} from "./types/route.interface";

const ROUTE_METHODS: readonly RouteMethod[] = [
	"get",
	"post",
	"put",
	"patch",
	"delete",
];
const ROUTE_SUCCESS_STATUSES: readonly RouteSuccessStatus[] = [
	200, 201, 202, 204,
];

const PARAMETER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
/** A header name (an HTTP token), which a cookie name is too. */
export const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** A path such as `/entries/{slug}`: `{name}` only as a whole segment, no `:`, `*`, query or spaces. */
export function isRoutePath(
	value: unknown,
	parameters = true,
): value is string {
	if (typeof value !== "string" || !value.startsWith("/")) return false;
	return value
		.split("/")
		.every(
			(segment) =>
				(parameters && PARAMETER.test(segment)) || !/[{}?#\s:*]/.test(segment),
		);
}

/** The names of the `{name}` segments of `path`, in order. */
export function parametersOfPath(path: string): string[] {
	const names: string[] = [];
	for (const segment of path.split("/")) {
		const name = PARAMETER.exec(segment)?.[1];
		if (name) names.push(name);
	}
	return names;
}

/** Whether a JSON Schema describes a value that is neither an object nor a list. */
export function isScalarSchema(schema: OpenAPISchema): boolean {
	const types = [schema.type ?? []].flat();
	return !types.some((type) => type === "object" || type === "array");
}

/** Whether `name` is a key of `blueprint` that is a scalar property (no object, no list). */
export function isScalarKey(blueprint: AnyBlueprint, name: string): boolean {
	if (!Object.hasOwn(blueprint.properties, name)) return false;
	const field = blueprint.properties[name] as BlueprintField;
	return isProperty(field) && isScalarSchema(toOpenAPI(field) as OpenAPISchema);
}

type Obj = Record<string, unknown>;
function isObject(value: unknown): value is Obj {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ROUTE_KEYS = ["method", "path", "status", "query", "headers", "cookie"];

/**
 * The frozen, normalized declaration of `route` for a use case whose input is
 * `blueprint` (the method in lower case), or the reason it is not valid.
 */
export function routeDeclarationOf(
	route: unknown,
	blueprint: AnyBlueprint,
): RouteDeclaration | string {
	if (!isObject(route)) {
		return "Expected route to be { method, path?, status?, query?, headers?, cookie? }.";
	}
	for (const key of Object.keys(route)) {
		if (!ROUTE_KEYS.includes(key)) return `route has no option "${key}".`;
	}
	const method =
		typeof route.method === "string" ? route.method.toLowerCase() : undefined;
	if (!(ROUTE_METHODS as readonly unknown[]).includes(method)) {
		return `Expected route.method to be one of ${ROUTE_METHODS.join(", ")}.`;
	}
	const { path, status, query, headers, cookie } = route;
	/** Each input key and the place it is read from. */
	const places = new Map<string, string>();
	const place = (key: string, where: string): string | undefined => {
		const taken = places.get(key);
		if (taken !== undefined) {
			return `route reads the input key "${key}" from two places: ${taken} and ${where}.`;
		}
		if (!isScalarKey(blueprint, key)) {
			return `route reads "${key}" from ${where}, but it is not a scalar key of the input.`;
		}
		places.set(key, where);
		return undefined;
	};
	if (path !== undefined) {
		if (!isRoutePath(path)) {
			return 'Expected route.path to start with "/", with parameters only as whole "{name}" segments and no query.';
		}
		for (const name of parametersOfPath(path)) {
			const bad = place(name, "the path");
			if (bad) return bad;
		}
	}
	if (
		status !== undefined &&
		!(ROUTE_SUCCESS_STATUSES as readonly unknown[]).includes(status)
	) {
		return `Expected route.status to be one of ${ROUTE_SUCCESS_STATUSES.join(", ")}.`;
	}
	if (query !== undefined) {
		if (!Array.isArray(query) || query.some((key) => typeof key !== "string")) {
			return "Expected route.query to be a list of input keys.";
		}
		for (const key of query as string[]) {
			const bad = place(key, "the query");
			if (bad) return bad;
		}
	}
	for (const [option, value, where] of [
		["headers", headers, "a header"],
		["cookie", cookie, "a cookie"],
	] as const) {
		if (value === undefined) continue;
		if (!isObject(value)) {
			return `Expected route.${option} to map input keys to names.`;
		}
		const names = new Set<string>();
		for (const [key, name] of Object.entries(value)) {
			if (typeof name !== "string" || !HEADER_NAME.test(name)) {
				return `Expected route.${option}["${key}"] to be the name of ${where}.`;
			}
			const bad = place(key, where);
			if (bad) return bad;
			const folded = option === "headers" ? name.toLowerCase() : name;
			if (names.has(folded)) {
				return `route.${option} reads "${name}" into two input keys.`;
			}
			names.add(folded);
		}
	}
	return Object.freeze({
		method: method as RouteMethod,
		...(path === undefined ? {} : { path: path as string }),
		...(status === undefined ? {} : { status: status as RouteSuccessStatus }),
		...(query === undefined
			? {}
			: { query: Object.freeze([...(query as string[])]) }),
		...(headers === undefined
			? {}
			: {
					headers: Object.freeze(
						Object.fromEntries(
							Object.entries(headers as Record<string, string>).map(
								([key, name]) => [key, name.toLowerCase()],
							),
						),
					),
				}),
		...(cookie === undefined
			? {}
			: { cookie: Object.freeze({ ...(cookie as Record<string, string>) }) }),
	});
}
