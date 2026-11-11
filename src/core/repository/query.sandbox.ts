import type {
	RepositoryExists,
	RepositoryFindMany,
	RepositoryFindPage,
} from "../../experimental";
import {
	blueprintOf, entityOf, type RepositoryQuery, type ProviderOptions,
} from "../../index";

class User extends entityOf(blueprintOf((ctx) => ({ name: ctx.string, age: ctx.integer }))) {}
const query = { where: { age: { in: [18, 21] } }, orderBy: [{ key: "name", direction: "asc" }], limit: 10 } satisfies RepositoryQuery<typeof User>;

async function inference(repo: RepositoryFindMany<typeof User> & RepositoryExists<typeof User> & RepositoryFindPage<typeof User>) {
	const users: User[] = await repo.findMany(query);
	const exists: boolean = await repo.exists({ where: { name: "Ana" } });
	const page = await repo.findPage(query);
	const items: readonly User[] = page.items;
	// @ts-expect-error unknown key
	await repo.findMany({ where: { missing: 1 } });
	// @ts-expect-error age must be a number
	await repo.findMany({ where: { age: { in: ["18"] } } });
	// @ts-expect-error ordering is restricted to entity keys
	await repo.findMany({ orderBy: [{ key: "missing" }] });
	return { users, exists, items };
}

const providerOptions = { db: { import: "./db.ts#db" }, tables: ["users"] } satisfies ProviderOptions;
void inference;
void providerOptions;
