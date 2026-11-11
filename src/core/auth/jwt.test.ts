import { describe, expect, test } from "bun:test";
import { InvalidJwtOptions, jwtOf } from "../../experimental";
import { Unauthenticated } from "../../index";

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
const b64 = (value: unknown) =>
	btoa(JSON.stringify(value))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");

describe("jwtOf", () => {
	test("signs and verifies the caller", async () => {
		const jwt = jwtOf({ secret, issuer: "blog", audience: "api" });
		const token = await jwt.sign({
			subject: "u1",
			scopes: ["posts:read", "posts:write"],
			claims: { tenant: "acme", level: 3 },
		});
		expect(token.split(".")).toHaveLength(3);
		expect(payloadOf(token)).toMatchObject({
			sub: "u1",
			scope: "posts:read posts:write",
			iss: "blog",
			aud: "api",
			tenant: "acme",
		});
		expect(payloadOf(token).exp - payloadOf(token).iat).toBe(900);
		expect(await jwt.verify(token)).toEqual({
			subject: "u1",
			scopes: ["posts:read", "posts:write"],
			claims: { tenant: "acme", level: 3 },
		});
		expect(await jwt.verify(await jwt.sign({ subject: "u2" }))).toEqual({
			subject: "u2",
			scopes: [],
		});
	});

	test("a claim cannot replace what the token is signed for", async () => {
		const jwt = jwtOf({ secret });
		const token = await jwt.sign({
			subject: "u1",
			claims: { sub: "admin", exp: 0, scope: "all" },
		});
		expect(await jwt.verify(token)).toEqual({ subject: "u1", scopes: [] });
	});

	test("refuses a token it did not sign", async () => {
		const jwt = jwtOf({ secret });
		const token = await jwt.sign({ subject: "u1" });
		const [head, body, sign] = token.split(".") as [string, string, string];
		const forged = b64({ ...payloadOf(token), sub: "admin" });
		for (const bad of [
			"",
			"abc",
			"a.b.c",
			`${head}.${forged}.${sign}`,
			`${head}.${body}.${sign.slice(0, -2)}xx`,
			`${head}.${body}`,
			`${b64({ alg: "none", typ: "JWT" })}.${body}.`,
			`${b64({ alg: "HS512", typ: "JWT" })}.${body}.${sign}`,
			await jwtOf({ secret: `${secret}!` }).sign({ subject: "u1" }),
		]) {
			expect(await refused(jwt.verify(bad))).toBe(true);
		}
		expect(await refused(jwt.verify(1 as never))).toBe(true);
	});

	test("refuses an expired token, and another issuer, audience or use", async () => {
		const jwt = jwtOf({ secret, issuer: "blog", audience: "api" });
		const expired = await jwt.sign({ subject: "u1" }, { expiresIn: -1 });
		expect(await refused(jwt.verify(expired))).toBe(true);
		const other = await jwtOf({ secret, issuer: "shop", audience: "api" }).sign(
			{
				subject: "u1",
			},
		);
		expect(await refused(jwt.verify(other))).toBe(true);
		const audience = await jwtOf({ secret, issuer: "blog" }).sign({
			subject: "u1",
		});
		expect(await refused(jwt.verify(audience))).toBe(true);
		const refresh = await jwt.sign({ subject: "u1" }, { use: "refresh" });
		expect(await refused(jwt.verify(refresh))).toBe(true);
		expect((await jwt.verify(refresh, { use: "refresh" })).subject).toBe("u1");
		const access = await jwt.sign({ subject: "u1" });
		expect(await refused(jwt.verify(access, { use: "refresh" }))).toBe(true);
	});

	test("the other algorithms verify their own tokens", async () => {
		for (const algorithm of ["HS384", "HS512"] as const) {
			const jwt = jwtOf({ secret, algorithm });
			const token = await jwt.sign({ subject: "u1" });
			expect((await jwt.verify(token)).subject).toBe("u1");
			expect(await refused(jwtOf({ secret }).verify(token))).toBe(true);
		}
	});

	test("the secret may come from the environment, read on the first token", async () => {
		const jwt = jwtOf({ secret: { env: "AFORA_TEST_JWT" } });
		expect(jwt.sign({ subject: "u1" })).rejects.toThrow(InvalidJwtOptions);
		process.env.AFORA_TEST_JWT = "short";
		expect(jwt.sign({ subject: "u1" })).rejects.toThrow(InvalidJwtOptions);
		process.env.AFORA_TEST_JWT = secret;
		try {
			const token = await jwt.sign({ subject: "u1" });
			expect((await jwtOf({ secret }).verify(token)).subject).toBe("u1");
		} finally {
			delete process.env.AFORA_TEST_JWT;
		}
	});

	test("rejects options it cannot use", () => {
		for (const options of [
			undefined,
			{},
			{ secret: "short" },
			{ secret: { env: "" } },
			{ secret: { name: "X" } },
			{ secret, expiresIn: 0 },
			{ secret, expiresIn: 1.5 },
			{ secret, algorithm: "RS256" },
			{ secret, issuer: "" },
			{ secret, other: true },
		]) {
			expect(() => jwtOf(options as never)).toThrow(InvalidJwtOptions);
		}
	});

	test("the authenticator reads the header, then the cookie", async () => {
		const jwt = jwtOf({ secret });
		const token = await jwt.sign({ subject: "u1" });
		const request = (headers: Record<string, string>, cookies = {}) => ({
			header: (name: string) => headers[name],
			cookie: (name: string) => (cookies as Record<string, string>)[name],
			operation: {} as never,
		});
		const bearer = jwt.authenticator();
		expect(await bearer(request({}))).toBeNull();
		expect(await bearer(request({ authorization: `Bearer ${token}` }))).toEqual(
			{
				subject: "u1",
				scopes: [],
			},
		);
		expect(await bearer(request({}, { sid: token }))).toBeNull();
		expect(
			await refused(
				Promise.resolve(bearer(request({ authorization: "Bearer nope" }))),
			),
		).toBe(true);
		const session = jwt.authenticator({ cookie: "sid", header: "X-Token" });
		expect((await session(request({}, { sid: token })))?.subject).toBe("u1");
		expect((await session(request({ "x-token": token })))?.subject).toBe("u1");
	});
});
