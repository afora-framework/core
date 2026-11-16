import type {
	AnyBlueprint,
	BlueprintField,
} from "../blueprint/types/blueprint.interface";
import { parseField } from "../parse/parse";
import { isPublicAccess } from "../use-case/access";
import type {
	AccessDeclaration,
	Principal,
} from "../use-case/types/access.interface";
import { coerceTextValues } from "./coerce";
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

/** No value: an owner the input or the caller does not give, or one its property rejects. */
const NO_OWNER = Symbol("no owner");

/**
 * The owner value a call names: `given` through the pipeline of its field
 * (`preHandle`, validation, `afterHandle`), so what is compared is what the
 * use case acts on (an email trimmed and lowercased, a slug slugified), or
 * `NO_OWNER` when the field rejects it. The value is parsed as given, as
 * the use case parses it: a sink coerces its text before the call.
 */
function canonicalOwnerOf(
	field: BlueprintField | undefined,
	given: unknown,
	key: string,
	source: string,
): unknown {
	if (given === undefined || given === null) return NO_OWNER;
	const parsed = parseField(field, given, [key], source);
	return parsed.issues === undefined &&
		parsed.value !== undefined &&
		parsed.value !== null
		? parsed.value
		: NO_OWNER;
}

/**
 * Whether the caller's `expected` value is the owner `canonical` names. The
 * claim (or subject) is compared as it was issued, not normalized: a token
 * whose claim only becomes the owner's value once trimmed, lowercased or
 * slugified names another identity, so the authenticator must issue the
 * canonical value. A claim that is not a string, a number or a boolean
 * never matches.
 */
function isOwner(canonical: unknown, expected: unknown): boolean {
	if (canonical === NO_OWNER) return false;
	if (
		typeof expected !== "string" &&
		typeof expected !== "number" &&
		typeof expected !== "boolean"
	) {
		return false;
	}
	if (
		typeof canonical !== "string" &&
		typeof canonical !== "number" &&
		typeof canonical !== "boolean"
	) {
		return false;
	}
	return String(canonical) === String(expected);
}

/**
 * The check of `access` for the operation `id`, made once: given the input
 * and the options of a call, it throws `Unauthenticated` or `Forbidden`, or
 * gives the options to run the command with (the context filled from the
 * caller). `owner` compares the caller with the owner value of `input` after
 * the pipeline of its field, the value the use case acts on (see `isOwner`). Throws `InvalidOutputStage` when `access.context` names a key the
 * `context` of the operation does not have.
 */
export function accessGuardOf(
	id: string,
	access: AccessDeclaration,
	context: AnyBlueprint | undefined,
	input: AnyBlueprint,
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
	const ownerField = owner
		? (input.properties[owner.input] as BlueprintField | undefined)
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
	return (value, options) => {
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
				typeof value === "object" && value !== null
					? (value as Record<string, unknown>)[owner.input]
					: undefined;
			const canonical = canonicalOwnerOf(ownerField, given, owner.input, id);
			if (!isOwner(canonical, expected)) {
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
			// A subject or a claim is text; the key it fills may be a number.
			else if (typeof value === "string" && context) {
				filled[key] = coerceTextValues(context, { [key]: value })[key];
			} else filled[key] = value;
		}
		return { context: filled };
	};
}
