import { expect, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	entityOf,
	InvalidRepositoryDeclaration,
	type IRepositoryProvider,
	inMemoryProvider,
	repositoryOf,
} from "../../index";

class Item extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string, email: ctx.email })),
	{ unique: ["email"] },
) {}
const actions = [
	"create",
	"delete",
	"count",
	"findById",
	"findByEmail",
	"findManyByName",
] as const;

test("hard is the default and physically removes destroyed entities", async () => {
	const provider = inMemoryProvider();
	const Items = repositoryOf({ entity: Item, actions, provider });
	const item = await Items.create({ name: "a", email: "a@example.com" });
	expect(await Items.delete(item)).toBe(item);
	expect(item.isDeleted).toBe(true);
	expect(await Items.count()).toBe(0);
	await Items.create({ name: "a", email: "a@example.com" });
});

test("soft deletion persists timestamps and hides rows from every read", async () => {
	const provider = inMemoryProvider();
	const Items = repositoryOf({
		entity: Item,
		actions,
		provider,
		deletion: "soft",
	});
	const Raw = repositoryOf({
		entity: Item,
		actions,
		provider,
		deletion: "hard",
	});
	const item = await Items.create({ name: "a", email: "a@example.com" });
	const alive = await Items.create({ name: "a", email: "b@example.com" });
	const deleted = await Items.delete(item.id);
	expect(deleted.isDeleted).toBe(true);
	expect((await Raw.findById(item.id))?.deletedAt).toBe(deleted.deletedAt);
	expect(await Raw.count()).toBe(2);
	expect(await Items.count()).toBe(1);
	expect(await Items.findById(item.id)).toBeUndefined();
	expect(await Items.findByEmail(item.email)).toBeUndefined();
	expect((await Items.findManyByName("a")).map((entry) => entry.id)).toEqual([
		alive.id,
	]);
	await expect(Items.delete(item.id)).rejects.toMatchObject({
		name: "RepositoryEntityNotFound",
	});
	await expect(
		Items.create({ name: "a", email: "a@example.com" }),
	).rejects.toMatchObject({ name: "RepositoryUniqueViolation" });
	await Items.delete(alive);
	expect(alive.isDeleted).toBe(true);
	expect(await Items.count()).toBe(0);
});

test("soft actions require update and findOne, without requiring remove", async () => {
	const memory = inMemoryProvider();
	const provider = {
		...memory,
		remove: undefined,
	} as unknown as IRepositoryProvider;
	const Items = repositoryOf({
		entity: Item,
		actions,
		deletion: "soft",
		provider,
	});
	const item = await Items.create({ name: "a", email: "a@example.com" });
	await Items.delete(item);
	expect(await Items.count()).toBe(0);
	expect(() =>
		repositoryOf({
			entity: Item,
			actions: ["delete"],
			deletion: "soft",
			provider: {
				...memory,
				update: undefined,
			} as unknown as IRepositoryProvider,
		}),
	).toThrow(InvalidRepositoryDeclaration);
	expect(() =>
		repositoryOf({
			entity: Item,
			actions: ["count"],
			deletion: "soft",
			provider: {
				...memory,
				count: undefined,
			} as unknown as IRepositoryProvider,
		}),
	).toThrow(InvalidRepositoryDeclaration);
	expect(() =>
		repositoryOf({ entity: Item, actions, deletion: "invalid" as "soft" }),
	).toThrow(InvalidRepositoryDeclaration);
});

test("soft-deleted references are missing", async () => {
	const memory = inMemoryProvider();
	const provider = memory;
	const Items = repositoryOf({
		entity: Item,
		actions,
		provider,
		deletion: "soft",
	});
	class Holder extends entityOf(blueprintOf(() => ({ item: Item }))) {}
	const Holders = repositoryOf({
		entity: Holder,
		actions: ["create", "findById"],
		relations: [Items],
		provider,
	});
	const item = await Items.create({ name: "a", email: "a@example.com" });
	const holder = await Holders.create({ item });
	expect((await Holders.findById(holder.id))?.item.id).toBe(item.id);
	await Items.delete(item);
	await expect(Holders.findById(holder.id)).rejects.toMatchObject({
		name: "InvalidRepositoryData",
	});
});

test("application binding preserves deletion mode and describes it", async () => {
	const Items = repositoryOf({ entity: Item, actions, deletion: "soft" });
	const App = applicationOf({
		name: "soft",
		entities: { Item },
		repositories: { Items },
		provider: inMemoryProvider(),
	});
	expect(App.describe().repositories.Items?.deletion).toBe("soft");
	const item = await App.repositories.Items.create({
		name: "a",
		email: "a@example.com",
	});
	await App.repositories.Items.delete(item);
	expect(await App.repositories.Items.count()).toBe(0);
	expect(await App.repositories.Items.findById(item.id)).toBeUndefined();
});
