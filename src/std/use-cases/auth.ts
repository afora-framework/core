import {
	isScopeToken,
	jwtOf,
	jwtOptionsIssue,
	REGISTERED,
} from "../../core/auth/jwt";
import { fieldOf } from "../../core/blueprint/callable";
import { Exception } from "../../core/exception/exception";
import type { JsonValue } from "../../core/json";
import { coerceTextValues } from "../../core/output/coerce";
import { outputValueOf } from "../../core/output/problem";
import { isProperty } from "../../core/property/is-property";
import { RepositoryEntityNotFound } from "../../core/repository/exceptions";
import { rawTypeOf } from "../../core/schema/schema";
import {
	UseCaseEntityConflict,
	UseCaseEntityNotFound,
	UseCaseInvalidCredentials,
} from "../../core/use-case/exceptions";
import { useCasePluginOf } from "../../core/use-case/plugin";
import { isPlain } from "../../core/use-case/steps/references";
import type {
	UseCaseFieldPlan,
	UseCaseTargetInfo,
} from "../../core/use-case/types/plugin.interface";
import type { AnyExceptionClass } from "../../core/use-case/use-case";
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

const TOKEN_KEYS = [
	"refresh",
	"scopes",
	"scopesFrom",
	"claims",
	"versionFrom",
	"rotate",
];
/** The claim of a refresh token that holds the token version it was issued with. */
const VERSION_CLAIM = "ver";
const isTexts = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * By entity, the keys its tokens are made from (`token.scopesFrom` and the
 * keys of `token.claims`, by login and refresh) and the keys register takes
 * from its input, each with the use case that declared it first.
 */
const tokenKeys = new WeakMap<object, Map<string, string>>();
const inputKeys = new WeakMap<object, Map<string, string>>();
/**
 * By entity, the key of its token version (`token.versionFrom`), and the
 * keys the registers that take token keys (`takesTokenKeys`) read from their
 * input: a caller of register never chooses the version a session starts at.
 */
const versionKeys = new WeakMap<object, Map<string, string>>();
const versionInput = new WeakMap<object, Map<string, string>>();

/** Records `keys` in `own` for `by`, and the first of `keys` that `other` holds, with its owner. */
function crossed(
	target: UseCaseTargetInfo,
	own: WeakMap<object, Map<string, string>>,
	other: WeakMap<object, Map<string, string>>,
	keys: readonly string[],
	by: string,
): { key: string; by: string } | undefined {
	const known = other.get(target.entity);
	const key = keys.find((item) => known?.has(item));
	let recorded = own.get(target.entity);
	if (!recorded) {
		recorded = new Map();
		own.set(target.entity, recorded);
	}
	for (const item of keys) if (!recorded.has(item)) recorded.set(item, by);
	return key === undefined ? undefined : { key, by: known?.get(key) ?? "" };
}

/** Throws `UseCaseUnavailable` when a register that takes token keys takes the token version key, whichever is declared first. */
function noVersionInInput(
	target: UseCaseTargetInfo,
	side: "version" | "input",
	keys: readonly string[],
	by: string,
): void {
	const [own, other] =
		side === "version"
			? [versionKeys, versionInput]
			: [versionInput, versionKeys];
	const clash = crossed(target, own, other, keys, by);
	if (clash) {
		const [register, token] =
			side === "version" ? [clash.by, by] : [by, clash.by];
		target.unavailable(
			`the refresh tokens of ${token} carry the token version "${clash.key}" (token.versionFrom), so ${register} cannot take it from its input (takesTokenKeys does not lift this): a new entity starts at its default version, set it with values`,
		);
	}
}

/**
 * Records `keys` of the entity of `target` as made into tokens by `by`, or
 * taken from the input of register `by`; throws `UseCaseUnavailable` when
 * one of them is already the other, whichever was declared first: a caller
 * of register would choose what the tokens say.
 */
function noTokenKeyInInput(
	target: UseCaseTargetInfo,
	side: "token" | "input",
	keys: readonly string[],
	by: string,
): void {
	const [own, other] =
		side === "token" ? [tokenKeys, inputKeys] : [inputKeys, tokenKeys];
	const known = other.get(target.entity);
	const clash = keys.find((key) => known?.has(key));
	if (clash !== undefined) {
		const [register, token] =
			side === "token" ? [known?.get(clash), by] : [by, known?.get(clash)];
		target.unavailable(
			`the token of ${token} is made from "${clash}" (token.scopesFrom or token.claims), so ${register} cannot take it from its input: omit it or set it in values`,
		);
	}
	let recorded = own.get(target.entity);
	if (!recorded) {
		recorded = new Map();
		own.set(target.entity, recorded);
	}
	for (const key of keys) if (!recorded.has(key)) recorded.set(key, by);
}

/** The token version of an entity, as `token.versionFrom` and `token.rotate` give it. */
interface TokenVersion {
	/** The key of the entity that holds the version. */
	readonly key: string;
	/** Whether `refresh` adds 1 to it, so that a refresh token is used once. */
	readonly rotate: boolean;
}

/** Whether the field of `plan` is a property whose values are integers. */
function isIntegerPlan(plan: UseCaseFieldPlan): boolean {
	if (plan.kind !== "property") return false;
	const property = fieldOf(plan.field);
	if (!isProperty(property)) return false;
	const { type } = rawTypeOf(property.type.schema) as { type?: unknown };
	return type === "integer";
}

/**
 * `token.versionFrom` and `token.rotate`, checked: the key is a required
 * integer key of the entity in its `change` list, which `increment` takes;
 * `rotate` needs it. `undefined` without `versionFrom`.
 */
function versionOf(
	target: UseCaseTargetInfo,
	given: { readonly versionFrom?: unknown; readonly rotate?: unknown },
	by: string,
): TokenVersion | undefined {
	const { versionFrom, rotate } = given;
	if (rotate !== undefined && typeof rotate !== "boolean") {
		return target.unavailable("the option token.rotate must be a boolean");
	}
	if (versionFrom === undefined) {
		if (rotate === undefined) return undefined;
		return target.unavailable(
			"the option token.rotate needs token.versionFrom: a refresh token is used once through the version it carries",
		);
	}
	if (typeof versionFrom !== "string") {
		return target.unavailable(
			"the option token.versionFrom must name a key of the entity",
		);
	}
	const plan = target.field(versionFrom);
	if (plan.identity || plan.optional || !isIntegerPlan(plan)) {
		return target.unavailable(
			`token.versionFrom "${versionFrom}" must name a required integer key of the entity`,
		);
	}
	if (!target.changeKeys.includes(versionFrom)) {
		return target.unavailable(
			`token.versionFrom "${versionFrom}" must be in the change list of the entity, so that increment can add to it`,
		);
	}
	noVersionInInput(target, "version", [versionFrom], by);
	return { key: versionFrom, rotate: rotate === true };
}

/** What a `run` step gives its function after the args: the bound dependencies of the call. */
interface RunOptions {
	readonly dependencies: Readonly<Record<string, unknown>>;
}

/** The `increment` of the repository bound to the call. */
function incrementOf({ dependencies }: RunOptions) {
	const repository = dependencies.repository as {
		increment(
			id: unknown,
			deltas: Readonly<Record<string, number>>,
		): Promise<Record<string, unknown>>;
	};
	return (id: unknown, key: string) => repository.increment(id, { [key]: 1 });
}

const isNotFound = (error: unknown): boolean =>
	error instanceof Exception && error.is(RepositoryEntityNotFound);

/**
 * The function of a `run` step that adds 1 to the token version of the
 * entity of an id, atomically, ending every refresh token issued before;
 * gives the entity stored.
 */
const endSessionsOf =
	(version: TokenVersion) => (id: unknown, options: RunOptions) =>
		incrementOf(options)(id, version.key);

/**
 * `token` of `logout` and `changePassword`, which read only `versionFrom`:
 * the token options of `login` (checked as such), or `{ versionFrom }`
 * alone. `undefined` without the option.
 */
function versionOptionOf(
	target: UseCaseTargetInfo,
	options: Options,
	verb: string,
): TokenVersion | undefined {
	const given = options.token;
	if (given === undefined) return undefined;
	if (!isPlain(given)) {
		return target.unavailable(
			"the option token must be the token options of login, or { versionFrom }",
		);
	}
	if (Object.hasOwn(given, "secret")) {
		const bad = jwtOptionsIssue(given, "the option token", TOKEN_KEYS, true);
		if (bad) return target.unavailable(bad);
	} else if (Object.keys(given).some((key) => key !== "versionFrom")) {
		return target.unavailable(
			"the option token must be the token options of login, or { versionFrom }",
		);
	}
	const version = versionOf(target, given, metaOf(target, options, verb).name);
	if (!version) {
		return target.unavailable(
			`the option token of ${verb} is for token.versionFrom, the token version it adds 1 to`,
		);
	}
	if (!target.actions.includes("increment")) {
		return target.unavailable(
			'with token.versionFrom, it needs the action "increment", which adds 1 to the token version',
		);
	}
	return version;
}

/**
 * What issues and verifies the tokens of the `token` option, checked;
 * `undefined` without the option.
 */
function tokensOf(target: UseCaseTargetInfo, options: Options, verb: string) {
	const given = options.token;
	if (given === undefined) return undefined;
	const bad = jwtOptionsIssue(given, "the option token", TOKEN_KEYS, true);
	if (bad) return target.unavailable(bad);
	const {
		refresh,
		scopes,
		scopesFrom,
		claims,
		versionFrom,
		rotate,
		...jwtOptions
	} = given as StdTokenOptions;
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
	const version = versionOf(
		target,
		{ versionFrom, rotate },
		metaOf(target, options, verb).name,
	);
	if (version && refresh === undefined) {
		return target.unavailable(
			"the option token.versionFrom is carried by the refresh tokens: it needs token.refresh",
		);
	}
	if (scopes !== undefined && !isTexts(scopes)) {
		return target.unavailable(
			"the option token.scopes must be a list of scopes",
		);
	}
	const badScope = scopes?.find((scope) => !isScopeToken(scope));
	if (badScope !== undefined) {
		return target.unavailable(
			`the scope ${JSON.stringify(badScope)} of the option token.scopes must be a scope token: not empty, without spaces or control characters`,
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
	const registered = claimKeys.find(([claim]) => REGISTERED.has(claim));
	if (registered) {
		return target.unavailable(
			`the option token.claims cannot name the claim "${registered[0]}": it is registered (${[...REGISTERED].join(", ")})`,
		);
	}
	for (const [, key] of claimKeys) target.field(key);
	const jwt = jwtOf(jwtOptions);
	// A refresh token belongs to the entity it was issued for: the refresh
	// of another entity sharing the secret refuses it, whatever the ids.
	const refreshUse = `refresh:${target.entityName}`;
	noTokenKeyInInput(
		target,
		"token",
		[
			...(scopesFrom === undefined ? [] : [scopesFrom]),
			...claimKeys.map(([, key]) => key),
		],
		metaOf(target, options, verb).name,
	);
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
							{
								subject: subject.subject,
								...(version
									? {
											claims: {
												[VERSION_CLAIM]: entity[version.key] as number,
											},
										}
									: {}),
							},
							{ expiresIn: refresh.expiresIn, use: refreshUse },
						),
					}
				: {}),
		};
	};
	// The subject of a token is text; the id it names may be a number.
	const verifyRefresh = async (token: string) => {
		const caller = await jwt.verify(token, { use: refreshUse });
		return {
			...caller,
			subject: coerceTextValues(target.entity.blueprint, {
				id: caller.subject,
			}).id,
		};
	};
	return { issue, verifyRefresh, refresh: refresh !== undefined, version };
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

/**
 * The option `takesTokenKeys` of register, checked: `true` only with an
 * `access` that asks for scopes, so that whoever may call it is an
 * administrator and not the public.
 */
function takesTokenKeysOf(
	target: UseCaseTargetInfo,
	options: Options,
): boolean {
	const { takesTokenKeys, access } = options;
	if (takesTokenKeys === undefined) return false;
	if (takesTokenKeys !== true) {
		return target.unavailable("the option takesTokenKeys must be true");
	}
	const scopes = isPlain(access)
		? (access as { public?: unknown; scopes?: unknown }).scopes
		: undefined;
	if (
		!isPlain(access) ||
		(access as { public?: unknown }).public === true ||
		!Array.isArray(scopes) ||
		scopes.length === 0
	) {
		return target.unavailable(
			"the option takesTokenKeys needs an access that asks for scopes ({ scopes: [...] }): only a caller with a scope may choose the keys a token is made from",
		);
	}
	return true;
}

/** Stores an authenticatable entity, unless its email is taken. */
export const register = useCasePluginOf<"register", RegisterMaker>("register", {
	description:
		"Stores an authenticatable entity built from the input, its password given plain and stored as a hash, unless the email is taken.",
	...authenticatable(["findByEmail", "create"]),
	compile: (target, options) => {
		const takes = takesTokenKeysOf(target, options);
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
			(keys) => {
				const name = metaOf(target, options, "Register").name;
				noVersionInInput(target, "input", keys, name);
				if (!takes) noTokenKeyInInput(target, "input", keys, name);
			},
			["takesTokenKeys"],
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
		const tokens = tokensOf(target, options, "Login");
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
		"Changes the password of the authenticatable entity of an id, when the current password given matches, and stores it; with token.versionFrom, then adds 1 to its token version, so that no refresh token issued before refreshes.",
	...authenticatable(["findById", "update"]),
	compile: (target, options) => {
		checkOptions(target, options, ["as", "owner", "token", ...HOOKS]);
		const owner = ownerOf(target, options);
		const hooks = hooksOf(target, options);
		const version = versionOptionOf(target, options, "changePassword");
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
				...(version
					? [
							{ update: "repository", value: "$item", as: "updated" },
							// After the write: a refresh token issued before it, with
							// the password changed or not yet, no longer refreshes.
							{
								run: "endSessions",
								fn: endSessionsOf(version),
								args: ["$updated.id"],
								as: "saved",
							},
						]
					: [{ update: "repository", value: "$item", as: "saved" }]),
				...hooks.after("$saved"),
				{ return: { [asOf(target, options)]: "$saved" } },
			],
		};
	},
});

/** The version a refresh token carries, `undefined` for one issued without. */
const claimedVersion = (caller: {
	readonly claims?: Readonly<Record<string, unknown>>;
}): number | undefined => {
	const claimed = caller.claims?.[VERSION_CLAIM];
	return Number.isInteger(claimed) ? (claimed as number) : undefined;
};

/**
 * The steps of `refresh` that check the token version: the one the refresh
 * token carries must be the one stored, else `invalid`. With `rotate`, 1
 * is added to the stored one, atomically, and the token is accepted only if
 * the version stored after is the one it carries plus 1: of two refreshes
 * of one token, however close, only one gets it. The entity bound as
 * `rotated` is the one stored after.
 */
function versionSteps(
	version: TokenVersion,
	invalid: AnyExceptionClass,
): Record<string, unknown>[] {
	return [
		{
			run: "checkTokenVersion",
			fn: (caller: Parameters<typeof claimedVersion>[0], item: object) => {
				const claimed = claimedVersion(caller);
				return (
					claimed !== undefined &&
					claimed === (item as Record<string, unknown>)[version.key]
				);
			},
			args: ["$caller", "$item"],
			as: "current",
		},
		{ ensure: "true", value: "$current", error: invalid },
		...(version.rotate
			? [
					{
						run: "rotateTokenVersion",
						fn: async (
							caller: Parameters<typeof claimedVersion>[0],
							item: Readonly<Record<string, unknown>>,
							options: RunOptions,
						) => {
							const claimed = claimedVersion(caller) as number;
							try {
								const stored = await incrementOf(options)(item.id, version.key);
								return stored[version.key] === claimed + 1 ? stored : undefined;
							} catch (error) {
								// Deleted since it was read: as any entity that is gone.
								if (isNotFound(error)) return undefined;
								throw error;
							}
						},
						args: ["$caller", "$item"],
						as: "rotated",
					},
					{ ensure: "exists", value: "$rotated", error: invalid },
				]
			: []),
	];
}

/** Exchanges a refresh token for new tokens. */
export const refresh = useCasePluginOf<"refresh", RefreshMaker>("refresh", {
	description:
		"Exchanges a refresh token issued by login for a new token and a new refresh token, for the entity it names, if it still exists (and, with token.versionFrom, if the version it carries is the stored one; with token.rotate, it adds 1 to it, so a refresh token is used once). Experimental.",
	requires: { actions: ["findById"] },
	compile: (target, options) => {
		checkOptions(target, options, ["token"]);
		const tokens = tokensOf(target, options, "Refresh");
		if (!tokens?.refresh) {
			return target.unavailable(
				"it needs the option token with refresh, the same login was given",
			);
		}
		const { version } = tokens;
		if (version?.rotate && !target.actions.includes("increment")) {
			return target.unavailable(
				'with token.rotate, it needs the action "increment", which adds 1 to the token version',
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
				...(version ? versionSteps(version, invalid) : []),
				{
					run: "issueTokens",
					fn: tokens.issue,
					args: [version?.rotate ? "$rotated" : "$item"],
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

/**
 * Gives empty tokens, for a route that keeps them in cookies to remove them;
 * with `token.versionFrom`, ends the sessions of the caller first.
 */
export const logout = useCasePluginOf<"logout", LogoutMaker>("logout", {
	description:
		"Gives an empty token and refresh token: a route whose setCookie sends them removes the cookies. With token.versionFrom, it first adds 1 to the token version of the caller, so that no refresh token issued before refreshes; an access token stays valid until it expires. Experimental.",
	compile: (target, options) => {
		checkOptions(target, options, ["token", "owner"]);
		const version = versionOptionOf(target, options, "logout");
		const owner = version ? ownerOf(target, options) : undefined;
		if (!version && options.owner !== undefined) {
			return target.unavailable(
				"the option owner names the caller whose sessions logout ends: it needs token.versionFrom",
			);
		}
		if (version && owner?.plan.key !== "id") {
			return target.unavailable(
				'with token.versionFrom, it needs the option owner: { key: "id", context }, the context key that holds the id of the caller whose sessions it ends',
			);
		}
		return {
			...metaOf(target, options, "Logout"),
			blueprint: fields(() => ({})),
			response: fields(() => ({
				token: StringProperty,
				refreshToken: StringProperty,
			})),
			...(owner && version
				? {
						...contextOf(owner),
						dependencies: { repository: target.repository },
					}
				: {}),
			steps: [
				...(owner && version
					? [
							{
								run: "endSessions",
								fn: async (id: unknown, run: RunOptions) => {
									try {
										await endSessionsOf(version)(id, run);
									} catch (error) {
										// A caller that is no longer stored has no session to end.
										if (!isNotFound(error)) throw error;
									}
								},
								args: [`$context.${owner.context}`],
							},
						]
					: []),
				{ return: { token: "", refreshToken: "" } },
			],
		};
	},
});
