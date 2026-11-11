import { describe, expect, test } from "bun:test";
import type {
	IRepositoryProvider,
	RepositoryContext,
	RepositoryData,
} from "../../adapters";
import { providerDescriptionOf } from "../../experimental";
import {
	blueprintOf,
	entityOf,
	InvalidRepositoryDeclaration,
	inMemoryProvider,
	RepositoryUniqueViolation,
	repositoryOf,
} from "../../index";

class Item extends entityOf(
	blueprintOf((ctx) => ({ name: ctx.string })),
	{ unique: ["name"] },
) {}
const context: RepositoryContext = {
	entity: Item,
	name: "ItemRepository",
	unique: ["id", "name"],
	env: undefined,
};
const ids = (rows: readonly RepositoryData[]) => rows.map((row) => row.id);
const row = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: id,
	...extra,
});

async function seed(provider: IRepositoryProvider, rows: RepositoryData[]) {
	for (const data of rows) await provider.insert(context, data);
}

describe("inMemoryProvider", () => {
	test("is a named provider that advertises transactions", () => {
		const provider = inMemoryProvider();
		expect(providerDescriptionOf(provider)).toEqual({
			kind: "provider",
			name: "inMemory",
			options: {},
		});
		expect(provider.capabilities?.transactions).toBe(true);
	});

	test("keeps the tables of two entities without a name apart", async () => {
		const provider = inMemoryProvider();
		const one = entityOf(blueprintOf((ctx) => ({ title: ctx.string })));
		const two = entityOf(blueprintOf((ctx) => ({ count: ctx.integer })));
		const Ones = repositoryOf({
			entity: one,
			actions: ["create", "findMany"],
			provider,
		});
		const Twos = repositoryOf({
			entity: two,
			actions: ["create", "findMany"],
			provider,
		});
		await Ones.create({ title: "a" });
		await Twos.create({ count: 1 });
		expect((await Ones.findMany()).map((item) => item.title)).toEqual(["a"]);
		expect((await Twos.findMany()).map((item) => item.count)).toEqual([1]);
	});

	test("shares the table of entities that declare the same name", async () => {
		const provider = inMemoryProvider();
		class V1 extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string })),
			{
				name: "Note",
			},
		) {}
		class V2 extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string })),
			{
				name: "Note",
			},
		) {}
		await repositoryOf({ entity: V1, actions: ["create"], provider }).create({
			title: "a",
		});
		const read = repositoryOf({ entity: V2, actions: ["findMany"], provider });
		expect((await read.findMany()).map((item) => item.title)).toEqual(["a"]);
	});

	test("where supports equality and in, ANDed, and an empty in matches nothing", async () => {
		const provider = inMemoryProvider();
		await seed(provider, [
			row("a", { n: 1, group: { x: 1, y: 2 } }),
			row("b", { n: 2, group: { y: 2, x: 1 } }),
			row("c", { n: 2 }),
		]);
		const ofWhere = async (where: Record<string, unknown>) =>
			ids(await provider.findMany(context, { where }));
		expect(await ofWhere({ n: 2 })).toEqual(["b", "c"]);
		expect(
			await ofWhere({ n: { in: [1, 2] }, id: { in: ["a", "c"] } }),
		).toEqual(["a", "c"]);
		expect(await ofWhere({ n: { in: [] } })).toEqual([]);
		expect(await ofWhere({ group: { x: 1, y: 2 } })).toEqual(["a", "b"]);
		expect(await ofWhere({ group: undefined })).toEqual(["c"]);
		expect(
			await provider.findOne(context, { where: { n: 9 } }),
		).toBeUndefined();
	});

	test("orders: missing first asc and last desc, numbers numeric, strings by code point, stable", async () => {
		const provider = inMemoryProvider();
		await seed(provider, [
			row("a", { v: 10 }),
			row("b"),
			row("c", { v: 9 }),
			row("d", { v: 10 }),
		]);
		const order = async (direction?: "asc" | "desc") =>
			ids(
				await provider.findMany(context, {
					orderBy: [{ key: "v", direction }],
				}),
			);
		expect(await order()).toEqual(["b", "c", "a", "d"]);
		expect(await order("desc")).toEqual(["a", "d", "c", "b"]);

		const text = inMemoryProvider();
		await seed(text, [
			row("1", { s: "\u{1F600}" }),
			row("2", { s: "～" }),
			row("3", { s: "b" }),
			row("4", { s: "B" }),
			row("5", { s: "ab" }),
			row("6", { s: "a" }),
		]);
		expect(
			ids(await text.findMany(context, { orderBy: [{ key: "s" }] })),
		).toEqual(["4", "6", "5", "3", "2", "1"]);
	});

	test("orders by several keys, then applies offset and limit", async () => {
		const provider = inMemoryProvider();
		await seed(provider, [
			row("a", { g: 1, n: 1 }),
			row("b", { g: 2, n: 1 }),
			row("c", { g: 1, n: 2 }),
			row("d", { g: 2, n: 2 }),
		]);
		const orderBy = [{ key: "g" }, { key: "n", direction: "desc" as const }];
		expect(ids(await provider.findMany(context, { orderBy }))).toEqual([
			"c",
			"a",
			"d",
			"b",
		]);
		expect(
			ids(await provider.findMany(context, { orderBy, offset: 1, limit: 2 })),
		).toEqual(["a", "d"]);
		expect(await provider.findMany(context, { limit: 0 })).toEqual([]);
		expect(await provider.findOne(context, { limit: 0 })).toBeUndefined();
		expect((await provider.findOne(context, { orderBy, offset: 2 }))?.id).toBe(
			"d",
		);
		expect(await provider.findOne(context, { offset: 10 })).toBeUndefined();
		expect(
			await provider.count(context, { orderBy, offset: 3, limit: 1 }),
		).toBe(4);
	});

	test("hides rows with deletedAt unless withDeleted", async () => {
		const provider = inMemoryProvider();
		await seed(provider, [row("a"), row("b", { deletedAt: "2020-01-01" })]);
		expect(ids(await provider.findMany(context))).toEqual(["a"]);
		expect(
			ids(await provider.findMany(context, { withDeleted: true })),
		).toEqual(["a", "b"]);
		expect(await provider.count(context)).toBe(1);
		expect(await provider.count(context, { withDeleted: true })).toBe(2);
		await expect(
			provider.insert(context, row("c", { name: "b" })),
		).rejects.toBeInstanceOf(RepositoryUniqueViolation);
	});

	test("clones data on write and on read", async () => {
		const provider = inMemoryProvider();
		const data: RepositoryData = row("a", { nested: { list: [1] } });
		await provider.insert(context, data);
		(data.nested as { list: number[] }).list.push(2);
		const read = (await provider.findOne(context)) as RepositoryData;
		expect(read.nested).toEqual({ list: [1] });
		(read.nested as { list: number[] }).list.push(3);
		const [again] = await provider.findMany(context);
		expect(again?.nested).toEqual({ list: [1] });
	});

	describe("transactions", () => {
		test("commit on success and roll back on rejection", async () => {
			const provider = inMemoryProvider();
			await seed(provider, [row("a")]);
			const result = await provider.transaction?.(async (tx) => {
				await tx.insert(context, row("b"));
				expect(ids(await tx.findMany(context))).toEqual(["a", "b"]);
				return "done";
			});
			expect(result).toBe("done");
			expect(ids(await provider.findMany(context))).toEqual(["a", "b"]);

			await expect(
				provider.transaction?.(async (tx) => {
					await tx.insert(context, row("c"));
					await tx.remove(context, "a");
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
			expect(ids(await provider.findMany(context))).toEqual(["a", "b"]);
		});

		test("operations outside wait for the active transaction, and none is lost", async () => {
			const provider = inMemoryProvider();
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const failing = provider
				.transaction?.(async (tx) => {
					await tx.insert(context, row("t"));
					await gate;
					throw new Error("rollback");
				})
				.catch(() => undefined);
			await Promise.resolve();
			const reading = provider.findMany(context);
			const outside = provider.insert(context, row("o"));
			release();
			await failing;
			await outside;
			expect(ids(await reading)).toEqual([]);
			expect(ids(await provider.findMany(context))).toEqual(["o"]);
		});

		test("transactions run one at a time, in order", async () => {
			const provider = inMemoryProvider();
			const log: string[] = [];
			const run = (name: string, ms: number) =>
				provider.transaction?.(async (tx) => {
					log.push(`start ${name}`);
					await new Promise((resolve) => setTimeout(resolve, ms));
					await tx.insert(context, row(name));
					log.push(`end ${name}`);
				});
			await Promise.all([run("a", 15), run("b", 1), run("c", 1)]);
			expect(log).toEqual([
				"start a",
				"end a",
				"start b",
				"end b",
				"start c",
				"end c",
			]);
			expect(ids(await provider.findMany(context))).toEqual(["a", "b", "c"]);
		});

		test("nested transactions are savepoints", async () => {
			const provider = inMemoryProvider();
			await provider.transaction?.(async (outer) => {
				await outer.insert(context, row("a"));
				await outer
					.transaction?.(async (inner) => {
						await inner.insert(context, row("b"));
						throw new Error("inner");
					})
					.catch(() => undefined);
				expect(ids(await outer.findMany(context))).toEqual(["a"]);
				await outer.transaction?.(async (inner) => {
					await inner.insert(context, row("c"));
				});
				expect(ids(await outer.findMany(context))).toEqual(["a", "c"]);
			});
			expect(ids(await provider.findMany(context))).toEqual(["a", "c"]);

			await expect(
				provider.transaction?.(async (outer) => {
					await outer.insert(context, row("d"));
					await outer.transaction?.(async () => {});
					throw new Error("outer");
				}),
			).rejects.toThrow("outer");
			expect(ids(await provider.findMany(context))).toEqual(["a", "c"]);
		});

		test("a scoped provider cannot be used after its callback", async () => {
			const provider = inMemoryProvider();
			let scoped!: IRepositoryProvider;
			await provider.transaction?.(async (tx) => {
				scoped = tx;
			});
			await expect(scoped.insert(context, row("x"))).rejects.toBeInstanceOf(
				InvalidRepositoryDeclaration,
			);
			await expect(scoped.findMany(context)).rejects.toBeInstanceOf(
				InvalidRepositoryDeclaration,
			);
			await expect(scoped.transaction?.(async () => {})).rejects.toBeInstanceOf(
				InvalidRepositoryDeclaration,
			);
			expect(await provider.findMany(context)).toEqual([]);
		});
	});
});
