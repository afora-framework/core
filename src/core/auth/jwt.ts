import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";
import type { JsonValue } from "../json";
import { Unauthenticated } from "../output/exceptions";
import type { Principal } from "../use-case/types/access.interface";
import type { Jwt, JwtAlgorithm, JwtOptions } from "./types/jwt.interface";

/** `jwtOf` got options it cannot use, or its secret is missing; `details.reason` says what. */
export const InvalidJwtOptions = exceptionOf({
	layer: ExceptionLayers.Output,
	name: "InvalidJwtOptions",
	message: ({ reason }: { readonly reason: string }) => reason,
});

const HASHES: Readonly<Record<JwtAlgorithm, string>> = {
	HS256: "SHA-256",
	HS384: "SHA-384",
	HS512: "SHA-512",
};
const MIN_SECRET = 32;
const DEFAULT_EXPIRES_IN = 900;
/** The claims of a token that are not claims of the caller. */
const REGISTERED = new Set([
	"sub",
	"scope",
	"iat",
	"exp",
	"nbf",
	"iss",
	"aud",
	"use",
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

function bytesOf(text: string): Uint8Array<ArrayBuffer> | undefined {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
	try {
		const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return undefined;
	}
}

function jsonOf(part: string): Record<string, unknown> | undefined {
	const bytes = bytesOf(part);
	if (!bytes) return undefined;
	try {
		const value: unknown = JSON.parse(decoder.decode(bytes));
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Why `options` cannot be the options of `jwtOf`, naming them `where`;
 * `undefined` when they can. `extra` are other keys the caller accepts, and
 * `described` is for options that `describe()` and `afora.json` show, where
 * the secret must be named by its environment variable, never written.
 */
export function jwtOptionsIssue(
	options: unknown,
	where: string,
	extra: readonly string[] = [],
	described = false,
): string | undefined {
	if (
		typeof options !== "object" ||
		options === null ||
		Array.isArray(options)
	) {
		return `Expected ${where} to be { secret, issuer?, audience?, expiresIn?, algorithm? }.`;
	}
	const given = options as Record<string, unknown>;
	const known = [
		"secret",
		"issuer",
		"audience",
		"expiresIn",
		"algorithm",
		...extra,
	];
	for (const key of Object.keys(given)) {
		if (!known.includes(key)) return `${where} has no option "${key}".`;
	}
	const { secret, issuer, audience, expiresIn, algorithm } = given;
	const named =
		typeof secret === "object" && secret !== null && !Array.isArray(secret)
			? (secret as Record<string, unknown>)
			: undefined;
	if (
		named
			? Object.keys(named).join() !== "env" ||
				typeof named.env !== "string" ||
				named.env === ""
			: typeof secret !== "string"
	) {
		return `Expected ${where}.secret to be the secret or { "env": "NAME" }.`;
	}
	if (described && !named) {
		return `Expected ${where}.secret to be { "env": "NAME" }: these options are described, so the secret is named, not written.`;
	}
	if (typeof secret === "string" && secret.length < MIN_SECRET) {
		return `Expected ${where}.secret to have at least ${MIN_SECRET} characters.`;
	}
	for (const [key, value] of [
		["issuer", issuer],
		["audience", audience],
	] as const) {
		if (value !== undefined && (typeof value !== "string" || value === "")) {
			return `Expected ${where}.${key} to be a non-empty string.`;
		}
	}
	if (
		expiresIn !== undefined &&
		(!Number.isInteger(expiresIn) || (expiresIn as number) <= 0)
	) {
		return `Expected ${where}.expiresIn to be a whole number of seconds above 0.`;
	}
	if (algorithm !== undefined && !Object.hasOwn(HASHES, algorithm as string)) {
		return `Expected ${where}.algorithm to be one of ${Object.keys(HASHES).join(", ")}.`;
	}
	return undefined;
}

/**
 * Signs and verifies JSON Web Tokens with a shared secret (HMAC), on Web
 * Crypto, so it runs on Bun, Node and Workers alike:
 *
 * ```ts
 * const jwt = jwtOf({ secret: { env: "JWT_SECRET" }, issuer: "blog" });
 * const token = await jwt.sign({ subject: user.id, scopes: ["posts:write"] });
 * const principal = await jwt.verify(token); // { subject, scopes, claims? }
 * hono(options, { authenticator: jwt.authenticator() });
 * ```
 *
 * A token is refused (`Unauthenticated`) when it is malformed, signed with
 * another algorithm or secret, expired, not yet valid, of another issuer,
 * audience or use, or has no subject. Throws `InvalidJwtOptions` for options
 * it cannot use, and when the secret of `{ env }` is missing or shorter than
 * 32 characters, on the first token.
 */
export function jwtOf(options: JwtOptions): Jwt {
	const issue = jwtOptionsIssue(options, "jwtOf");
	if (issue) {
		throw new InvalidJwtOptions({
			source: "jwtOf",
			details: { reason: issue },
		});
	}
	const algorithm = options.algorithm ?? "HS256";
	const lifetime = options.expiresIn ?? DEFAULT_EXPIRES_IN;
	const header = base64url(
		encoder.encode(JSON.stringify({ alg: algorithm, typ: "JWT" })),
	);
	let imported: Promise<CryptoKey> | undefined;
	const keyOf = (): Promise<CryptoKey> => {
		if (imported) return imported;
		let secret: string | undefined;
		if (typeof options.secret === "string") secret = options.secret;
		else {
			const name = options.secret.env;
			secret = (
				globalThis as {
					process?: { env?: Record<string, string | undefined> };
				}
			).process?.env?.[name];
			if (typeof secret !== "string" || secret.length < MIN_SECRET) {
				throw new InvalidJwtOptions({
					source: "jwtOf",
					details: {
						reason: `The environment variable ${name} must hold a secret of at least ${MIN_SECRET} characters.`,
					},
				});
			}
		}
		imported = crypto.subtle.importKey(
			"raw",
			encoder.encode(secret),
			{ name: "HMAC", hash: HASHES[algorithm] },
			false,
			["sign", "verify"],
		);
		return imported;
	};
	const refused = (): never => {
		throw new Unauthenticated({ source: "jwt" });
	};

	const jwt: Jwt = {
		async sign(subject, token = {}) {
			const now = Math.floor(Date.now() / 1000);
			const payload = {
				...(subject.claims ?? {}),
				sub: subject.subject,
				scope: (subject.scopes ?? []).join(" "),
				iat: now,
				exp: now + (token.expiresIn ?? lifetime),
				...(options.issuer === undefined ? {} : { iss: options.issuer }),
				...(options.audience === undefined ? {} : { aud: options.audience }),
				...(token.use === undefined ? {} : { use: token.use }),
			};
			const signing = `${header}.${base64url(encoder.encode(JSON.stringify(payload)))}`;
			const signature = await crypto.subtle.sign(
				"HMAC",
				await keyOf(),
				encoder.encode(signing),
			);
			return `${signing}.${base64url(new Uint8Array(signature))}`;
		},
		async verify(token, expected = {}) {
			if (typeof token !== "string") return refused();
			const parts = token.split(".");
			if (parts.length !== 3) return refused();
			const [head, body, sign] = parts as [string, string, string];
			// The algorithm is the one of the options, never the one the token names.
			if (jsonOf(head)?.alg !== algorithm) return refused();
			const signature = bytesOf(sign);
			if (!signature) return refused();
			const valid = await crypto.subtle.verify(
				"HMAC",
				await keyOf(),
				signature,
				encoder.encode(`${head}.${body}`),
			);
			const payload = valid ? jsonOf(body) : undefined;
			if (!payload) return refused();
			const now = Math.floor(Date.now() / 1000);
			const { sub, scope, exp, nbf, iss, aud, use } = payload;
			if (
				typeof sub !== "string" ||
				sub === "" ||
				typeof exp !== "number" ||
				exp <= now ||
				(nbf !== undefined && (typeof nbf !== "number" || nbf > now)) ||
				(options.issuer !== undefined && iss !== options.issuer) ||
				(options.audience !== undefined &&
					aud !== options.audience &&
					!(Array.isArray(aud) && aud.includes(options.audience))) ||
				use !== expected.use
			) {
				return refused();
			}
			const claims: Record<string, JsonValue> = {};
			for (const [key, value] of Object.entries(payload)) {
				if (!REGISTERED.has(key)) claims[key] = value as JsonValue;
			}
			return {
				subject: sub,
				scopes:
					typeof scope === "string" && scope !== "" ? scope.split(" ") : [],
				...(Object.keys(claims).length > 0 ? { claims } : {}),
			} satisfies Principal;
		},
		authenticator(reading = {}) {
			const header = (reading.header ?? "authorization").toLowerCase();
			const { cookie } = reading;
			return async (request) => {
				const sent = request.header(header);
				const token =
					sent !== undefined
						? sent.replace(/^Bearer +/i, "").trim()
						: cookie !== undefined
							? request.cookie(cookie)
							: undefined;
				if (token === undefined || token === "") return null;
				return jwt.verify(token);
			};
		},
	};
	return Object.freeze(jwt);
}
