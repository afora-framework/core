import { Password } from "@afora/core";

export async function hashPassword(plain: string) {
	return (await Password.hash(plain)).value;
}
