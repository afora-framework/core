import type { AnyBlueprint } from "../blueprint/types/blueprint.interface";
import { isScalarKey } from "./route";
import type { AccessDeclaration } from "./types/access.interface";

type Obj = Record<string, unknown>;
function isObject(value: unknown): value is Obj {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ACCESS_KEYS = ["public", "scopes", "owner", "context"];
const PRINCIPAL_VALUE = /^(subject|scopes|claims\.[^.]+)$/;

/** Whether `access` lets anyone in. */
export function isPublicAccess(
	access: AccessDeclaration,
): access is { readonly public: true } {
	return access.public === true;
}

/**
 * The frozen declaration of `access` for a use case whose input is
 * `blueprint`, or the reason it is not valid. The keys of `context` are
 * checked where the context is known: when the use case becomes an operation.
 */
export function accessDeclarationOf(
	access: unknown,
	blueprint: AnyBlueprint,
): AccessDeclaration | string {
	if (!isObject(access)) {
		return "Expected access to be { public: true } or { scopes?, owner?, context? }.";
	}
	for (const key of Object.keys(access)) {
		if (!ACCESS_KEYS.includes(key)) return `access has no option "${key}".`;
	}
	const { scopes, owner, context } = access;
	if (access.public !== undefined && typeof access.public !== "boolean") {
		return "Expected access.public to be a boolean.";
	}
	if (access.public === true) {
		if (Object.keys(access).length > 1) {
			return "access.public leaves no room for scopes, owner or context: anyone may call.";
		}
		return Object.freeze({ public: true as const });
	}
	if (scopes !== undefined) {
		if (
			!Array.isArray(scopes) ||
			scopes.some((scope) => typeof scope !== "string" || scope === "") ||
			new Set(scopes).size !== scopes.length
		) {
			return "Expected access.scopes to be distinct, non-empty strings.";
		}
	}
	if (owner !== undefined) {
		if (
			!isObject(owner) ||
			Object.keys(owner).some((key) => key !== "input" && key !== "claim") ||
			typeof owner.input !== "string" ||
			(owner.claim !== undefined &&
				(typeof owner.claim !== "string" || owner.claim === ""))
		) {
			return "Expected access.owner to be { input, claim? }.";
		}
		if (!isScalarKey(blueprint, owner.input)) {
			return `access.owner compares "${owner.input}", which is not a scalar key of the input.`;
		}
	}
	if (context !== undefined) {
		if (!isObject(context)) {
			return "Expected access.context to map context keys to values of the caller.";
		}
		for (const [key, value] of Object.entries(context)) {
			if (typeof value !== "string" || !PRINCIPAL_VALUE.test(value)) {
				return `Expected access.context["${key}"] to be "subject", "scopes" or "claims.<name>".`;
			}
		}
	}
	return Object.freeze({
		...(scopes === undefined
			? {}
			: { scopes: Object.freeze([...(scopes as string[])]) }),
		...(owner === undefined
			? {}
			: { owner: Object.freeze({ ...(owner as { input: string }) }) }),
		...(context === undefined
			? {}
			: { context: Object.freeze({ ...context }) }),
	}) as AccessDeclaration;
}
