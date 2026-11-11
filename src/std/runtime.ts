import { ExceptionLayers } from "../core/exception/enums/exception-layers";
import { exceptionOf } from "../core/exception/exception";
import { markExported } from "../core/exception/exported";

/** Hashes and checks passwords. `verifySync` is optional. */
export interface PasswordHasher {
	hash(plain: string): Promise<string>;
	verify(plain: string, hash: string): Promise<boolean>;
	verifySync?(plain: string, hash: string): boolean;
}

/** Makes a new id, as a UUID v7 string. */
export type IdGenerator = () => string;

/** The runtime services afora uses; each is replaceable. */
export interface RuntimeServices {
	hasher?: PasswordHasher;
	idGenerator?: IdGenerator;
}

/** No password hasher can run here; call `configure({ hasher })`. */
export const PasswordHasherRequired = exceptionOf({
	layer: ExceptionLayers.Property,
	name: "PasswordHasherRequired",
	message:
		"No password hasher is available: this runtime has neither Bun.password nor native argon2 (node:crypto, Node >= 24.7). Call configure({ hasher }) with your own PasswordHasher.",
});

/** The hasher in use cannot verify without waiting; use `verify` instead. */
export const SyncVerifyUnsupported = exceptionOf({
	layer: ExceptionLayers.Property,
	name: "SyncVerifyUnsupported",
	message:
		"The configured password hasher has no verifySync. Use verify, or configure a hasher that provides verifySync.",
});

/** The hash is argon2id of a version that `node:crypto` cannot derive. */
export const UnsupportedPasswordHash = exceptionOf({
	layer: ExceptionLayers.Property,
	name: "UnsupportedPasswordHash",
	message: ({ version }: { readonly version: number }) =>
		`The password hash uses argon2 version ${version}, but native argon2 (node:crypto) only derives version ${ARGON2_VERSION}. Verify it with Bun.password or configure({ hasher }).`,
});

// The two the package exports count as core exceptions for `useCaseOf({ errors })`.
markExported(PasswordHasherRequired, SyncVerifyUnsupported);

/** The only argon2 version `node:crypto` derives. */
const ARGON2_VERSION = 19;

/** Argon2id settings; the same as Bun's default (m=64 MiB, t=2, p=1). */
const ARGON2_PARAMS = {
	memory: 65536,
	passes: 2,
	parallelism: 1,
	tagLength: 32,
	saltLength: 32,
	version: ARGON2_VERSION,
} as const;

interface Argon2Parameters {
	message: string;
	nonce: Uint8Array;
	parallelism: number;
	tagLength: number;
	memory: number;
	passes: number;
}

/** The parts of `node:crypto` the argon2 hasher needs. */
interface Argon2Crypto {
	argon2: (
		algorithm: string,
		parameters: Argon2Parameters,
		callback: (error: Error | null, key: Uint8Array) => void,
	) => void;
	argon2Sync: (algorithm: string, parameters: Argon2Parameters) => Uint8Array;
	randomBytes(size: number): Uint8Array;
	timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

/** What `defaultHasherOf` inspects; pass your own to test other runtimes. */
export interface HasherEnvironment {
	bun?: { password?: unknown };
	crypto?: Partial<Argon2Crypto>;
}

/** `bytes` as unpadded standard base64. */
export const toBase64 = (bytes: Uint8Array): string =>
	btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replace(
		/=+$/,
		"",
	);

/** The bytes of standard base64 `text`, padded or not. */
export const fromBase64 = (text: string): Uint8Array =>
	Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** Writes an argon2id hash as a PHC string. */
export function encodePhc(salt: Uint8Array, tag: Uint8Array): string {
	const { memory, passes, parallelism, version } = ARGON2_PARAMS;
	return `$argon2id$v=${version}$m=${memory},t=${passes},p=${parallelism}$${toBase64(salt)}$${toBase64(tag)}`;
}

const PHC =
	/^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** An argon2id hash read from a PHC string. */
export interface DecodedPhc {
	readonly version: number;
	readonly memory: number;
	readonly passes: number;
	readonly parallelism: number;
	readonly salt: Uint8Array;
	readonly tag: Uint8Array;
}

/** The settings, salt and tag inside an argon2id PHC string; `undefined` if it is not one. */
export function decodePhc(phc: string): DecodedPhc | undefined {
	const match = PHC.exec(phc);
	if (!match) return undefined;
	return {
		version: Number(match[1]),
		memory: Number(match[2]),
		passes: Number(match[3]),
		parallelism: Number(match[4]),
		salt: fromBase64(match[5] as string),
		tag: fromBase64(match[6] as string),
	};
}

/** An argon2id hasher on top of native `node:crypto`, or `undefined` if it lacks argon2. */
export function nodeHasherOf(
	crypto: Partial<Argon2Crypto>,
): PasswordHasher | undefined {
	const { argon2, argon2Sync, randomBytes, timingSafeEqual } = crypto;
	if (!argon2 || !argon2Sync || !randomBytes || !timingSafeEqual) {
		return undefined;
	}

	const derive = (parameters: Argon2Parameters) =>
		new Promise<Uint8Array>((resolve, reject) => {
			argon2("argon2id", parameters, (error, key) =>
				error ? reject(error) : resolve(key),
			);
		});
	const parametersOf = (
		plain: string,
		parsed: DecodedPhc,
	): Argon2Parameters => ({
		message: plain,
		nonce: parsed.salt,
		parallelism: parsed.parallelism,
		tagLength: parsed.tag.length,
		memory: parsed.memory,
		passes: parsed.passes,
	});
	const decode = (hash: string) => {
		const parsed = decodePhc(hash);
		if (parsed && parsed.version !== ARGON2_VERSION) {
			throw new UnsupportedPasswordHash({
				source: "password",
				details: { version: parsed.version },
			});
		}
		return parsed;
	};
	const matches = (tag: Uint8Array, expected: Uint8Array) =>
		tag.length === expected.length && timingSafeEqual(tag, expected);

	return {
		async hash(plain) {
			const salt = randomBytes(ARGON2_PARAMS.saltLength);
			const tag = await derive({
				message: plain,
				nonce: salt,
				parallelism: ARGON2_PARAMS.parallelism,
				tagLength: ARGON2_PARAMS.tagLength,
				memory: ARGON2_PARAMS.memory,
				passes: ARGON2_PARAMS.passes,
			});
			return encodePhc(salt, tag);
		},
		async verify(plain, hash) {
			const parsed = decode(hash);
			if (!parsed) return false;
			return matches(await derive(parametersOf(plain, parsed)), parsed.tag);
		},
		verifySync(plain, hash) {
			const parsed = decode(hash);
			if (!parsed) return false;
			const tag = argon2Sync("argon2id", parametersOf(plain, parsed));
			return matches(tag, parsed.tag);
		},
	};
}

/** The slice of `Bun.password` afora uses. */
interface BunPassword {
	hash(plain: string, options: { algorithm: "argon2id" }): Promise<string>;
	verify(plain: string, hash: string): Promise<boolean>;
	verifySync(plain: string, hash: string): boolean;
}

/** Wraps `Bun.password` as an argon2id hasher. */
function bunHasherOf(password: BunPassword): PasswordHasher {
	return {
		hash: (plain) => password.hash(plain, { algorithm: "argon2id" }),
		verify: (plain, hash) => password.verify(plain, hash),
		verifySync: (plain, hash) => password.verifySync(plain, hash),
	};
}

/** A hasher that only throws `PasswordHasherRequired`. */
function missingHasher(): PasswordHasher {
	return {
		hash: () =>
			Promise.reject(new PasswordHasherRequired({ source: "password" })),
		verify: () =>
			Promise.reject(new PasswordHasherRequired({ source: "password" })),
		verifySync: () => {
			throw new PasswordHasherRequired({ source: "password" });
		},
	};
}

/**
 * The hasher a runtime gets by default: `Bun.password` on Bun, native
 * argon2 on a Node that has it, otherwise one that throws
 * `PasswordHasherRequired`.
 */
export function defaultHasherOf(
	environment: HasherEnvironment,
): PasswordHasher {
	if (environment.bun?.password) {
		return bunHasherOf(environment.bun.password as BunPassword);
	}
	const node = environment.crypto && nodeHasherOf(environment.crypto);
	return node ?? missingHasher();
}

let lastTimestamp = 0;
let sequence = 0;

/** The two hexadecimal digits of each byte. */
const HEX: readonly string[] = Array.from({ length: 256 }, (_, byte) =>
	byte.toString(16).padStart(2, "0"),
);

/** Random bytes each id takes: two for the start of its sequence, eight for its tail. */
const RANDOM_PER_ID = 10;
/**
 * Random bytes for the next ids, filled by one call of `getRandomValues`
 * every 64 ids instead of one call per id; `randomAt` is where the next id
 * starts, the end of the pool when it has to be filled.
 */
const randomPool = new Uint8Array(RANDOM_PER_ID * 64);
let randomAt = randomPool.length;

/**
 * A UUID v7 (RFC 9562): 48-bit unix milliseconds, version 7, variant 10.
 * Ids made in the same millisecond count up in the 12-bit `rand_a` field,
 * so they sort in creation order.
 */
export function uuidv7(now: number = Date.now()): string {
	if (randomAt === randomPool.length) {
		globalThis.crypto.getRandomValues(randomPool);
		randomAt = 0;
	}
	const at = randomAt;
	randomAt += RANDOM_PER_ID;
	const random = randomPool;
	const start = ((random[at + 8] as number) << 8) | (random[at + 9] as number);

	if (now > lastTimestamp) {
		lastTimestamp = now;
		sequence = start & 0x7ff;
	} else if (sequence < 0xfff) {
		sequence++;
	} else {
		lastTimestamp++;
		sequence = start & 0x7ff;
	}

	// The timestamp is over 32 bits, so its two halves are taken apart by division.
	const high = Math.floor(lastTimestamp / 2 ** 32);
	const low = lastTimestamp % 2 ** 32;
	const hex = (byte: number) => HEX[byte & 0xff] as string;
	return (
		hex(high >>> 8) +
		hex(high) +
		hex(low >>> 24) +
		hex(low >>> 16) +
		"-" +
		hex(low >>> 8) +
		hex(low) +
		"-" +
		hex(0x70 | (sequence >>> 8)) +
		hex(sequence) +
		"-" +
		hex(((random[at] as number) & 0x3f) | 0x80) +
		hex(random[at + 1] as number) +
		"-" +
		hex(random[at + 2] as number) +
		hex(random[at + 3] as number) +
		hex(random[at + 4] as number) +
		hex(random[at + 5] as number) +
		hex(random[at + 6] as number) +
		hex(random[at + 7] as number)
	);
}

let hasher: PasswordHasher | undefined;
let idGenerator: IdGenerator = () => uuidv7();

/** Replaces the password hasher and/or the id generator. */
export function configure(services: RuntimeServices): void {
	if (services.hasher) hasher = services.hasher;
	if (services.idGenerator) idGenerator = services.idGenerator;
}

/** Puts both services back to their defaults and restarts the id clock. */
export function resetRuntime(): void {
	hasher = undefined;
	idGenerator = () => uuidv7();
	lastTimestamp = 0;
	sequence = 0;
}

/**
 * `node:crypto`, loaded now and not at import, so that afora loads where
 * there is none; `undefined` when the runtime cannot give it synchronously.
 */
function nodeCryptoOf(): Partial<Argon2Crypto> | undefined {
	const process = (
		globalThis as {
			process?: {
				getBuiltinModule?: (id: string) => unknown;
			};
		}
	).process;
	return process?.getBuiltinModule?.("node:crypto") as
		| Partial<Argon2Crypto>
		| undefined;
}

/** The hasher in use; the default is chosen on first call, not at import. */
export function currentHasher(): PasswordHasher {
	hasher ??= defaultHasherOf({
		bun: (globalThis as { Bun?: HasherEnvironment["bun"] }).Bun,
		crypto: nodeCryptoOf(),
	});
	return hasher;
}

/** Makes an id with the generator in use. */
export function generateId(): string {
	return idGenerator();
}

/** `verifySync` of the hasher in use, or throws `SyncVerifyUnsupported`. */
export function verifySyncWithCurrent(plain: string, hash: string): boolean {
	const current = currentHasher();
	if (!current.verifySync)
		throw new SyncVerifyUnsupported({ source: "password" });
	return current.verifySync(plain, hash);
}
