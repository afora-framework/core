import { describe, expect, test } from "bun:test";
import {
	compileRoutes,
	type HttpRequest,
	httpOptionsIssue,
	jwtOf,
} from "../../adapters";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	configure,
	entityOf,
	Integer,
	idOf,
	inMemoryProvider,
	outputOf,
	repositoryOf,
	resetRuntime,
	StdUseCases,
	UseCaseUnavailable,
	useCaseOf,
} from "../../index";

const secret = "a-secret-of-at-least-thirty-two-characters";
const named = { env: "AFORA_SESSION_TEST_SECRET" } as const;
process.env[named.env] = secret;

class User extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.string,
		roles: ctx.list.string,
		tenant: ctx.string,
	})),
	{ plugins: (ctx) => [ctx.authenticatable] },
) {}

function build(cookies = false) {
	const Users = repositoryOf({
		entity: User,
		provider: inMemoryProvider(),
		actions: ["findById", "findByEmail", "create", "delete"],
	});
	const token = {
		secret: named,
		issuer: "blog",
		expiresIn: 60,
		refresh: { expiresIn: 3600 },
		scopes: ["self"],
		scopesFrom: "roles",
		claims: { tenant: "tenant" },
	} as const;
	const session = { name: "sid", secure: false } as const;
	class Me extends useCaseOf({
		name: "Me",
		blueprint: blueprintOf(() => ({})),
		response: blueprintOf((ctx) => ({ id: ctx.string, tenant: ctx.string })),
		context: blueprintOf((ctx) => ({ id: ctx.string, tenant: ctx.string })),
		route: { method: "get", path: "/me" },
		access: {
			scopes: ["admin"],
			context: { id: "subject", tenant: "claims.tenant" },
		},
	}) {
		override async execute() {
			return { ...this.context };
		}
	}
	const Auth = commandOf({
		name: "Auth",
		useCases: (ctx) => ({
			// The keys the tokens are made from are set, never taken from the input.
			register: ctx.register(Users, {
				values: { roles: ["admin"], tenant: "acme" },
				route: { method: "post", path: "/users", status: 201 },
			}),
			login: ctx.login(Users, {
				as: "user",
				token,
				route: {
					method: "post",
					path: "/login",
					...(cookies
						? {
								setCookie: {
									token: session,
									refreshToken: {
										name: "rid",
										secure: false,
										path: "/refresh",
										maxAge: 3600,
									},
								},
							}
						: {}),
				},
			}),
			refresh: ctx.refresh(Users, {
				token,
				route: {
					method: "post",
					path: "/refresh",
					...(cookies
						? {
								cookie: { refreshToken: "rid" },
								setCookie: {
									token: session,
									refreshToken: {
										name: "rid",
										secure: false,
										path: "/refresh",
										maxAge: 3600,
									},
								},
							}
						: {}),
				},
			}),
			logout: ctx.logout(Users, {
				route: {
					method: "post",
					path: "/logout",
					...(cookies
						? {
								setCookie: {
									token: session,
									refreshToken: {
										name: "rid",
										secure: false,
										path: "/refresh",
									},
								},
							}
						: {}),
				},
			}),
			me: Me,
		}),
	});
	const Api = outputOf({ name: "Api", commands: [Auth] });
	const table = compileRoutes(
		Api.operations,
		{
			auth: {
				jwt: {
					secret: named,
					issuer: "blog",
					...(cookies ? { cookie: "sid" } : {}),
				},
			},
			docs: { path: "/openapi.json", info: { title: "Blog", version: "1" } },
		},
		{ output: { name: "Api", statuses: Api.statuses } },
		{ source: "test" },
	);
	const call = async (
		path: string,
		given: { body?: unknown; headers?: Record<string, string> } = {},
	) => {
		const route = table.routes.find((entry) => entry.path === path);
		if (!route) throw new Error(path);
		const request: HttpRequest = {
			param: () => undefined,
			query: () => ({}),
			header: (name) =>
				given.headers?.[name] ??
				(name === "content-type" ? "application/json" : undefined),
			text: () => JSON.stringify(given.body ?? {}),
		};
		const result = await route.handle(request);
		return {
			...result,
			json: result.body ? JSON.parse(result.body) : undefined,
		};
	};
	return { Users, Auth, Me, table, call };
}

const ana = {
	name: "Ana",
	email: "ana@x.dev",
	password: "S3nha!forte",
};

describe("session: tokens of login", () => {
	test("login gives a token and a refresh token for the entity", async () => {
		const { call } = build();
		expect((await call("/users", { body: ana })).status).toBe(201);
		const login = await call("/login", {
			body: { email: ana.email, password: ana.password },
		});
		expect(login.status).toBe(200);
		expect(Object.keys(login.json).sort()).toEqual([
			"refreshToken",
			"token",
			"user",
		]);
		expect(login.json.user.password).toBe("********");
		const jwt = jwtOf({ secret, issuer: "blog" });
		expect(await jwt.verify(login.json.token)).toEqual({
			subject: login.json.user.id,
			scopes: ["self", "admin"],
			claims: { tenant: "acme" },
		});
		expect(
			(await jwt.verify(login.json.refreshToken, { use: "refresh:User" }))
				.scopes,
		).toEqual([]);
		const wrong = await call("/login", {
			body: { email: ana.email, password: "nope" },
		});
		expect(wrong.status).toBe(401);
		expect(wrong.json.title).toBe("UseCaseInvalidCredentials");
	});

	test("the token of the options authenticates the caller, and fills the context", async () => {
		const { call } = build();
		await call("/users", { body: ana });
		const { json } = await call("/login", {
			body: { email: ana.email, password: ana.password },
		});
		expect((await call("/me")).status).toBe(401);
		expect(
			(await call("/me", { headers: { authorization: "Bearer nope" } })).status,
		).toBe(401);
		const me = await call("/me", {
			headers: { authorization: `Bearer ${json.token}` },
		});
		expect(me.json).toEqual({ id: json.user.id, tenant: "acme" });
		// A refresh token is not an access token.
		expect(
			(
				await call("/me", {
					headers: { authorization: `Bearer ${json.refreshToken}` },
				})
			).status,
		).toBe(401);
		const bob = await jwtOf({ secret, issuer: "blog" }).sign({
			subject: "bob",
			scopes: ["self"],
			claims: { tenant: "acme" },
		});
		const denied = await call("/me", {
			headers: { authorization: `Bearer ${bob}` },
		});
		expect(denied.status).toBe(403);
	});

	test("refresh exchanges a refresh token, while the entity exists", async () => {
		const { call, Users } = build();
		await call("/users", { body: ana });
		const { json } = await call("/login", {
			body: { email: ana.email, password: ana.password },
		});
		const refreshed = await call("/refresh", {
			body: { refreshToken: json.refreshToken },
		});
		expect(refreshed.status).toBe(200);
		expect(Object.keys(refreshed.json).sort()).toEqual([
			"refreshToken",
			"token",
		]);
		expect(
			(
				await call("/me", {
					headers: { authorization: `Bearer ${refreshed.json.token}` },
				})
			).status,
		).toBe(200);
		expect(
			(await call("/refresh", { body: { refreshToken: json.token } })).status,
		).toBe(401);
		expect(
			(await call("/refresh", { body: { refreshToken: "nope" } })).status,
		).toBe(401);
		await Users.delete(json.user.id);
		expect(
			(await call("/refresh", { body: { refreshToken: json.refreshToken } }))
				.status,
		).toBe(401);
	});

	test("with setCookie the tokens travel as cookies, and logout removes them", async () => {
		const { call } = build(true);
		await call("/users", { body: ana });
		const login = await call("/login", {
			body: { email: ana.email, password: ana.password },
		});
		expect(Object.keys(login.json)).toEqual(["user"]);
		expect(login.cookies).toHaveLength(2);
		expect(login.cookies[0]).toMatch(
			/^sid=[^;]+; Path=\/; HttpOnly; SameSite=Lax$/,
		);
		expect(login.cookies[1]).toMatch(
			/^rid=[^;]+; Path=\/refresh; HttpOnly; SameSite=Lax; Max-Age=3600$/,
		);
		const cookieOf = (cookies: readonly string[]) =>
			cookies.map((cookie) => cookie.split(";")[0]).join("; ");
		const me = await call("/me", {
			headers: { cookie: cookieOf(login.cookies) },
		});
		expect(me.status).toBe(200);
		const refreshed = await call("/refresh", {
			headers: { cookie: cookieOf(login.cookies) },
		});
		expect(refreshed.status).toBe(200);
		expect(refreshed.json).toEqual({});
		expect(refreshed.cookies).toHaveLength(2);
		const out = await call("/logout");
		expect(out.json).toEqual({});
		expect(out.cookies).toEqual([
			"sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
			"rid=; Path=/refresh; HttpOnly; SameSite=Lax; Max-Age=0",
		]);
	});

	test("the document names the scheme of the token and leaves the cookies out of the body", () => {
		const bearer = JSON.parse(build().table.docs?.handle().body as string);
		expect(bearer.components.securitySchemes).toEqual({
			bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
		});
		expect(bearer.paths["/me"].get.security).toEqual([{ bearer: ["admin"] }]);
		expect(bearer.paths["/login"].post).not.toHaveProperty("security");
		const cookie = JSON.parse(build(true).table.docs?.handle().body as string);
		expect(cookie.components.securitySchemes).toEqual({
			session: { type: "apiKey", in: "cookie", name: "sid" },
		});
		const login = cookie.paths["/login"].post.responses["200"];
		expect(
			Object.keys(login.content["application/json"].schema.properties),
		).toEqual(["user"]);
		expect(login.headers["set-cookie"].description).toContain("`sid`");
		expect(cookie.paths["/refresh"].post.parameters).toEqual([
			{ name: "rid", in: "cookie", required: true, schema: { type: "string" } },
		]);
	});

	test("login without the option issues nothing, as before", async () => {
		const { Users } = build();
		const Plain = commandOf({
			name: "Plain",
			useCases: (ctx) => ({ login: ctx.login(Users) }),
		});
		expect(Object.keys(Plain.useCases.login.response.properties)).toEqual([
			"item",
		]);
	});

	test("rejects token options it cannot use", () => {
		const { Users } = build();
		type Loose = {
			readonly [maker in "login" | "refresh" | "logout"]: (
				...args: unknown[]
			) => unknown;
		};
		const make = (run: (ctx: Loose) => unknown) => () =>
			commandOf({
				name: "Bad",
				useCases: (ctx) => ({ bad: run(ctx as never) }) as never,
			});
		expect(
			make((ctx: Loose) => ctx.login(Users, { token: { secret } })),
		).toThrow(UseCaseUnavailable);
		expect(
			make((ctx: Loose) =>
				ctx.login(Users, { token: { secret: named, scopesFrom: "nope" } }),
			),
		).toThrow();
		expect(
			make((ctx: Loose) =>
				ctx.login(Users, {
					token: { secret: named, refresh: { expiresIn: 0 } },
				}),
			),
		).toThrow(UseCaseUnavailable);
		expect(
			make((ctx: Loose) => ctx.refresh(Users, { token: { secret: named } })),
		).toThrow(UseCaseUnavailable);
		expect(
			make((ctx: Loose) => ctx.logout(Users, { token: { secret: named } })),
		).toThrow(UseCaseUnavailable);
	});

	test("what is described names the secret, never holds it", () => {
		const { Users, Auth, Me } = build();
		const app = applicationOf({
			name: "blog",
			entities: { User },
			repositories: { Users },
			useCases: { Me },
			commands: { Auth },
		});
		const described = app.describe();
		expect(described.useCases.LoginUser?.route).toEqual({
			method: "post",
			path: "/login",
		});
		const text = JSON.stringify(described);
		expect(text).toContain(named.env);
		expect(text).not.toContain(secret);
		expect(
			httpOptionsIssue({ auth: { jwt: { secret } } } as never, "x"),
		).toContain("the secret is named, not written");
		expect(
			httpOptionsIssue({ auth: { jwt: { secret: named } } }, "x"),
		).toBeUndefined();
	});
});

describe("session: entities with integer ids", () => {
	function buildInteger() {
		let next = 0;
		class Member extends entityOf(
			blueprintOf((ctx) => ({ name: ctx.string })),
			{
				id: idOf(Integer, () => ++next),
				plugins: (ctx) => [ctx.authenticatable],
			},
		) {}
		const Members = repositoryOf({
			entity: Member,
			provider: inMemoryProvider(),
			actions: ["findById", "findByEmail", "create"],
		});
		const token = {
			secret: named,
			issuer: "blog",
			expiresIn: 60,
			refresh: { expiresIn: 3600 },
		} as const;
		class Me extends useCaseOf({
			name: "Me",
			blueprint: blueprintOf(() => ({})),
			response: blueprintOf((ctx) => ({ id: ctx.integer })),
			context: blueprintOf((ctx) => ({ id: ctx.integer })),
			route: { method: "get", path: "/me" },
			access: { context: { id: "subject" } },
		}) {
			override async execute() {
				return { ...this.context };
			}
		}
		const Auth = commandOf({
			name: "Auth",
			useCases: (ctx) => ({
				register: ctx.register(Members, {
					route: { method: "post", path: "/users", status: 201 },
				}),
				login: ctx.login(Members, {
					as: "user",
					token,
					route: { method: "post", path: "/login" },
				}),
				refresh: ctx.refresh(Members, {
					token,
					route: { method: "post", path: "/refresh" },
				}),
				me: Me,
			}),
		});
		const Api = outputOf({ name: "Api", commands: [Auth] });
		const table = compileRoutes(
			Api.operations,
			{ auth: { jwt: { secret: named, issuer: "blog" } } },
			{ output: { name: "Api", statuses: Api.statuses } },
			{ source: "test" },
		);
		return async (
			path: string,
			given: { body?: unknown; headers?: Record<string, string> } = {},
		) => {
			const route = table.routes.find((entry) => entry.path === path);
			if (!route) throw new Error(path);
			const result = await route.handle({
				param: () => undefined,
				query: () => ({}),
				header: (name) =>
					given.headers?.[name] ??
					(name === "content-type" ? "application/json" : undefined),
				text: () => JSON.stringify(given.body ?? {}),
			});
			return {
				...result,
				json: result.body ? JSON.parse(result.body) : undefined,
			};
		};
	}

	test("the subject fills an integer context key, and refresh finds the entity", async () => {
		const call = buildInteger();
		const body = { name: "Ana", email: "ana@x.dev", password: "S3nha!forte" };
		expect((await call("/users", { body })).status).toBe(201);
		const login = await call("/login", {
			body: { email: body.email, password: body.password },
		});
		expect(login.json.user.id).toBe(1);
		const me = await call("/me", {
			headers: { authorization: `Bearer ${login.json.token}` },
		});
		expect(me.status).toBe(200);
		expect(me.json).toEqual({ id: 1 });
		const refreshed = await call("/refresh", {
			body: { refreshToken: login.json.refreshToken },
		});
		expect(refreshed.status).toBe(200);
		const jwt = jwtOf({ secret, issuer: "blog" });
		expect((await jwt.verify(refreshed.json.token)).subject).toBe("1");
	});
});

describe("session: token version", () => {
	class Member extends entityOf(
		blueprintOf((ctx) => ({ name: ctx.string, sessionVersion: ctx.integer })),
		{
			change: ["sessionVersion"],
			sensitive: ["sessionVersion"],
			plugins: (ctx) => [ctx.authenticatable],
		},
	) {}
	const versioned = {
		secret: named,
		issuer: "blog",
		expiresIn: 60,
		refresh: { expiresIn: 3600 },
		versionFrom: "sessionVersion",
	} as const;
	const self = { key: "id", context: "userId" } as const;

	function buildVersioned(rotate = false) {
		const Members = repositoryOf({
			entity: Member,
			provider: inMemoryProvider(),
			actions: ["findById", "findByEmail", "create", "update", "increment"],
		});
		const token = rotate ? { ...versioned, rotate: true } : versioned;
		const Auth = commandOf({
			name: "Auth",
			useCases: (ctx) => ({
				register: ctx.register(Members, {
					as: "member",
					values: { sessionVersion: 0 },
				}),
				login: ctx.login(Members, { as: "member", token }),
				refresh: ctx.refresh(Members, { token }),
				logout: ctx.logout(Members, { token, owner: self }),
				changePassword: ctx.changePassword(Members, {
					as: "member",
					token: { versionFrom: "sessionVersion" },
					owner: self,
				}),
			}),
		});
		return { Members, Auth };
	}

	const signIn = async (Auth: ReturnType<typeof buildVersioned>["Auth"]) => {
		const { member } = await Auth.run("register", ana);
		const login = await Auth.run("login", {
			email: ana.email,
			password: ana.password,
		});
		return { member, login, context: { userId: member.id } };
	};

	const refused = (promise: Promise<unknown>) =>
		promise.then(
			() => {
				throw new Error("Expected the refresh token to be refused.");
			},
			(error: { readonly name: string }) => error.name,
		);

	test("a refresh token carries the version, which refresh compares with the stored one", async () => {
		const { Auth, Members } = buildVersioned();
		const { member, login } = await signIn(Auth);
		const jwt = jwtOf({ secret, issuer: "blog" });
		expect(
			(await jwt.verify(login.refreshToken, { use: "refresh:Member" })).claims,
		).toEqual({ ver: 0 });
		// The access token says nothing of it.
		expect((await jwt.verify(login.token)).claims).toBeUndefined();
		const refreshed = await Auth.run("refresh", {
			refreshToken: login.refreshToken,
		});
		// Without rotate, a refresh token refreshes again while the version holds.
		await Auth.run("refresh", { refreshToken: login.refreshToken });
		await Auth.run("refresh", { refreshToken: refreshed.refreshToken });
		// Any other use case that increments the version ends the sessions too.
		await Members.increment(member.id, { sessionVersion: 1 });
		expect(
			await refused(Auth.run("refresh", { refreshToken: login.refreshToken })),
		).toBe("UseCaseInvalidCredentials");
		// A refresh token with no version, issued before the option, is refused.
		const old = await jwt.sign(
			{ subject: member.id },
			{ expiresIn: 3600, use: "refresh:Member" },
		);
		expect(await refused(Auth.run("refresh", { refreshToken: old }))).toBe(
			"UseCaseInvalidCredentials",
		);
	});

	test("a refresh rotated while changePassword hashes the new password is ended with the others", async () => {
		const { Auth, Members } = buildVersioned(true);
		let hold = false;
		let open = () => {};
		const opened = new Promise<void>((resolve) => {
			open = resolve;
		});
		configure({
			hasher: {
				hash: async (plain: string) => {
					if (hold) await opened;
					return Bun.password.hash(plain, {
						algorithm: "argon2id",
						memoryCost: 1024,
						timeCost: 1,
					});
				},
				verify: (plain: string, hash: string) =>
					Bun.password.verify(plain, hash),
			},
		});
		try {
			const { member, login, context } = await signIn(Auth);
			hold = true;
			const changed = Auth.run(
				"changePassword",
				{
					id: member.id,
					currentPassword: ana.password,
					password: "An0ther!Passw0rd#2026",
				},
				{ context },
			);
			// The password is being hashed, after the entity was read: whoever
			// holds the refresh token rotates it meanwhile.
			await Bun.sleep(5);
			const rotated = await Auth.run("refresh", {
				refreshToken: login.refreshToken,
			});
			open();
			await changed;
			expect(
				await refused(
					Auth.run("refresh", { refreshToken: rotated.refreshToken }),
				),
			).toBe("UseCaseInvalidCredentials");
			expect((await Members.findById(member.id))?.sessionVersion).toBe(2);
		} finally {
			resetRuntime();
		}
	});

	test("a refresh token issued before logout is refused, one issued after refreshes", async () => {
		const { Auth, Members } = buildVersioned();
		const { member, login, context } = await signIn(Auth);
		expect(await Auth.run("logout", {}, { context })).toEqual({
			token: "",
			refreshToken: "",
		});
		expect((await Members.findById(member.id))?.sessionVersion).toBe(1);
		expect(
			await refused(Auth.run("refresh", { refreshToken: login.refreshToken })),
		).toBe("UseCaseInvalidCredentials");
		const again = await Auth.run("login", {
			email: ana.email,
			password: ana.password,
		});
		const refreshed = await Auth.run("refresh", {
			refreshToken: again.refreshToken,
		});
		expect(Object.keys(refreshed).sort()).toEqual(["refreshToken", "token"]);
	});

	test("a refresh token issued before changePassword is refused", async () => {
		const { Auth } = buildVersioned();
		const { member, login, context } = await signIn(Auth);
		const changed = await Auth.run(
			"changePassword",
			{
				id: member.id,
				currentPassword: ana.password,
				password: "Outra!senha9",
			},
			{ context },
		);
		// The entity given is the one stored, with the version it now has.
		expect(changed.member.sessionVersion).toBe(1);
		expect(changed.member.toJSON().sessionVersion).toBe("********");
		expect(
			await refused(Auth.run("refresh", { refreshToken: login.refreshToken })),
		).toBe("UseCaseInvalidCredentials");
		const again = await Auth.run("login", {
			email: ana.email,
			password: "Outra!senha9",
		});
		await Auth.run("refresh", { refreshToken: again.refreshToken });
	});

	test("with rotate a refresh token is used once, and a refresh ends the other sessions", async () => {
		const { Auth } = buildVersioned(true);
		const { login } = await signIn(Auth);
		const other = await Auth.run("login", {
			email: ana.email,
			password: ana.password,
		});
		const refreshed = await Auth.run("refresh", {
			refreshToken: login.refreshToken,
		});
		expect(
			await refused(Auth.run("refresh", { refreshToken: login.refreshToken })),
		).toBe("UseCaseInvalidCredentials");
		// The session of the other device carried the same version.
		expect(
			await refused(Auth.run("refresh", { refreshToken: other.refreshToken })),
		).toBe("UseCaseInvalidCredentials");
		const next = await Auth.run("refresh", {
			refreshToken: refreshed.refreshToken,
		});
		await Auth.run("refresh", { refreshToken: next.refreshToken });
	});

	test("with rotate two concurrent refreshes of one token give exactly one success", async () => {
		const { Auth, Members } = buildVersioned(true);
		const { member, login } = await signIn(Auth);
		const results = await Promise.allSettled(
			Array.from({ length: 2 }, () =>
				Auth.run("refresh", { refreshToken: login.refreshToken }),
			),
		);
		const won = results.filter((result) => result.status === "fulfilled");
		expect(won).toHaveLength(1);
		for (const result of results) {
			if (result.status === "rejected") {
				expect(result.reason.name).toBe("UseCaseInvalidCredentials");
			}
		}
		const [first] = won as PromiseFulfilledResult<{ refreshToken: string }>[];
		const winner = first?.value.refreshToken as string;
		// Each refresh that got past the first check added 1: the new refresh
		// token refreshes only if no other attempt added after it.
		const stored = (await Members.findById(member.id))?.sessionVersion;
		const carried = (
			await jwtOf({ secret, issuer: "blog" }).verify(winner, {
				use: "refresh:Member",
			})
		).claims?.ver;
		expect(stored).toBeGreaterThanOrEqual(carried as number);
		const again = Auth.run("refresh", { refreshToken: winner });
		if (stored === carried) await again;
		else expect(await refused(again)).toBe("UseCaseInvalidCredentials");
	});

	test("with rotate a refresh token used again after its rotation changes nothing", async () => {
		const { Auth, Members } = buildVersioned(true);
		const { member, login } = await signIn(Auth);
		const refreshed = await Auth.run("refresh", {
			refreshToken: login.refreshToken,
		});
		expect(
			await refused(Auth.run("refresh", { refreshToken: login.refreshToken })),
		).toBe("UseCaseInvalidCredentials");
		// Refused before the increment: the session refreshed is not ended.
		expect((await Members.findById(member.id))?.sessionVersion).toBe(1);
		await Auth.run("refresh", { refreshToken: refreshed.refreshToken });
	});

	test("logout with the option ends only the sessions of the caller it is given", async () => {
		const { Auth, Members } = buildVersioned();
		const { login } = await signIn(Auth);
		const { member: bob } = await Auth.run("register", {
			name: "Bob",
			email: "bob@x.dev",
			password: ana.password,
		});
		await Auth.run("logout", {}, { context: { userId: bob.id } });
		expect((await Members.findById(bob.id))?.sessionVersion).toBe(1);
		await Auth.run("refresh", { refreshToken: login.refreshToken });
		// No caller: the context is required, nothing is ended or answered.
		const anonymous = await Auth.run("logout", {}, {
			context: {},
		} as never).then(
			() => "answered",
			(error: { readonly name: string }) => error.name,
		);
		expect(anonymous).not.toBe("answered");
		// A caller that is no longer stored has no session to end.
		expect(
			await Auth.run(
				"logout",
				{},
				{ context: { userId: "0190a6a0-0000-7000-8000-0000000000ff" } },
			),
		).toEqual({ token: "", refreshToken: "" });
	});

	test("over HTTP, logout needs an authenticated caller", async () => {
		const { Auth } = buildVersioned();
		const Members = repositoryOf({
			entity: Member,
			provider: inMemoryProvider(),
			actions: ["findById", "findByEmail", "create", "increment"],
		});
		const Http = commandOf({
			name: "Http",
			useCases: (ctx) => ({
				register: ctx.register(Members, { values: { sessionVersion: 0 } }),
				logout: ctx.logout(Members, {
					token: versioned,
					owner: self,
					access: { context: { userId: "subject" } },
					route: { method: "post", path: "/logout" },
				}),
			}),
		});
		expect(Auth.useCases.logout.context).toBeDefined();
		const Api = outputOf({ name: "Api", commands: [Http] });
		const table = compileRoutes(
			Api.operations,
			{ auth: { jwt: { secret: named, issuer: "blog" } } },
			{ output: { name: "Api", statuses: Api.statuses } },
			{ source: "test" },
		);
		const route = table.routes.find((entry) => entry.path === "/logout");
		const call = (headers: Record<string, string>) =>
			route?.handle({
				param: () => undefined,
				query: () => ({}),
				header: (name) =>
					headers[name] ??
					(name === "content-type" ? "application/json" : undefined),
				text: () => "{}",
			});
		expect((await call({}))?.status).toBe(401);
		const { item: member } = await Http.run("register", ana);
		const token = await jwtOf({ secret, issuer: "blog" }).sign({
			subject: member.id,
		});
		const out = await call({ authorization: `Bearer ${token}` });
		expect(out?.status).toBe(200);
		expect((await Members.findById(member.id))?.sessionVersion).toBe(1);
	});

	test("without the options, tokens and logout are as before", async () => {
		const { Users, Auth } = build();
		await Auth.run("register", ana);
		const login = await Auth.run("login", {
			email: ana.email,
			password: ana.password,
		});
		const jwt = jwtOf({ secret, issuer: "blog" });
		expect(
			(await jwt.verify(login.refreshToken, { use: "refresh:User" })).claims,
		).toBeUndefined();
		expect(Auth.useCases.logout.context).toBeUndefined();
		expect(Users.actions).not.toContain("increment");
		await Auth.run("logout", {});
		await Auth.run("refresh", { refreshToken: login.refreshToken });
	});

	test("rejects version options it cannot use, at declaration", () => {
		const Members = repositoryOf({
			entity: Member,
			provider: inMemoryProvider(),
			actions: ["findById", "findByEmail", "update", "increment"],
		});
		class Loose extends entityOf(
			blueprintOf((ctx) => ({
				label: ctx.string,
				count: ctx.integer,
				maybe: ctx.optional.integer,
				amount: ctx.number,
				level: ctx.integer,
			})),
			{
				change: ["label", "maybe", "amount", "level"],
				plugins: (ctx) => [ctx.authenticatable],
			},
		) {}
		const Loosely = repositoryOf({
			entity: Loose,
			provider: inMemoryProvider(),
			actions: ["findById", "findByEmail", "update", "increment"],
		});
		const NoIncrement = repositoryOf({
			entity: Member,
			provider: inMemoryProvider(),
			actions: ["findById", "findByEmail", "update"],
		});
		const reason = (name: string, repository: unknown, options: unknown) => {
			try {
				(
					StdUseCases.context as unknown as Record<
						string,
						(repository: unknown, options?: unknown) => unknown
					>
				)[name]?.(repository, options);
			} catch (error) {
				expect(error).toBeInstanceOf(UseCaseUnavailable);
				return (error as Error).message;
			}
			throw new Error("Expected UseCaseUnavailable.");
		};
		const { versionFrom: _, ...plain } = versioned;
		expect(
			reason("refresh", Members, { token: { ...plain, rotate: true } }),
		).toContain("token.rotate needs token.versionFrom");
		expect(
			reason("login", Members, { token: { ...plain, rotate: false } }),
		).toContain("token.rotate needs token.versionFrom");
		for (const key of ["label", "maybe", "amount"]) {
			expect(
				reason("login", Loosely, { token: { ...plain, versionFrom: key } }),
			).toContain("must name a required integer key");
		}
		expect(
			reason("refresh", Loosely, { token: { ...plain, versionFrom: "count" } }),
		).toContain("must be in the change list");
		// A change key that is not sensitive is an input of update, so the
		// caller could set the version back after a logout.
		for (const name of ["login", "refresh"]) {
			expect(
				reason(name, Loosely, { token: { ...plain, versionFrom: "level" } }),
			).toContain("must be a sensitive key");
		}
		expect(
			reason("logout", Loosely, {
				token: { versionFrom: "level" },
				owner: self,
			}),
		).toContain("must be a sensitive key");
		expect(
			reason("login", Members, { token: { ...plain, versionFrom: "nope" } }),
		).toContain("nope");
		expect(
			reason("login", Members, {
				token: { secret: named, versionFrom: "sessionVersion" },
			}),
		).toContain("it needs token.refresh");
		expect(
			reason("refresh", NoIncrement, { token: { ...versioned, rotate: true } }),
		).toContain('"increment"');
		expect(
			reason("logout", NoIncrement, { token: versioned, owner: self }),
		).toContain('"increment"');
		expect(
			reason("changePassword", NoIncrement, {
				token: { versionFrom: "sessionVersion" },
			}),
		).toContain('"increment"');
		expect(reason("logout", Members, { token: versioned })).toContain(
			"it needs the option owner",
		);
		expect(
			reason("logout", Members, {
				token: versioned,
				owner: { key: "ownerId", context: "userId" },
			}),
		).toBeString();
		expect(reason("logout", Members, { owner: self })).toContain(
			"it needs token.versionFrom",
		);
		expect(reason("logout", Members, { token: plain, owner: self })).toContain(
			"token.versionFrom",
		);
		expect(
			reason("changePassword", Members, {
				token: { versionFrom: "sessionVersion", scopes: [] },
			}),
		).toContain("{ versionFrom }");
	});
});
