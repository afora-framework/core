import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";
import {
	blueprintOf,
	ExceptionLayers,
	exceptionOf,
	guard,
	listOf,
	Password,
	recordOf,
	type StandardSchemaV1,
} from "../../src/index.ts";

// Domain: a record with invariants, a sensitive key and unique intent
const Address = blueprintOf((ctx) => ({ street: ctx.string, zip: ctx.string }));

const UserBlueprint = blueprintOf((ctx) => ({
	email: ctx.email, // trimmed and lowercased
	slug: ctx.slug, // slugified; unique by declaration
	password: ctx.password, // only an argon2 hash is accepted; always masked
	address: Address,
	tags: listOf(ctx.string, { maxItems: 5 }),
}));

export class User extends recordOf(UserBlueprint, {
	unique: ["email"], // `slug` is unique already, as a Slug
	change: ["password"], // generates change.password(value)
}) {}

// Input: the HTTP body carries a plain password, which never enters the record
const SignUpBody = blueprintOf((ctx) => ({
	email: ctx.email,
	slug: ctx.slug,
	plainPassword: ctx.string,
	address: Address,
	tags: listOf(ctx.string, { maxItems: 5 }),
}));

// Repository: enforces what User.options.unique declares
const UserAlreadyExists = exceptionOf({
	layer: ExceptionLayers.Repository,
	name: "UserAlreadyExists",
	message: "A user with this email or slug already exists.",
});

class UserRepository {
	readonly #users: User[] = [];

	save(user: User): User {
		for (const key of User.options.unique) {
			if (this.#users.some((saved) => saved[key] === user[key])) {
				throw new UserAlreadyExists({ source: "UserRepository" });
			}
		}
		this.#users.push(user);
		return user;
	}
}

// Use case and HTTP route
const users = new UserRepository();

async function signUp({ plainPassword, ...data }: SignUpData) {
	const password = await Password.hash(plainPassword);
	return users.save(new User({ ...data, password: password.value }));
}

export const app = new Hono().post(
	"/users",
	sValidator("json", SignUpBody), // any Standard Schema consumer works the same
	async (c) => {
		const user = await signUp(c.req.valid("json"));
		return c.json(user.toJSON(), 201); // the password comes out masked
	},
);

// Errors keep the layers they crossed
export function changePassword(user: User, value: string) {
	return guard(
		{ layer: ExceptionLayers.Output, source: "PATCH /password" },
		() =>
			guard({ layer: ExceptionLayers.UseCase, source: "ChangePassword" }, () =>
				user.change.password(value),
			),
	);
}

type SignUpData = StandardSchemaV1.InferOutput<typeof SignUpBody>;
