import { Type } from "typebox";
import { InvalidPropertyValue } from "../../core/property/exceptions";
import { type IPropertyInput, PropertyInput } from "../../core/property/input";
import { propertyOf } from "../../core/property/property";
import { currentHasher, verifySyncWithCurrent } from "../runtime";

const PASSWORD_MIN_LENGTH = 7;
export const PASSWORD_MAX_LENGTH = 128;
const PASSWORD_SPECIAL_CHARACTERS = "!@#$%^&*()-_=+[]{}|\\;:'\",.<>/?`~";

const ARGON2_HASH =
	"^\\$argon2(id|i|d)\\$v=\\d+\\$m=\\d+,t=\\d+,p=\\d+\\$[A-Za-z0-9+/]+\\$[A-Za-z0-9+/]+$";

/** The argon2id hash of `Demo@123`. */
const DEMO_HASH =
	"$argon2id$v=19$m=65536,t=2,p=1$YO5NNmxyK9+adO95GxWsAaUX4TULmT3IGhTYfpshXl0$/C89OCh7bhDY2cR2UkgvOV3dPlkghNLhv/DJsdopwMo";

export function isPasswordHash(value: string): boolean {
	return new RegExp(ARGON2_HASH).test(value);
}

/** The rules a plain password breaks; empty when it is strong enough. */
export function passwordIssues(value: string): string[] {
	const issues: string[] = [];

	if (value.length < PASSWORD_MIN_LENGTH) {
		issues.push(`must have at least ${PASSWORD_MIN_LENGTH} characters`);
	}
	if (value.length > PASSWORD_MAX_LENGTH) {
		issues.push(`must have at most ${PASSWORD_MAX_LENGTH} characters`);
	}
	if (!/[a-z]/.test(value)) issues.push("must contain a lowercase letter");
	if (!/[A-Z]/.test(value)) issues.push("must contain an uppercase letter");
	if (!/\d/.test(value)) issues.push("must contain a number");
	if (![...value].some((char) => PASSWORD_SPECIAL_CHARACTERS.includes(char))) {
		issues.push(
			`must contain a special character (${PASSWORD_SPECIAL_CHARACTERS})`,
		);
	}

	return issues;
}

const escaped = PASSWORD_SPECIAL_CHARACTERS.replace(/[\\\]^-]/g, "\\$&");

/**
 * A password as a person types it, checked against the password rules
 * (`passwordIssues`); sensitive. It is what an input takes for a `Password`,
 * which stores the hash.
 */
export class PlainPassword extends propertyOf({
	name: "plainPassword",
	schema: Type.String({
		minLength: PASSWORD_MIN_LENGTH,
		maxLength: PASSWORD_MAX_LENGTH,
		pattern: `^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[${escaped}])`,
	}),
	default: "Demo@123",
	sensitive: true,
}) {}

/**
 * A password stored as an Argon2 hash. The constructor only accepts a hash,
 * e.g. one read from the database; `Password.hash` turns a plain password
 * into one. Under `PropertyInput` it says so to what derives inputs: they
 * take a `PlainPassword` and hash it.
 */
export class Password extends propertyOf({
	name: "password",
	schema: Type.String({ pattern: ARGON2_HASH }),
	default: DEMO_HASH,
	sensitive: true,
}) {
	static readonly [PropertyInput]: IPropertyInput<string> = {
		accepts: PlainPassword,
		convert: async (plain) => (await Password.hash(plain)).value as string,
	};

	/** Validates `plain` against the password rules and hashes it with the configured hasher (argon2id by default). */
	static async hash(plain: string): Promise<Password> {
		const issues = passwordIssues(plain);
		if (issues.length > 0) {
			throw new InvalidPropertyValue({
				source: "password",
				details: { errors: issues },
			});
		}

		return new Password(await currentHasher().hash(plain));
	}

	/** Whether `input` is the password this hash was made from. */
	verify(input: string): Promise<boolean> {
		const hash: string | undefined = this.value;
		if (hash === undefined) return Promise.resolve(false);
		return currentHasher().verify(input, hash);
	}

	/** Like `verify`, but needs a hasher with `verifySync`. */
	verifySync(input: string): boolean {
		const hash: string | undefined = this.value;
		if (hash === undefined) return false;
		return verifySyncWithCurrent(input, hash);
	}
}
