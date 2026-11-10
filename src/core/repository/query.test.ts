import { describe, expect, test } from "bun:test";
import type { IRepositoryProvider } from "../../adapters";
import {
	blueprintOf,
	entityOf,
	InvalidRepositoryQuery,
	inMemoryProvider,
	type RepositoryQuery,
	recordOf,
	repositoryOf,
} from "../../index";

class Address extends recordOf(
	blueprintOf((ctx) => ({ city: ctx.string, zip: ctx.string })),
) {}
class Person extends entityOf(
	blueprintOf((ctx) => ({
		name: ctx.string,
		age: ctx.integer,
		address: Address,
	})),
) {}
const ALL = [
	"create",
	"update",
	"delete",
	"count",
	"findById",
	"findMany",
	"exists",
	"findPage",
	"findManyByName",
] as const;

const input = (name: string, age: number, city = "Rio") => ({
	name,
	age,
	address: { city, zip: "1" },
});

function spied(provider = inMemoryProvider()) {
	const queries: unknown[] = [];
	const spy: IRepositoryProvider = {
		...provider,
		async findOne(context, query) {
			queries.push(query);
			return provider.findOne(context, query);
		},
		async findMany(context, query) {
			queries.push(query);
			return provider.findMany(context, query);
		},
		async count(context, query) {
			queries.push(query);
			return provider.count(context, query);
		},
	};
	return { spy, queries };
}

describe("repository queries", () => {
	test("findMany filters, orders, paginates and findPage counts without pagination", async () => {
		const People = repositoryOf({ entity: Person, actions: ALL });
		for (const [name, age] of [
			["Cid", 30],
			["Ana", 20],
			["Bia", 20],
			["Dan", 40],
		] as const) {
			await People.create(input(name, age));
		}
		const names = (list: readonly { name: string }[]) =>
			list.map((person) => person.name);
		expect(
			names(
				await People.findMany({
					where: { age: { in: [20, 30] } },
					orderBy: [{ key: "age", direction: "desc" }, { key: "name" }],
				}),
			),
		).toEqual(["Cid", "Ana", "Bia"]);
		expect(
			names(
				await People.findMany({
					orderBy: [{ key: "name" }],
					offset: 1,
					limit: 2,
				}),
			),
		).toEqual(["Bia", "Cid"]);
		expect(await People.findMany({ where: { age: { in: [] } } })).toEqual([]);
		expect(await People.exists({ where: { name: "Ana" } })).toBe(true);
		expect(await People.exists({ where: { name: "Zed" } })).toBe(false);
		expect(await People.exists({ offset: 4 })).toBe(false);
		expect(await People.exists({ limit: 0 })).toBe(false);
		expect(await People.count({ where: { age: 20 }, limit: 1 })).toBe(2);

		const page = await People.findPage({
			orderBy: [{ key: "name" }],
			limit: 3,
			offset: 1,
		});
		expect(names(page.items)).toEqual(["Bia", "Cid", "Dan"]);
		expect(page).toMatchObject({ total: 4, limit: 3, offset: 1 });
		const first = await People.findPage();
		expect(first).toMatchObject({ total: 4, limit: 20, offset: 0 });
		expect(first.items).toHaveLength(4);
	});

	test("rejects invalid queries as InvalidRepositoryQuery before calling the provider", async () => {
		const { spy, queries } = spied();
		const People = repositoryOf({
			entity: Person,
			actions: ALL,
			provider: spy,
		});
		const bad: unknown[] = [
			{ where: { missing: 1 } },
			{ orderBy: [{ key: "missing" }] },
			{ orderBy: [{ key: "name", direction: "up" }] },
			{ orderBy: [{ key: "address" }] },
			{ orderBy: "name" },
			{ limit: -1 },
			{ limit: 1.5 },
			{ offset: Number.NaN },
			{ limit: Number.POSITIVE_INFINITY },
			{ limit: "2" },
			{ withDeleted: "yes" },
			{ group: "name" },
			{ where: "name" },
			[],
			"name",
		];
		for (const query of bad) {
			for (const method of [
				"findMany",
				"exists",
				"findPage",
				"count",
			] as const) {
				const error = await (
					People[method] as (query: unknown) => Promise<unknown>
				)(query).then(
					() => undefined,
					(error: unknown) => error,
				);
				expect(error).toBeInstanceOf(Error);
				expect(
					(error as { is(target: unknown): boolean }).is(
						InvalidRepositoryQuery,
					),
				).toBe(true);
			}
		}
		expect(queries).toEqual([]);
	});

	test("normalizes records to plain data and entities to ids", async () => {
		const { spy, queries } = spied();
		const People = repositoryOf({
			entity: Person,
			actions: ALL,
			provider: spy,
		});
		const ana = await People.create(input("Ana", 20, "Rio"));
		await People.create(input("Bia", 30, "Sao Paulo"));
		const found = await People.findMany({
			where: { address: new Address({ city: "Rio", zip: "1" }) },
		});
		expect(found.map((person) => person.id)).toEqual([ana.id]);
		expect(queries.at(-1)).toMatchObject({
			where: { address: { city: "Rio", zip: "1" } },
		});
	});

	test("withDeleted defaults to true for hard and false for soft deletion", async () => {
		for (const deletion of ["hard", "soft"] as const) {
			const { spy, queries } = spied();
			const People = repositoryOf({
				entity: Person,
				actions: ALL,
				provider: spy,
				deletion,
			});
			const ana = await People.create(input("Ana", 20));
			await People.create(input("Bia", 30));
			await People.delete(ana);
			queries.length = 0;
			expect(await People.count()).toBe(1);
			expect(queries[0]).toMatchObject({ withDeleted: deletion === "hard" });
			expect(await People.count({ withDeleted: true })).toBe(
				deletion === "soft" ? 2 : 1,
			);
			expect(await People.findMany({ withDeleted: true })).toHaveLength(
				deletion === "soft" ? 2 : 1,
			);
			expect(await People.findById(ana.id)).toBeUndefined();
		}
	});
});

describe("query types", () => {
	test("a bare query takes string keys and unknown values; a typed one restricts them", () => {
		const bare: RepositoryQuery = {
			where: { id: "x", age: { in: [1, "2"] } },
			orderBy: [{ key: "anything", direction: "desc" }],
			limit: 1,
		};
		expect(bare.limit).toBe(1);
		const typed: RepositoryQuery<typeof Person> = {
			where: { age: { in: [1, 2] } },
			orderBy: [{ key: "name" }],
		};
		expect(typed.where).toBeDefined();
		const unknownKey = { where: { missing: 1 } };
		// @ts-expect-error unknown key
		const _a: RepositoryQuery<typeof Person> = unknownKey;
		const wrongValue = { where: { age: "1" } };
		// @ts-expect-error age is a number
		const _b: RepositoryQuery<typeof Person> = wrongValue;
		const wrongOrder = { orderBy: [{ key: "missing" }] };
		// @ts-expect-error unknown order key
		const _c: RepositoryQuery<typeof Person> = wrongOrder;
		void [_a, _b, _c];
	});
});
