import type { JsonValue } from "../../json";

/**
 * Who is calling: what an authenticator made of the credentials of a request.
 * `subject` identifies the caller (a user id), `scopes` is what it may do.
 */
export interface Principal {
	readonly subject: string;
	readonly scopes: readonly string[];
	/** Anything else the credentials say (a tenant, a role). */
	readonly claims?: Readonly<Record<string, JsonValue>>;
}

/** A value of the principal: its subject, its scopes or one of its claims. */
type PrincipalValue = "subject" | "scopes" | `claims.${string}`;

/**
 * Who may call a use case, as data: declared with the `access` setting of
 * `useCaseOf` or with `@Access`, and enforced by every output before the use
 * case runs. `{ public: true }` lets anyone in. Any other declaration needs
 * an authenticated caller (`{}` asks for nothing more), and may add:
 *
 * - `scopes`: the caller has all of them;
 * - `owner`: the input key `input` equals the subject of the caller, or its
 *   claim `claim`;
 * - `context`: keys of the context of the call filled from the caller, over
 *   whatever the request sent.
 */
export type AccessDeclaration =
	| { readonly public: true }
	| {
			readonly public?: false;
			readonly scopes?: readonly string[];
			readonly owner?: { readonly input: string; readonly claim?: string };
			readonly context?: { readonly [contextKey: string]: PrincipalValue };
	  };
