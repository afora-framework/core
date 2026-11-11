import type { Authenticator } from "../../output/types/http.interface";
import type { Principal } from "../../use-case/types/access.interface";

/** The algorithms `jwtOf` signs and verifies with: HMAC with a shared secret. */
export type JwtAlgorithm = "HS256" | "HS384" | "HS512";

/** The options of `jwtOf`. JSON, so they can live in the options of a sink. */
export interface JwtOptions {
	/**
	 * The secret tokens are signed with: the text itself, or the name of the
	 * environment variable that holds it (`{ env: "JWT_SECRET" }`), read when
	 * the first token is signed or verified. At least 32 characters.
	 */
	readonly secret: string | { readonly env: string };
	/** The `iss` claim: set when signing, required when verifying. */
	readonly issuer?: string;
	/** The `aud` claim: set when signing, required when verifying. */
	readonly audience?: string;
	/**
	 * The seconds a token lives.
	 *
	 * @default 900
	 */
	readonly expiresIn?: number;
	/**
	 * The algorithm the tokens are signed and verified with.
	 *
	 * @default "HS256"
	 */
	readonly algorithm?: JwtAlgorithm;
}

/** What a token is signed for. */
export interface JwtSubject {
	readonly subject: string;
	readonly scopes?: readonly string[];
	readonly claims?: Principal["claims"];
}

/** What changes for one token. */
export interface JwtTokenOptions {
	/** The seconds this token lives, instead of the `expiresIn` of the options. */
	readonly expiresIn?: number;
	/**
	 * What the token is for, e.g. `"refresh"`: kept in its `use` claim, and a
	 * token verifies only for the use it was signed for (none by default), so
	 * a refresh token is not accepted as an access token.
	 */
	readonly use?: string;
}

/** Signs and verifies the tokens of one secret (see `jwtOf`). */
export interface Jwt {
	/** A signed token for `subject`: `sub`, `scope` (the scopes, space separated), `iat`, `exp` and the claims. */
	sign(subject: JwtSubject, options?: JwtTokenOptions): Promise<string>;
	/** The caller a token was signed for. Rejects with `Unauthenticated` for a token it does not accept. */
	verify(
		token: string,
		options?: Pick<JwtTokenOptions, "use">,
	): Promise<Principal>;
	/**
	 * An authenticator that reads the token from the `authorization` header
	 * (`Bearer <token>`; another header with `header`) and, with `cookie`,
	 * from that cookie when the header is absent. No token is an anonymous
	 * caller; one that does not verify is refused.
	 */
	authenticator(options?: {
		readonly header?: string;
		readonly cookie?: string;
	}): Authenticator;
}

/**
 * The options of `jwtOf` where they are described (`describe()`,
 * `afora.json`): the secret is named by its environment variable.
 */
export interface DescribedJwtOptions extends Omit<JwtOptions, "secret"> {
	readonly secret: { readonly env: string };
}
