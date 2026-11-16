import { jwtOf, jwtOptionsIssue } from "../../core/auth/jwt";
import type { JsonValue } from "../../core/json";
import { coerceTextValues } from "../../core/output/coerce";
import { outputValueOf } from "../../core/output/problem";
import {
	UseCaseEntityConflict,
	UseCaseEntityNotFound,
	UseCaseInvalidCredentials,
} from "../../core/use-case/exceptions";
import { useCasePluginOf } from "../../core/use-case/plugin";
import type { UseCaseTargetInfo } from "../../core/use-case/types/plugin.interface";
import { StringProperty } from "../properties/primitives";
import { currentHasher, type PasswordHasher } from "../runtime";
import { createCompilation } from "./crud";
import {
	asOf,
	checkOptions,
	contextOf,
	distinct,
	errorOf,
	fields,
	HOOKS,
	hooksOf,
	idOf,
	joinDependencies,
	loadSteps,
	metaOf,
	type Options,
	ownerOf,
} from "./shared";
import type {
	ChangePasswordMaker,
	LoginMaker,
	LogoutMaker,
	RefreshMaker,
	RegisterMaker,
	StdTokenOptions,
} from "./types";

const TOKEN_KEYS = ["refresh", "scopes", "scopesFrom", "claims"];
const isTexts = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * What issues and verifies the tokens of the `token` option, checked;
 * `undefined` without the option.
 */
function tokensOf(target: UseCaseTargetInfo, options: Options) {
	const given = options.token;
	if (given === undefined) return undefined;
	const bad = jwtOptionsIssue(given, "the option token", TOKEN_KEYS, true);
	if (bad) return target.unavailable(bad);
	const { refresh, scopes, scopesFrom, claims, ...jwtOptions } =
		given as StdTokenOptions;
	if (
		refresh !== undefined &&
		(typeof refresh !== "object" ||
			refresh === null ||
			Object.keys(refresh).join() !== "expiresIn" ||
			!Number.isInteger(refresh.expiresIn) ||
			refresh.expiresIn <= 0)
	) {
		return target.unavailable(
			"the option token.refresh must be { expiresIn }, a whole number of seconds above 0",
		);
	}
	if (scopes !== undefined && !isTexts(scopes)) {
		return target.unavailable(
			"the option token.scopes must be a list of scopes",
		);
	}
	if (scopesFrom !== undefined) target.field(scopesFrom);
	if (
		claims !== undefined &&
		(typeof claims !== "object" || claims === null || Array.isArray(claims))
	) {
		return target.unavailable(
			"the option token.claims must map claims to keys of the entity",
		);
	}
	const claimKeys = Object.entries(claims ?? {});
	for (const [, key] of claimKeys) target.field(key);
	const jwt = jwtOf(jwtOptions);
	const issue = async (entity: Record<string, unknown>) => {
		const held = scopesFrom === undefined ? [] : entity[scopesFrom];
		const subject = {
			subject: String(entity.id),
			scopes: [...new Set([...(scopes ?? []), ...(isTexts(held) ? held : [])])],
			...(claimKeys.length > 0
				? {
						claims: Object.fromEntries(
							claimKeys.map(([claim, key]) => [
								claim,
								outputValueOf(entity[key]) as JsonValue,
							]),
						),
					}
				: {}),
		};
		return {
			token: await jwt.sign(subject),
			...(refresh
				? {
						refreshToken: await jwt.sign(
							{ subject: subject.subject },
							{ expiresIn: refresh.expiresIn, use: "refresh" },
						),
					}
				: {}),
		};
	};
	// The subject of a token is text; the id it names may be a number.
	const verifyRefresh = async (token: string) => {
		const caller = await jwt.verify(token, { use: "refresh" });
		return {
			...caller,
			subject: coerceTextValues(target.entity.blueprint, {
				id: caller.subject,
			}).id,
		};
	};
	return { issue, verifyRefresh, refresh: refresh !== undefined };
}

/** The hash a login of an unknown email is checked against, by hasher: made once each, on first use. */
const dummyHashes = new WeakMap<PasswordHasher, Promise<string>>();

/**
 * Verifies `plain` against a hash of a password nobody has, made by the
 * hasher in use, so that a login of an unknown email costs what one of a
 * known email costs and its time does not tell them apart. Gives nothing;
 * a hasher that fails still fails, as it would for a known email.
 */
async function verifyNobody(found: unknown, plain: unknown): Promise<void> {
	if (found !== undefined && found !== null) return;
	const hasher = currentHasher();
	let hash = dummyHashes.get(hasher);
	if (!hash) {
		hash = hasher.hash("afora: the password of nobody");
		dummyHashes.set(hasher, hash);
		// A hash that failed is made again by the next call.
		hash.catch(() => dummyHashes.delete(hasher));
	}
	await hasher.verify(String(plain), await hash);
}

const authenticatable = (actions: readonly string[]) => ({
	requires: { actions, plugins: ["authenticatable"] },
});

/** Stores an authenticatable entity, unless its email is taken. */
export const register = useCasePluginOf<"register", RegisterMaker>("register", {
	description:
		"Stores an authenticatable entity built from the input, its password given plain and stored as a hash, unless the email is taken.",
	...authenticatable(["findByEmail", "create"]),
	compile: (target, options) => {
		const conflict = errorOf(
			target,
			options,
			"conflict",
			UseCaseEntityConflict,
		);
		return createCompilation(
			target,
			options,
			"Register",
			(input) => [
				{
					find: "repository.findByEmail",
					args: [`${input}.email`],
					as: "existing",
				},
				{ ensure: "absent", value: "$existing", error: conflict },
			],
			[conflict],
		);
	},
});

/** Gives the authenticatable entity of an email, when the password matches. */
export const login = useCasePluginOf<"login", LoginMaker>("login", {
	description:
		"Gives the authenticatable entity of an email when the password matches, with a token (and a refresh token) for it when the option token is given.",
	...authenticatable(["findByEmail"]),
	compile: (target, options) => {
		checkOptions(target, options, ["as", "token"]);
		const tokens = tokensOf(target, options);
		const invalid = errorOf(
			target,
			options,
			"invalid",
			UseCaseInvalidCredentials,
		);
		return {
			...metaOf(target, options, "Login"),
			blueprint: fields(() => ({
				email: target.field("email").field,
				password: StringProperty,
			})),
			response: fields(() => ({
				[asOf(target, options)]: target.entity,
				...(tokens ? { token: StringProperty } : {}),
				...(tokens?.refresh ? { refreshToken: StringProperty } : {}),
			})),
			dependencies: { repository: target.repository },
			errors: [invalid],
			steps: [
				{ find: "repository.findByEmail", args: ["$input.email"], as: "item" },
				{
					run: "verifyNobody",
					fn: verifyNobody,
					args: ["$item", "$input.password"],
				},
				{ ensure: "exists", value: "$item", error: invalid },
				{
					invoke: "$item",
					method: "verifyPassword",
					args: ["$input.password"],
					as: "matches",
				},
				{ ensure: "true", value: "$matches", error: invalid },
				...(tokens
					? [
							{
								run: "issueTokens",
								fn: tokens.issue,
								args: ["$item"],
								as: "tokens",
							},
						]
					: []),
				{
					return: {
						[asOf(target, options)]: "$item",
						...(tokens ? { token: "$tokens.token" } : {}),
						...(tokens?.refresh
							? { refreshToken: "$tokens.refreshToken" }
							: {}),
					},
				},
			],
		};
	},
});

/** Changes the password of an authenticatable entity, given its current one. */
export const changePassword = useCasePluginOf<
	"changePassword",
	ChangePasswordMaker
>("changePassword", {
	description:
		"Changes the password of the authenticatable entity of an id, when the current password given matches, and stores it.",
	...authenticatable(["findById", "update"]),
	compile: (target, options) => {
		checkOptions(target, options, ["as", "owner", ...HOOKS]);
		const owner = ownerOf(target, options);
		const hooks = hooksOf(target, options);
		const notFound = errorOf(
			target,
			options,
			"notFound",
			UseCaseEntityNotFound,
		);
		const invalid = errorOf(
			target,
			options,
			"invalid",
			UseCaseInvalidCredentials,
		);
		const password = target.field("password");
		return {
			...metaOf(target, options, "ChangePassword"),
			blueprint: fields(() => ({
				id: idOf(target),
				currentPassword: StringProperty,
				password: password.input.field,
			})),
			response: fields(() => ({ [asOf(target, options)]: target.entity })),
			...contextOf(owner),
			dependencies: joinDependencies(
				target,
				{ repository: target.repository },
				hooks,
			),
			errors: distinct(notFound, invalid, ...hooks.throws),
			steps: [
				...loadSteps(owner, notFound),
				{
					invoke: "$item",
					method: "verifyPassword",
					args: ["$input.currentPassword"],
					as: "matches",
				},
				{ ensure: "true", value: "$matches", error: invalid },
				...hooks.before("$item"),
				...(password.convert
					? [
							{
								run: "convertPassword",
								fn: password.convert,
								args: [`${hooks.input}.password`],
								as: "passwordConverted",
							},
						]
					: []),
				{
					change: "$item",
					key: "password",
					value: password.convert
						? "$passwordConverted"
						: `${hooks.input}.password`,
				},
				{ update: "repository", value: "$item", as: "saved" },
				...hooks.after("$saved"),
				{ return: { [asOf(target, options)]: "$saved" } },
			],
		};
	},
});

/** Exchanges a refresh token for new tokens. */
export const refresh = useCasePluginOf<"refresh", RefreshMaker>("refresh", {
	description:
		"Exchanges a refresh token issued by login for a new token and a new refresh token, for the entity it names, if it still exists. Experimental.",
	requires: { actions: ["findById"] },
	compile: (target, options) => {
		checkOptions(target, options, ["token"]);
		const tokens = tokensOf(target, options);
		if (!tokens?.refresh) {
			return target.unavailable(
				"it needs the option token with refresh, the same login was given",
			);
		}
		const invalid = errorOf(
			target,
			options,
			"invalid",
			UseCaseInvalidCredentials,
		);
		return {
			...metaOf(target, options, "Refresh"),
			blueprint: fields(() => ({ refreshToken: StringProperty })),
			response: fields(() => ({
				token: StringProperty,
				refreshToken: StringProperty,
			})),
			dependencies: { repository: target.repository },
			errors: [invalid],
			steps: [
				{
					run: "verifyRefreshToken",
					fn: tokens.verifyRefresh,
					args: ["$input.refreshToken"],
					as: "caller",
				},
				{
					find: "repository.findById",
					args: ["$caller.subject"],
					as: "item",
				},
				{ ensure: "exists", value: "$item", error: invalid },
				{
					run: "issueTokens",
					fn: tokens.issue,
					args: ["$item"],
					as: "tokens",
				},
				{
					return: {
						token: "$tokens.token",
						refreshToken: "$tokens.refreshToken",
					},
				},
			],
		};
	},
});

/** Gives empty tokens, for a route that keeps them in cookies to remove them. */
export const logout = useCasePluginOf<"logout", LogoutMaker>("logout", {
	description:
		"Gives an empty token and refresh token: a route whose setCookie sends them removes the cookies. Tokens are not stored, so one already issued stays valid until it expires. Experimental.",
	compile: (target, options) => {
		checkOptions(target, options, []);
		return {
			...metaOf(target, options, "Logout"),
			blueprint: fields(() => ({})),
			response: fields(() => ({
				token: StringProperty,
				refreshToken: StringProperty,
			})),
			steps: [{ return: { token: "", refreshToken: "" } }],
		};
	},
});
