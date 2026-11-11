import { issue } from "./scope";
import { isObject } from "./spec/field";
import type { SpecIssue } from "./spec/types";

type Path = readonly (string | number)[];

const METHODS = ["get", "post", "put", "patch", "delete"];
const STATUSES = [200, 201, 202, 204];
const PARAMETER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const PRINCIPAL_VALUE = /^(subject|scopes|claims\.[^.]+)$/;
const ROUTE_KEYS = [
	"method",
	"path",
	"status",
	"query",
	"headers",
	"cookie",
	"setCookie",
];
const COOKIE_KEYS = [
	"name",
	"httpOnly",
	"secure",
	"sameSite",
	"path",
	"domain",
	"maxAge",
];

/** The keys a use case has, when the spec knows them. */
export interface KnownKeys {
	readonly input?: readonly string[];
	readonly response?: readonly string[];
	readonly context?: readonly string[];
}

function isPath(value: unknown): value is string {
	if (typeof value !== "string" || !value.startsWith("/")) return false;
	return value
		.split("/")
		.every((segment) => PARAMETER.test(segment) || !/[{}?#\s:*]/.test(segment));
}

/**
 * Checks the `route` of a use case as `useCaseOf` will: its shape, and that
 * each key it places is a key of the input (or of the response, for
 * `setCookie`) when `known` has them. Whether a key is a scalar is checked
 * by the generated code, when it loads.
 */
export function checkRoute(
	route: unknown,
	path: Path,
	known: KnownKeys,
	issues: SpecIssue[],
): void {
	const bad = (at: Path, message: string) =>
		issues.push(issue(at, "invalid_route", message));
	if (!isObject(route)) {
		bad(
			path,
			'"route" is { "method", "path"?, "status"?, "query"?, "headers"?, "cookie"?, "setCookie"? }.',
		);
		return;
	}
	for (const key of Object.keys(route)) {
		if (!ROUTE_KEYS.includes(key)) {
			issues.push(
				issue(
					[...path, key],
					"unknown_key",
					`"${key}" is not valid in a route. Valid keys: ${ROUTE_KEYS.join(", ")}.`,
				),
			);
		}
	}
	if (
		typeof route.method !== "string" ||
		!METHODS.includes(route.method.toLowerCase())
	) {
		bad([...path, "method"], `"method" is one of ${METHODS.join(", ")}.`);
	}
	const placed = new Map<string, string>();
	const place = (key: string, where: string, at: Path) => {
		const taken = placed.get(key);
		if (taken !== undefined) {
			bad(
				at,
				`The input key "${key}" is read from two places: ${taken} and ${where}.`,
			);
			return;
		}
		placed.set(key, where);
		if (known.input && !known.input.includes(key)) {
			bad(
				at,
				`"${key}" is not a key of the input. Input keys: ${known.input.join(", ") || "(none)"}.`,
			);
		}
	};
	if (route.path !== undefined) {
		if (!isPath(route.path)) {
			bad(
				[...path, "path"],
				'"path" starts with "/", with parameters only as whole "{name}" segments and no query.',
			);
		} else {
			for (const segment of route.path.split("/")) {
				const name = PARAMETER.exec(segment)?.[1];
				if (name) place(name, "the path", [...path, "path"]);
			}
		}
	}
	if (
		route.status !== undefined &&
		!STATUSES.includes(route.status as number)
	) {
		bad([...path, "status"], `"status" is one of ${STATUSES.join(", ")}.`);
	}
	if (route.query !== undefined) {
		if (
			!Array.isArray(route.query) ||
			route.query.some((key) => typeof key !== "string")
		) {
			bad([...path, "query"], '"query" is a list of input keys.');
		} else {
			for (const [index, key] of (route.query as string[]).entries()) {
				place(key, "the query", [...path, "query", index]);
			}
		}
	}
	for (const [option, where] of [
		["headers", "a header"],
		["cookie", "a cookie"],
	] as const) {
		const value = route[option];
		if (value === undefined) continue;
		if (!isObject(value)) {
			bad([...path, option], `"${option}" maps input keys to names.`);
			continue;
		}
		for (const [key, name] of Object.entries(value)) {
			if (typeof name !== "string" || !TOKEN.test(name)) {
				bad([...path, option, key], `"${key}" must name ${where}.`);
			}
			place(key, where, [...path, option, key]);
		}
	}
	if (route.setCookie !== undefined) {
		if (!isObject(route.setCookie)) {
			bad([...path, "setCookie"], '"setCookie" maps response keys to cookies.');
			return;
		}
		for (const [key, cookie] of Object.entries(route.setCookie)) {
			const at = [...path, "setCookie", key];
			if (known.response && !known.response.includes(key)) {
				bad(
					at,
					`"${key}" is not a key of the response. Response keys: ${known.response.join(", ") || "(none)"}.`,
				);
			}
			if (
				!isObject(cookie) ||
				typeof cookie.name !== "string" ||
				!TOKEN.test(cookie.name)
			) {
				bad(
					at,
					'A cookie is { "name", "httpOnly"?, "secure"?, "sameSite"?, "path"?, "domain"?, "maxAge"? }.',
				);
				continue;
			}
			for (const option of Object.keys(cookie)) {
				if (!COOKIE_KEYS.includes(option)) {
					issues.push(
						issue(
							[...at, option],
							"unknown_key",
							`"${option}" is not valid in a cookie. Valid keys: ${COOKIE_KEYS.join(", ")}.`,
						),
					);
				}
			}
			if (
				cookie.sameSite !== undefined &&
				!["strict", "lax", "none"].includes(cookie.sameSite as string)
			) {
				bad([...at, "sameSite"], '"sameSite" is "strict", "lax" or "none".');
			}
			for (const option of ["httpOnly", "secure"]) {
				if (
					cookie[option] !== undefined &&
					typeof cookie[option] !== "boolean"
				) {
					bad([...at, option], `"${option}" must be a boolean.`);
				}
			}
			if (
				cookie.maxAge !== undefined &&
				(!Number.isInteger(cookie.maxAge) || (cookie.maxAge as number) < 0)
			) {
				bad(
					[...at, "maxAge"],
					'"maxAge" is a whole number of seconds, 0 or more.',
				);
			}
		}
	}
}

/**
 * Checks the `access` of a use case as `useCaseOf` will: its shape, the
 * input key of `owner` and the context keys of `context` when `known` has
 * them.
 */
export function checkAccess(
	access: unknown,
	path: Path,
	known: KnownKeys,
	issues: SpecIssue[],
): void {
	const bad = (at: Path, message: string) =>
		issues.push(issue(at, "invalid_access", message));
	if (!isObject(access)) {
		bad(
			path,
			'"access" is { "public": true } or { "scopes"?, "owner"?, "context"? }.',
		);
		return;
	}
	for (const key of Object.keys(access)) {
		if (!["public", "scopes", "owner", "context"].includes(key)) {
			issues.push(
				issue(
					[...path, key],
					"unknown_key",
					`"${key}" is not valid in an access. Valid keys: public, scopes, owner, context.`,
				),
			);
		}
	}
	if (access.public !== undefined && typeof access.public !== "boolean") {
		bad([...path, "public"], '"public" must be a boolean.');
	}
	if (access.public === true) {
		if (Object.keys(access).length > 1) {
			bad(
				path,
				'"public": true takes no other option: anyone may call the use case.',
			);
		}
		return;
	}
	const { scopes, owner, context } = access;
	if (
		scopes !== undefined &&
		(!Array.isArray(scopes) ||
			scopes.some((scope) => typeof scope !== "string" || scope === "") ||
			new Set(scopes).size !== scopes.length)
	) {
		bad([...path, "scopes"], '"scopes" must be distinct, non-empty strings.');
	}
	if (owner !== undefined) {
		if (
			!isObject(owner) ||
			typeof owner.input !== "string" ||
			Object.keys(owner).some((key) => key !== "input" && key !== "claim") ||
			(owner.claim !== undefined &&
				(typeof owner.claim !== "string" || owner.claim === ""))
		) {
			bad([...path, "owner"], '"owner" is { "input", "claim"? }.');
		} else if (known.input && !known.input.includes(owner.input)) {
			bad(
				[...path, "owner", "input"],
				`"${owner.input}" is not a key of the input. Input keys: ${known.input.join(", ") || "(none)"}.`,
			);
		}
	}
	if (context !== undefined) {
		if (!isObject(context)) {
			bad(
				[...path, "context"],
				'"context" maps context keys to "subject", "scopes" or "claims.<name>".',
			);
			return;
		}
		for (const [key, value] of Object.entries(context)) {
			if (typeof value !== "string" || !PRINCIPAL_VALUE.test(value)) {
				bad(
					[...path, "context", key],
					`"${key}" must be "subject", "scopes" or "claims.<name>".`,
				);
			}
			if (known.context && !known.context.includes(key)) {
				bad(
					[...path, "context", key],
					known.context.length > 0
						? `"${key}" is not a key of the context. Context keys: ${known.context.join(", ")}.`
						: `"${key}" needs a context: the use case declares none.`,
				);
			}
		}
	}
}
