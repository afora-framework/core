import { describe, expect, test } from "bun:test";
import { compileRoutes, type HttpRequest } from "../../adapters";
import { InvalidJwtOptions, jwtOf } from "../../experimental";
import {
	blueprintOf,
	commandOf,
	entityOf,
	inMemoryProvider,
	outputOf,
	repositoryOf,
	Unauthenticated,
	UseCaseUnavailable,
} from "../../index";

const secret = "a-secret-of-at-least-thirty-two-characters";
const refused = async (run: Promise<unknown>) => {
	try {
		await run;
	} catch (error) {
		return (error as InstanceType<typeof Unauthenticated>).is(Unauthenticated);
	}
	return false;
};
const payloadOf = (token: string) =>
	JSON.parse(
		atob(
			(token.split(".")[1] as string).replaceAll("-", "+").replaceAll("_", "/"),
		),
	);

const usersOf = () => {
	class User extends entityOf(
		blueprintOf((ctx) => ({ roles: ctx.list.string, tenant: ctx.string })),
		{ plugins: (ctx) => [ctx.authenticatable] },
	) {}
	return repositoryOf({
		entity: User,
		provider: inMemoryProvider(),
		actions: ["findById", "findByEmail", "create"],
	});
};
const routesOf = (
	token: Record<string, unknown>,
	values: { roles: string[]; tenant: string } = { roles: [], tenant: "t" },
) => {
	const Users = usersOf();
	const Auth = commandOf({
		name: "Auth",
		useCases: (ctx) => ({
			register: ctx.register(Users, {
				values,
				route: { method: "post", path: "/users", status: 201 },
			}),
			login: ctx.login(Users, {
				token: token as never,
				route: { method: "post", path: "/login" },
			}),
		}),
	});
	const Api = outputOf({ name: "Api", commands: [Auth] });
	const table = compileRoutes(
		Api.operations,
		{},
		{ output: { name: "Api", statuses: Api.statuses } },
		{ source: "test" },
	);
	return async (path: string, body: unknown) => {
		const route = table.routes.find((r) => r.path === path);
		const request: HttpRequest = {
			param: () => undefined,
			query: () => ({}),
			header: () => undefined,
			text: () => JSON.stringify(body),
		};
		const response = await (route as NonNullable<typeof route>).handle(request);
		return {
			status: response.status,
			json: response.body ? JSON.parse(response.body) : undefined,
		};
	};
};

describe("SEC-23: scopes are scope tokens", () => {
	test("SEC-23: sign refuses a scope that is empty or holds a space or a control character", async () => {
		const jwt = jwtOf({ secret });
		for (const scope of [
			"posts:read admin",
			"",
			"a\tb",
			"a\nb",
			"a\x00b",
			"a\x7fb",
			" ",
		]) {
			await expect(
				jwt.sign({ subject: "u1", scopes: [scope] }),
			).rejects.toThrow(InvalidJwtOptions);
		}
		const token = await jwt.sign({
			subject: "u1",
			scopes: ["posts:read", "posts:write"],
		});
		expect((await jwt.verify(token)).scopes).toEqual([
			"posts:read",
			"posts:write",
		]);
	});

	test("SEC-23: a fixed scope of the option token that is not a scope token is refused at declaration", () => {
		expect(() =>
			routesOf({
				secret: { env: "SEC23_SECRET" },
				scopes: ["posts:read admin"],
			}),
		).toThrow(UseCaseUnavailable);
	});

	test("SEC-23: login issues no token for an entity that holds a scope that is not a scope token", async () => {
		process.env.SEC23_SECRET = secret;
		const call = routesOf(
			{ secret: { env: "SEC23_SECRET" }, scopesFrom: "roles" },
			{ roles: ["posts:read admin"], tenant: "t" },
		);
		const user = { email: "ana@x.dev", password: "S3nha!forte" };
		expect((await call("/users", user)).status).toBe(201);
		const login = await call("/login", {
			email: user.email,
			password: user.password,
		});
		expect(login.status).toBe(500);
		expect(login.json?.token).toBeUndefined();
	});
});

describe("SEC-24: registered claim names stay the token's own", () => {
	test("SEC-24: a registered name among the claims does not reach the payload", async () => {
		const jwt = jwtOf({ secret });
		const token = await jwt.sign({
			subject: "u1",
			claims: {
				use: "refresh",
				nbf: 1,
				iss: "other",
				aud: "other",
				tenant: "acme",
			},
		});
		const payload = payloadOf(token);
		for (const name of ["use", "nbf", "iss", "aud"]) {
			expect(Object.hasOwn(payload, name)).toBe(false);
		}
		expect(await refused(jwt.verify(token, { use: "refresh" }))).toBe(true);
		expect(await jwt.verify(token)).toEqual({
			subject: "u1",
			scopes: [],
			claims: { tenant: "acme" },
		});
	});

	test("SEC-24: the option token refuses a registered claim name at declaration", () => {
		for (const name of [
			"use",
			"sub",
			"scope",
			"iat",
			"exp",
			"nbf",
			"iss",
			"aud",
		]) {
			expect(() =>
				routesOf({
					secret: { env: "SEC24_SECRET" },
					claims: { [name]: "tenant" },
				}),
			).toThrow(UseCaseUnavailable);
		}
		expect(() =>
			routesOf({
				secret: { env: "SEC24_SECRET" },
				claims: { tenant: "tenant" },
			}),
		).not.toThrow();
	});
});

describe("SEC-25: a signature verifies in its canonical encoding only", () => {
	test("SEC-25: a signature with other unused trailing bits is refused", async () => {
		const alphabet =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		for (const algorithm of ["HS256", "HS384", "HS512"] as const) {
			const jwt = jwtOf({ secret, algorithm });
			const token = await jwt.sign({ subject: "u1" });
			const [head, body, sign] = token.split(".") as [string, string, string];
			expect(await jwt.verify(token)).toMatchObject({ subject: "u1" });
			const last = alphabet.indexOf(sign.at(-1) as string);
			const unused = sign.length % 4 === 3 ? 3 : sign.length % 4 === 2 ? 15 : 0;
			for (let bits = 1; bits <= unused; bits++) {
				const other = `${sign.slice(0, -1)}${alphabet[last ^ bits]}`;
				expect(await refused(jwt.verify(`${head}.${body}.${other}`))).toBe(
					true,
				);
			}
			expect(await refused(jwt.verify(`${head}.${body}.${sign}=`))).toBe(true);
			expect(await refused(jwt.verify(`${head}.${body}.${sign}A`))).toBe(true);
		}
	});
});
