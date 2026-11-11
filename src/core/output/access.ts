import type { AnyBlueprint } from "../blueprint/types/blueprint.interface";
import { isPublicAccess } from "../use-case/access";
import type {
	AccessDeclaration,
	Principal,
} from "../use-case/types/access.interface";
import { Forbidden, InvalidOutputStage, Unauthenticated } from "./exceptions";
import type { OperationCallOptions } from "./types/output.interface";

/** What `command.run` takes: the call options without the caller. */
type RunOptions = { readonly context?: unknown } | undefined;

/** Reads `subject`, `scopes` or `claims.<name>` of a principal. */
function readerOf(path: string): (principal: Principal) => unknown {
	if (path === "subject") return (principal) => principal.subject;
	if (path === "scopes") return (principal) => [...principal.scopes];
	const claim = path.slice("claims.".length);
	return (principal) =>
		principal.claims && Object.hasOwn(principal.claims, claim)
			? principal.claims[claim]
			: undefined;
}

/**
 * The check of `access` for the operation `id`, made once: given the input
 * and the options of a call, it throws `Unauthenticated` or `Forbidden`, or
 * gives the options to run the command with (the context filled from the
 * caller). Throws `InvalidOutputStage` when `access.context` names a key the
 * `context` of the operation does not have.
 */
export function accessGuardOf(
	id: string,
	access: AccessDeclaration,
	context: AnyBlueprint | undefined,
): (input: unknown, options: OperationCallOptions | undefined) => RunOptions {
	if (isPublicAccess(access)) {
		return (_input, options) =>
			options === undefined ? undefined : { context: options.context };
	}
	const scopes = access.scopes ?? [];
	const owner = access.owner;
	const ownerOf = owner
		? readerOf(owner.claim === undefined ? "subject" : `claims.${owner.claim}`)
		: undefined;
	const fills = Object.entries(access.context ?? {}).map(
		([key, path]) => [key, readerOf(path)] as const,
	);
	for (const [key] of fills) {
		if (!context || !Object.hasOwn(context.properties, key)) {
			throw new InvalidOutputStage({
				source: id,
				details: {
					reason: `The access of ${id} fills the context key "${key}", which the context of the operation does not declare.`,
				},
			});
		}
	}
	return (input, options) => {
		const principal = options?.principal;
		if (
			principal === undefined ||
			principal === null ||
			typeof principal.subject !== "string" ||
			!Array.isArray(principal.scopes)
		) {
			throw new Unauthenticated({ source: id });
		}
		if (scopes.length > 0) {
			const missing = scopes.filter(
				(scope) => !principal.scopes.includes(scope),
			);
			if (missing.length > 0) {
				throw new Forbidden({
					source: id,
					details: { reason: "scope", scopes: missing },
				});
			}
		}
		if (owner && ownerOf) {
			const expected = ownerOf(principal);
			const given =
				typeof input === "object" && input !== null
					? (input as Record<string, unknown>)[owner.input]
					: undefined;
			if (
				given === undefined ||
				given === null ||
				expected === undefined ||
				expected === null ||
				String(given) !== String(expected)
			) {
				throw new Forbidden({ source: id, details: { reason: "owner" } });
			}
		}
		if (fills.length === 0) {
			return options?.context === undefined
				? undefined
				: { context: options.context };
		}
		const given = options?.context;
		const filled: Record<string, unknown> = {
			...(typeof given === "object" && given !== null ? given : {}),
		};
		for (const [key, read] of fills) {
			const value = read(principal);
			if (value === undefined) delete filled[key];
			else filled[key] = value;
		}
		return { context: filled };
	};
}
