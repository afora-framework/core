import { Password } from "@afora/core";

/** Hashes the plain password with argon2id; the entity stores the hash. */
export async function hashPassword(plain: string): Promise<string> {
	const hash = await Password.hash(plain);
	return hash.value as string;
}
