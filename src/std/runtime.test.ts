import { afterEach, expect, test } from "bun:test";
import nodeCrypto from "node:crypto";
import { Exception } from "../core/exception/exception";
import { Id } from "./properties/identity";
import { isPasswordHash, Password } from "./properties/password";
import {
	configure,
	currentHasher,
	decodePhc,
	defaultHasherOf,
	encodePhc,
	fromBase64,
	nodeHasherOf,
	type PasswordHasher,
	PasswordHasherRequired,
	resetRuntime,
	SyncVerifyUnsupported,
	toBase64,
	uuidv7,
} from "./runtime";

afterEach(resetRuntime);

const UUID_V7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("uuidv7 has the version and variant bits and the timestamp", () => {
	const before = Date.now();
	const id = uuidv7();
	expect(id).toMatch(UUID_V7);
	const timestamp = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
	expect(timestamp).toBeGreaterThanOrEqual(before);
	expect(timestamp).toBeLessThanOrEqual(Date.now() + 1);
});

test("uuidv7 ids made in a tight loop are unique and sorted", () => {
	const ids = Array.from({ length: 20000 }, () => uuidv7());
	expect(new Set(ids).size).toBe(ids.length);
	expect(ids).toEqual([...ids].sort());
});

test("uuidv7 keeps ordering when the clock goes back", () => {
	const first = uuidv7(Date.now() + 10_000);
	const second = uuidv7(Date.now());
	expect(second > first).toBe(true);
});

test("configure replaces the id generator and resetRuntime restores it", () => {
	const fixed = "01a173d2-051c-77bb-8166-a371e999573e";
	configure({ idGenerator: () => fixed });
	expect(Id.generate().value).toBe(fixed);

	resetRuntime();
	expect(Id.generate().value).not.toBe(fixed);
	expect(Id.generate().value).toMatch(UUID_V7);
});

const FAKE_HASH = "$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA";

test("configure replaces the hasher and resetRuntime restores it", async () => {
	const hasher: PasswordHasher = {
		hash: async () => FAKE_HASH,
		verify: async (plain) => plain === "Str0ng!pass",
	};
	configure({ hasher });
	expect(currentHasher()).toBe(hasher);

	const password = await Password.hash("Str0ng!pass");
	expect(password.value).toBe(FAKE_HASH);
	expect(await password.verify("Str0ng!pass")).toBe(true);
	expect(await password.verify("other")).toBe(false);
	expect(() => password.verifySync("Str0ng!pass")).toThrow(
		SyncVerifyUnsupported,
	);

	resetRuntime();
	expect(currentHasher()).not.toBe(hasher);
});

test("without Bun or native argon2 the hasher throws PasswordHasherRequired", async () => {
	const hasher = defaultHasherOf({ crypto: {} });
	const raised = await hasher.hash("x").catch((error) => error);

	expect(raised).toBeInstanceOf(PasswordHasherRequired);
	expect(raised).toBeInstanceOf(Exception);
	expect(raised.message).toContain("configure({ hasher })");
	expect(hasher.verify("x", "y")).rejects.toBeInstanceOf(
		PasswordHasherRequired,
	);
	expect(() => hasher.verifySync?.("x", "y")).toThrow(PasswordHasherRequired);
});

test("Bun.password is preferred when present", async () => {
	const options: unknown[] = [];
	const hasher = defaultHasherOf({
		bun: {
			password: {
				hash: async (_: string, given: unknown) => {
					options.push(given);
					return "hashed";
				},
				verify: async () => true,
				verifySync: () => true,
			},
		},
		crypto: {},
	});

	expect(await hasher.hash("x")).toBe("hashed");
	expect(options).toEqual([{ algorithm: "argon2id" }]);
	expect(hasher.verifySync?.("x", "y")).toBe(true);
});

test("the PHC helpers round trip", () => {
	const salt = new Uint8Array(32).fill(7);
	const tag = new Uint8Array(32).fill(9);
	const phc = encodePhc(salt, tag);

	expect(phc).toStartWith("$argon2id$v=19$m=65536,t=2,p=1$");
	expect(phc).not.toEndWith("=");
	expect(isPasswordHash(phc)).toBe(true);
	expect(decodePhc(phc)).toEqual({
		version: 19,
		memory: 65536,
		passes: 2,
		parallelism: 1,
		salt,
		tag,
	});
	expect(decodePhc("not a hash")).toBeUndefined();
});

const native = nodeHasherOf(nodeCrypto as never);

test.skipIf(native === undefined)(
	"the node argon2 hasher makes PHC hashes that it and Bun verify",
	async () => {
		const hasher = native as PasswordHasher;
		const hash = await hasher.hash("Str0ng!pass");

		expect(isPasswordHash(hash)).toBe(true);
		expect(await hasher.verify("Str0ng!pass", hash)).toBe(true);
		expect(await hasher.verify("wrong", hash)).toBe(false);
		expect(hasher.verifySync?.("Str0ng!pass", hash)).toBe(true);
		expect(await hasher.verify("x", "garbage")).toBe(false);
		expect(await Bun.password.verify("Str0ng!pass", hash)).toBe(true);
	},
);

test.skipIf(native === undefined)(
	"the node argon2 hasher verifies a hash made by Bun",
	async () => {
		const hash = await Bun.password.hash("Str0ng!pass", {
			algorithm: "argon2id",
		});
		expect(await native?.verify("Str0ng!pass", hash)).toBe(true);
		expect(await native?.verify("wrong", hash)).toBe(false);
	},
);

test("base64 helpers round trip random bytes, unpadded", () => {
	for (const length of [0, 1, 2, 3, 4, 5, 16, 31, 32, 33, 100]) {
		const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
		const text = toBase64(bytes);

		expect(text).not.toContain("=");
		expect(text).toBe(Buffer.from(bytes).toString("base64").replace(/=+$/, ""));
		expect(fromBase64(text)).toEqual(bytes);
	}
});

const SALT = "YO5NNmxyK9+adO95GxWsAaUX4TULmT3IGhTYfpshXl0";
const TAG = "/C89OCh7bhDY2cR2UkgvOV3dPlkghNLhv/DJsdopwMo";
/** Hashes `Password` accepts that the hashers cannot read. */
const UNREADABLE = [
	`$argon2id$v=19$m=99999999999,t=0,p=0$${SALT}$${TAG}`,
	`$argon2id$v=19$m=65536,t=2,p=1$AAAA$${TAG}`,
	`$argon2id$v=19$m=65536,t=2,p=1$${SALT}$AA`,
	`$argon2id$v=16$m=65536,t=2,p=1$${SALT}$${TAG}`,
	`$argon2i$v=19$m=65536,t=2,p=1$${SALT}$${TAG}`,
];
const DEFAULTS = { memory: 65536, passes: 2, parallelism: 1, tagLength: 32 };

test("the node argon2 hasher verifies a hash it cannot read as false, after deriving with the default settings", async () => {
	const derived: Record<string, unknown>[] = [];
	const argon2Sync = (_: string, parameters: Record<string, unknown>) => {
		const { memory, passes, parallelism, tagLength, nonce } = parameters as {
			memory: number;
			passes: number;
			parallelism: number;
			tagLength: number;
			nonce: Uint8Array;
		};
		if (memory > 2 ** 32 - 1 || passes < 1 || parallelism < 1) {
			throw new RangeError("out of range");
		}
		if (nonce.length < 8 || tagLength < 4) throw new RangeError("too short");
		derived.push({ memory, passes, parallelism, tagLength });
		return new Uint8Array(tagLength);
	};
	const hasher = nodeHasherOf({
		argon2: ((
			algorithm: string,
			parameters: Record<string, unknown>,
			callback: (error: Error | null, key: Uint8Array) => void,
		) => callback(null, argon2Sync(algorithm, parameters))) as never,
		argon2Sync: argon2Sync as never,
		randomBytes: () => new Uint8Array(32),
		timingSafeEqual: () => true,
	}) as PasswordHasher;

	for (const hash of UNREADABLE) {
		expect(isPasswordHash(hash)).toBe(true);
		derived.length = 0;
		expect(await hasher.verify("x", hash)).toBe(false);
		expect(derived).toEqual([DEFAULTS]);
		derived.length = 0;
		expect(hasher.verifySync?.("x", hash)).toBe(false);
		expect(derived).toEqual([DEFAULTS]);
	}
});

test.skipIf(native === undefined)(
	"the native node argon2 hasher verifies a hash it cannot read as false",
	async () => {
		for (const hash of UNREADABLE) {
			expect(await native?.verify("x", hash)).toBe(false);
			expect(native?.verifySync?.("x", hash)).toBe(false);
		}
	},
);

test("the Bun hasher verifies a hash it cannot read as false, after verifying one with the default settings", async () => {
	const verified: string[] = [];
	const check = (hash: string) => {
		verified.push(hash);
		if (UNREADABLE.includes(hash)) throw new Error("InvalidEncoding");
		return false;
	};
	const hasher = defaultHasherOf({
		bun: {
			password: {
				hash: async () => "hashed",
				verify: async (_: string, hash: string) => check(hash),
				verifySync: (_: string, hash: string) => check(hash),
			},
		},
	});
	const unreadable = UNREADABLE.slice(0, 3);
	for (const hash of unreadable) {
		verified.length = 0;
		expect(await hasher.verify("x", hash)).toBe(false);
		expect(verified).toHaveLength(2);
		expect(decodePhc(verified[1] as string)).toMatchObject({
			version: 19,
			memory: 65536,
			passes: 2,
			parallelism: 1,
		});
		verified.length = 0;
		expect(hasher.verifySync?.("x", hash)).toBe(false);
		expect(verified).toHaveLength(2);
	}
	for (const hash of UNREADABLE) {
		expect(await Bun.password.verify("x", hash).catch(() => "throws")).not.toBe(
			true,
		);
		expect(await defaultHasherOf({ bun: Bun }).verify("x", hash)).toBe(false);
	}
});

test("importing the package does not import node:crypto", async () => {
	const result = await Bun.build({
		entrypoints: [new URL("../index.ts", import.meta.url).pathname],
		target: "node",
		format: "esm",
		packages: "external",
	});
	const [output] = result.outputs;
	const code = await (output as { text(): Promise<string> }).text();

	expect(result.success).toBe(true);
	expect(code).not.toMatch(/^\s*import\b[^;\n]*["']node:crypto["']/m);
	expect(code).not.toMatch(/\bBuffer\b/);
});
