import { blueprintOf, listOf, recordOf } from "../../src/index.ts";

export const Address = blueprintOf((ctx) => ({
	street: ctx.string,
	zip: ctx.string,
}));

export const UserBlueprint = blueprintOf((ctx) => ({
	name: ctx.string,
	email: ctx.email,
	slug: ctx.slug,
	addresses: listOf(Address),
}));

export class User extends recordOf(UserBlueprint) {
	get initials(): string {
		return this.name.slice(0, 1).toUpperCase();
	}
}

export const validBody = {
	name: "Jane",
	email: "  Jane@Example.COM ",
	slug: "Olá Mundo",
	addresses: [{ street: "Main St", zip: "1" }],
};

export const invalidBody = {
	name: "Jane",
	email: "not-an-email",
	slug: "Olá Mundo",
	addresses: [{ street: "Main St", zip: 1 }],
};
