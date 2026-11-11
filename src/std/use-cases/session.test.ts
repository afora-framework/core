import { describe, expect, test } from "bun:test";
import {
	compileRoutes,
	type HttpRequest,
	httpOptionsIssue,
} from "../../adapters";
import { jwtOf } from "../../experimental";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	entityOf,
	inMemoryProvider,
	outputOf,
	repositoryOf,
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
			register: ctx.register(Users, {
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
			header: (name) => given.headers?.[name],
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
	roles: ["admin"],
	tenant: "acme",
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
			(await jwt.verify(login.json.refreshToken, { use: "refresh" })).scopes,
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
		await call("/users", { body: { ...ana, email: "bob@x.dev", roles: [] } });
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
		const bob = await call("/login", {
			body: { email: "bob@x.dev", password: ana.password },
		});
		const denied = await call("/me", {
			headers: { authorization: `Bearer ${bob.json.token}` },
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
