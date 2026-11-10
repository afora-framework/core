import {
	blueprintOf,
	entityOf,
	type IRepositoryProvider,
	type ProviderQuery,
	type RepositoryContext,
	type RepositoryData,
	RepositoryEntityNotFound,
	type RepositoryQuery,
	RepositoryUniqueViolation,
} from "../index";

/** The parts of a test runner the kit uses; `bun:test`, vitest and jest fit. */
export interface ContractRunner {
	describe(name: string, body: () => void): void;
	it(name: string, body: () => unknown): void;
	expect(value: unknown): {
		toBe(expected: unknown): unknown;
		toEqual(expected: unknown): unknown;
	};
}

export interface ProviderContractOptions {
	/**
	 * Run the transaction cases. Defaults to `provider.capabilities?.transactions`.
	 */
	readonly transactions?: boolean;
	/**
	 * Run the cases of `after`, which `findCursor` gives to `findMany`. Defaults
	 * to `provider.capabilities?.keyset`.
	 */
	readonly keyset?: boolean;
	/**
	 * Run the cases of declared indexes (`context.indexes`, `query.index`).
	 * Defaults to `provider.capabilities?.indexes`.
	 */
	readonly indexes?: boolean;
}

type Row = Record<string, unknown>;

/** A fresh entity class (providers may key tables by it) and its context. */
function contextOf(name = "Accounts"): RepositoryContext {
	class Account extends entityOf(
		blueprintOf((ctx) => ({ email: ctx.string, name: ctx.string })),
	) {}
	return {
		entity: Account,
		name,
		unique: ["id", "email"],
		env: {},
	} as unknown as RepositoryContext;
}

let sequence = 0;
function row(overrides: Row = {}): Row {
	sequence += 1;
	const id = `id-${String(sequence).padStart(4, "0")}`;
	return { id, email: `${id}@example.com`, name: id, ...overrides };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	return undefined;
}

const ids = (rows: readonly RepositoryData[]) => rows.map((r) => r.id);

/**
 * Registers the behavior every `IRepositoryProvider` v2 must have. Pass the
 * `describe`, `it` and `expect` of your runner and a factory of fresh, empty
 * providers (called once per case).
 */
export function providerContract(
	runner: ContractRunner,
	makeProvider: () => IRepositoryProvider | Promise<IRepositoryProvider>,
	options: ProviderContractOptions = {},
): void {
	const { describe, it, expect } = runner;

	async function fixture() {
		const provider = await makeProvider();
		const context = contextOf();
		const seed = async (...rows: Row[]) => {
			for (const data of rows) await provider.insert(context, data);
		};
		return { provider, context, seed };
	}

	describe("provider contract", () => {
		describe("writes and reads", () => {
			it("inserts and finds by id, empty provider counts zero", async () => {
				const { provider, context } = await fixture();
				expect(await provider.count(context)).toBe(0);
				expect(await provider.findOne(context)).toBe(undefined);
				expect(await provider.findMany(context)).toEqual([]);
				const data = row({ age: 30 });
				await provider.insert(context, data);
				expect(await provider.count(context)).toBe(1);
				expect(
					await provider.findOne(context, { where: { id: data.id } }),
				).toEqual(data);
				expect(await provider.findMany(context)).toEqual([data]);
			});

			it("findOne is undefined when nothing matches", async () => {
				const { provider, context, seed } = await fixture();
				await seed(row());
				expect(
					await provider.findOne(context, { where: { id: "missing" } }),
				).toBe(undefined);
				expect(
					await provider.findMany(context, { where: { id: "missing" } }),
				).toEqual([]);
			});

			it("update replaces the stored value", async () => {
				const { provider, context, seed } = await fixture();
				const data = row({ name: "Ana" });
				await seed(data);
				await provider.update(context, { ...data, name: "Bia" });
				expect(
					await provider.findOne(context, { where: { id: data.id } }),
				).toEqual({ ...data, name: "Bia" });
				expect(await provider.count(context)).toBe(1);
			});

			it("remove deletes the row", async () => {
				const { provider, context, seed } = await fixture();
				const [a, b] = [row(), row()];
				await seed(a, b);
				await provider.remove(context, a.id as string);
				expect(ids(await provider.findMany(context))).toEqual([b.id]);
				expect(await provider.count(context)).toBe(1);
			});

			it("update and remove of an unknown id throw RepositoryEntityNotFound", async () => {
				const { provider, context, seed } = await fixture();
				await seed(row());
				const updated = await failure(provider.update(context, row()));
				expect(updated instanceof RepositoryEntityNotFound).toBe(true);
				const removed = await failure(provider.remove(context, "missing"));
				expect(removed instanceof RepositoryEntityNotFound).toBe(true);
				expect(await provider.count(context)).toBe(1);
			});

			it("keeps tables of different contexts apart", async () => {
				const provider = await makeProvider();
				const [one, two] = [contextOf("One"), contextOf("Two")];
				await provider.insert(one, row());
				expect(await provider.count(one)).toBe(1);
				expect(await provider.count(two)).toBe(0);
			});
		});

		describe("unique keys", () => {
			it("insert throws RepositoryUniqueViolation for a repeated id", async () => {
				const { provider, context, seed } = await fixture();
				const data = row();
				await seed(data);
				const error = await failure(
					provider.insert(context, { ...row(), id: data.id }),
				);
				expect(error instanceof RepositoryUniqueViolation).toBe(true);
				expect((error as { details: { key: string } }).details.key).toBe("id");
				expect(await provider.count(context)).toBe(1);
			});

			it("insert throws for a repeated unique key", async () => {
				const { provider, context, seed } = await fixture();
				await seed(row({ email: "a@example.com" }));
				const error = await failure(
					provider.insert(context, row({ email: "a@example.com" })),
				);
				expect(error instanceof RepositoryUniqueViolation).toBe(true);
				expect((error as { details: { key: string } }).details.key).toBe(
					"email",
				);
				expect(await provider.count(context)).toBe(1);
			});

			it("update throws when taking the unique value of another row", async () => {
				const { provider, context, seed } = await fixture();
				const [a, b] = [row({ email: "a@example.com" }), row()];
				await seed(a, b);
				const error = await failure(
					provider.update(context, { ...b, email: "a@example.com" }),
				);
				expect(error instanceof RepositoryUniqueViolation).toBe(true);
				expect((error as { details: { key: string } }).details.key).toBe(
					"email",
				);
				expect(
					await provider.findOne(context, { where: { id: b.id } }),
				).toEqual(b);
			});

			it("update may keep the unique values of its own row", async () => {
				const { provider, context, seed } = await fixture();
				const data = row({ email: "a@example.com" });
				await seed(data);
				await provider.update(context, { ...data, name: "Other" });
				expect(
					await provider.findOne(context, { where: { id: data.id } }),
				).toEqual({ ...data, name: "Other" });
			});

			it("update clears a value that is left out", async () => {
				const { provider, context, seed } = await fixture();
				const data = row({ deletedAt: "2024-01-01T00:00:00.000Z" });
				await seed(data);
				const { deletedAt: _deletedAt, ...alive } = data;
				await provider.update(context, alive);
				expect(
					await provider.findOne(context, { where: { id: data.id } }),
				).toEqual(alive);
			});

			it("soft-deleted rows keep occupying unique values", async () => {
				const { provider, context, seed } = await fixture();
				await seed(
					row({
						email: "a@example.com",
						deletedAt: "2024-01-01T00:00:00.000Z",
					}),
				);
				const inserted = await failure(
					provider.insert(context, row({ email: "a@example.com" })),
				);
				expect(inserted instanceof RepositoryUniqueViolation).toBe(true);
				const other = row();
				await seed(other);
				const updated = await failure(
					provider.update(context, { ...other, email: "a@example.com" }),
				);
				expect(updated instanceof RepositoryUniqueViolation).toBe(true);
			});
		});

		describe("where", () => {
			it("matches scalars by equality", async () => {
				const { provider, context, seed } = await fixture();
				const [a, b, c] = [
					row({ age: 20, name: "Ana", active: true }),
					row({ age: 30, name: "Bia", active: false }),
					row({ age: 30, name: "Cy", active: true }),
				];
				await seed(a, b, c);
				const find = (where: Row) => provider.findMany(context, { where });
				expect(ids(await find({ age: 30 }))).toEqual([b.id, c.id]);
				expect(ids(await find({ name: "Ana" }))).toEqual([a.id]);
				expect(ids(await find({ active: false }))).toEqual([b.id]);
				expect(ids(await find({ age: 31 }))).toEqual([]);
				expect(ids(await find({}))).toEqual([a.id, b.id, c.id]);
			});

			it("matches structured values by structure", async () => {
				const { provider, context, seed } = await fixture();
				const [a, b] = [
					row({ address: { city: "Rio", zip: "1" }, tags: ["x", "y"] }),
					row({ address: { city: "Rio", zip: "2" }, tags: ["y", "x"] }),
				];
				await seed(a, b);
				const find = (where: Row) => provider.findMany(context, { where });
				expect(ids(await find({ address: { city: "Rio", zip: "1" } }))).toEqual(
					[a.id],
				);
				expect(ids(await find({ address: { city: "Rio" } }))).toEqual([]);
				expect(ids(await find({ tags: ["y", "x"] }))).toEqual([b.id]);
				expect(ids(await find({ tags: ["x"] }))).toEqual([]);
			});

			it("matches membership with in", async () => {
				const { provider, context, seed } = await fixture();
				const [a, b, c] = [row({ age: 1 }), row({ age: 2 }), row({ age: 3 })];
				await seed(a, b, c);
				const find = (where: Row) => provider.findMany(context, { where });
				expect(ids(await find({ age: { in: [1, 3] } }))).toEqual([a.id, c.id]);
				expect(ids(await find({ id: { in: [b.id, "missing"] } }))).toEqual([
					b.id,
				]);
				expect(ids(await find({ age: { in: [] } }))).toEqual([]);
				expect(
					await provider.count(context, { where: { age: { in: [] } } }),
				).toBe(0);
				expect(
					await provider.findOne(context, { where: { age: { in: [] } } }),
				).toBe(undefined);
			});

			it("ANDs conditions on several keys", async () => {
				const { provider, context, seed } = await fixture();
				const [a, b, c] = [
					row({ age: 30, name: "Ana" }),
					row({ age: 30, name: "Bia" }),
					row({ age: 20, name: "Bia" }),
				];
				await seed(a, b, c);
				const find = (where: Row) => provider.findMany(context, { where });
				expect(ids(await find({ age: 30, name: "Bia" }))).toEqual([b.id]);
				expect(
					ids(await find({ age: { in: [20, 30] }, name: { in: ["Bia"] } })),
				).toEqual([b.id, c.id]);
				expect(ids(await find({ age: 20, name: "Ana" }))).toEqual([]);
			});
		});

		describe("orderBy", () => {
			const order = async (
				rows: Row[],
				orderBy: RepositoryQuery["orderBy"],
			) => {
				const { provider, context, seed } = await fixture();
				await seed(...rows);
				return ids(await provider.findMany(context, { orderBy }));
			};

			it("is ascending by default and descending on request", async () => {
				const [a, b, c] = [row({ age: 2 }), row({ age: 3 }), row({ age: 1 })];
				expect(await order([a, b, c], [{ key: "age" }])).toEqual([
					c.id,
					a.id,
					b.id,
				]);
				expect(
					await order([a, b, c], [{ key: "age", direction: "asc" }]),
				).toEqual([c.id, a.id, b.id]);
				expect(
					await order([a, b, c], [{ key: "age", direction: "desc" }]),
				).toEqual([b.id, a.id, c.id]);
			});

			it("sorts numbers numerically", async () => {
				const [a, b, c] = [
					row({ age: 10 }),
					row({ age: 9 }),
					row({ age: 100 }),
				];
				expect(await order([a, b, c], [{ key: "age" }])).toEqual([
					b.id,
					a.id,
					c.id,
				]);
			});

			it("sorts strings by code point", async () => {
				const [lower, upper, wide, emoji] = [
					row({ name: "a" }),
					row({ name: "Z" }),
					row({ name: "ｚ" }),
					row({ name: "\u{1F600}" }),
				];
				expect(
					await order([emoji, lower, wide, upper], [{ key: "name" }]),
				).toEqual([upper.id, lower.id, wide.id, emoji.id]);
			});

			it("puts missing values first when ascending and last when descending", async () => {
				const [a, b, c] = [row({ age: 2 }), row(), row({ age: 1 })];
				expect(await order([a, b, c], [{ key: "age" }])).toEqual([
					b.id,
					c.id,
					a.id,
				]);
				expect(
					await order([a, b, c], [{ key: "age", direction: "desc" }]),
				).toEqual([a.id, c.id, b.id]);
			});

			it("keeps the insertion order of ties", async () => {
				const [a, b, c, d] = [
					row({ group: 1 }),
					row({ group: 0 }),
					row({ group: 1 }),
					row({ group: 0 }),
				];
				expect(await order([a, b, c, d], [{ key: "group" }])).toEqual([
					b.id,
					d.id,
					a.id,
					c.id,
				]);
				expect(
					await order([a, b, c, d], [{ key: "group", direction: "desc" }]),
				).toEqual([a.id, c.id, b.id, d.id]);
			});

			it("sorts by several keys in turn", async () => {
				const [a, b, c, d] = [
					row({ group: 1, name: "b" }),
					row({ group: 0, name: "z" }),
					row({ group: 1, name: "a" }),
					row({ group: 0, name: "y" }),
				];
				expect(
					await order(
						[a, b, c, d],
						[{ key: "group" }, { key: "name", direction: "desc" }],
					),
				).toEqual([b.id, d.id, a.id, c.id]);
				expect(
					await order(
						[a, b, c, d],
						[{ key: "group", direction: "desc" }, { key: "name" }],
					),
				).toEqual([c.id, a.id, d.id, b.id]);
			});
		});

		describe("limit and offset", () => {
			const seeded = async () => {
				const f = await fixture();
				const rows = [1, 2, 3, 4, 5].map((n) => row({ n }));
				await f.seed(...rows);
				return { ...f, rows };
			};
			const byN = [{ key: "n" }] as const;

			it("limit takes the first rows, offset skips rows before it", async () => {
				const { provider, context, rows } = await seeded();
				const find = (limit?: number, offset?: number) =>
					provider.findMany(context, { orderBy: byN, limit, offset }).then(ids);
				expect(await find(2)).toEqual([rows[0]?.id, rows[1]?.id]);
				expect(await find(undefined, 3)).toEqual([rows[3]?.id, rows[4]?.id]);
				expect(await find(2, 1)).toEqual([rows[1]?.id, rows[2]?.id]);
				expect(await find(10, 4)).toEqual([rows[4]?.id]);
				expect(await find(2, 5)).toEqual([]);
			});

			it("limit 0 returns nothing", async () => {
				const { provider, context } = await seeded();
				expect(await provider.findMany(context, { limit: 0 })).toEqual([]);
				expect(await provider.findOne(context, { limit: 0 })).toBe(undefined);
			});

			it("findOne returns the first row after the offset", async () => {
				const { provider, context, rows } = await seeded();
				expect(
					(await provider.findOne(context, { orderBy: byN, offset: 2 }))?.id,
				).toBe(rows[2]?.id);
				expect(
					await provider.findOne(context, { orderBy: byN, offset: 5 }),
				).toBe(undefined);
			});

			it("count ignores order, limit and offset", async () => {
				const { provider, context } = await seeded();
				expect(
					await provider.count(context, {
						orderBy: [{ key: "n", direction: "desc" }],
						limit: 1,
						offset: 3,
					}),
				).toBe(5);
				expect(
					await provider.count(context, {
						where: { n: { in: [1, 2] } },
						limit: 0,
						offset: 9,
					}),
				).toBe(2);
			});
		});

		describe("withDeleted", () => {
			const deletedAt = "2024-01-01T00:00:00.000Z";
			const seeded = async () => {
				const f = await fixture();
				const [live, gone] = [row({ n: 1 }), row({ n: 2, deletedAt })];
				await f.seed(live, gone);
				return { ...f, live, gone };
			};

			it("excludes deleted rows by default", async () => {
				const { provider, context, live, gone } = await seeded();
				expect(ids(await provider.findMany(context))).toEqual([live.id]);
				expect(
					ids(await provider.findMany(context, { withDeleted: false })),
				).toEqual([live.id]);
				expect(await provider.count(context)).toBe(1);
				expect(
					await provider.findOne(context, { where: { id: gone.id } }),
				).toBe(undefined);
			});

			it("includes them with withDeleted", async () => {
				const { provider, context, live, gone } = await seeded();
				const query = { withDeleted: true };
				expect(ids(await provider.findMany(context, query))).toEqual([
					live.id,
					gone.id,
				]);
				expect(await provider.count(context, query)).toBe(2);
				expect(
					await provider.findOne(context, {
						where: { id: gone.id },
						withDeleted: true,
					}),
				).toEqual(gone);
			});
		});

		describe("copies", () => {
			it("does not share data with the caller on write", async () => {
				const { provider, context } = await fixture();
				const data = row({ address: { city: "Rio" }, tags: ["x"] });
				await provider.insert(context, data);
				(data.address as Row).city = "SP";
				(data.tags as string[]).push("y");
				const stored = await provider.findOne(context, {
					where: { id: data.id },
				});
				expect(stored?.address).toEqual({ city: "Rio" });
				expect(stored?.tags).toEqual(["x"]);
			});

			it("does not share data with the caller on read", async () => {
				const { provider, context, seed } = await fixture();
				const data = row({ address: { city: "Rio" }, tags: ["x"] });
				await seed(data);
				const one = (await provider.findOne(context, {
					where: { id: data.id },
				})) as Row;
				(one.address as Row).city = "SP";
				one.name = "changed";
				const many = await provider.findMany(context);
				((many[0] as Row).tags as string[]).push("y");
				const stored = await provider.findOne(context, {
					where: { id: data.id },
				});
				expect(stored).toEqual(data);
			});
		});

		describe("keyset", () => {
			const keyset = (name: string, body: () => Promise<void>) =>
				it(name, async () => {
					const enabled =
						options.keyset ?? (await makeProvider()).capabilities?.keyset;
					if (enabled === true) await body();
				});
			const seeded = async () => {
				const f = await fixture();
				// By id: a, b, c, d, e, f; `n` is missing on b and e, tied on c and d.
				const [a, b, c, d, e, g] = [
					row({ n: 1, group: 1, name: "Gil" }),
					row({ group: 1, name: "Érico" }),
					row({ n: 2, group: 2, name: "Ana" }),
					row({ n: 2, group: 1, name: "ana" }),
					row({ group: 2, name: "Bia" }),
					row({ n: 3, group: 2, name: "Zoe" }),
				] as [Row, Row, Row, Row, Row, Row];
				await f.seed(a, b, c, d, e, g);
				const find = (query: ProviderQuery) =>
					f.provider.findMany(f.context, query).then(ids);
				return { ...f, a, b, c, d, e, g, find };
			};
			const by = (key: string, direction: "asc" | "desc" = "asc") =>
				[{ key, direction }, { key: "id" }] as const;

			keyset(
				"gives the rows strictly after the position, ascending",
				async () => {
					const { find, a, c, d, g } = await seeded();
					const orderBy = by("n");
					expect(await find({ orderBy, after: [1, a.id] })).toEqual([
						c.id,
						d.id,
						g.id,
					]);
					// Between two rows tied on the first key, the next key decides.
					expect(await find({ orderBy, after: [2, c.id] })).toEqual([
						d.id,
						g.id,
					]);
					expect(await find({ orderBy, after: [3, g.id] })).toEqual([]);
				},
			);

			keyset("follows a descending order", async () => {
				const { find, a, c, d, g } = await seeded();
				const orderBy = by("n", "desc");
				expect(
					await find({
						orderBy,
						after: [3, g.id],
						where: { n: { in: [1, 2] } },
					}),
				).toEqual([c.id, d.id, a.id]);
				expect(
					await find({
						orderBy,
						after: [2, d.id],
						where: { n: { in: [1, 2] } },
					}),
				).toEqual([a.id]);
			});

			keyset(
				"missing values are first ascending and last descending",
				async () => {
					const { find, a, b, c, d, e, g } = await seeded();
					expect(
						await find({ orderBy: by("n"), after: [undefined, b.id] }),
					).toEqual([e.id, a.id, c.id, d.id, g.id]);
					expect(
						await find({ orderBy: by("n"), after: [undefined, e.id] }),
					).toEqual([a.id, c.id, d.id, g.id]);
					expect(
						await find({ orderBy: by("n", "desc"), after: [1, a.id] }),
					).toEqual([b.id, e.id]);
					expect(
						await find({ orderBy: by("n", "desc"), after: [undefined, b.id] }),
					).toEqual([e.id]);
					expect(
						await find({ orderBy: by("n", "desc"), after: [undefined, e.id] }),
					).toEqual([]);
				},
			);

			keyset("compares strings by code point", async () => {
				const { find, a, b, c, d, e, g } = await seeded();
				// Ana < Bia < Gil < Zoe < ana < Érico
				expect(
					await find({ orderBy: by("name"), after: ["Bia", e.id] }),
				).toEqual([a.id, g.id, d.id, b.id]);
				expect(
					await find({ orderBy: by("name", "desc"), after: ["ana", d.id] }),
				).toEqual([g.id, a.id, e.id, c.id]);
			});

			keyset(
				"combines with where, withDeleted and limit; count ignores it",
				async () => {
					const { provider, context, find, a, b, d } = await seeded();
					const orderBy = [{ key: "id" }] as const;
					expect(
						await find({
							orderBy,
							after: [a.id],
							where: { group: 1 },
							limit: 1,
						}),
					).toEqual([b.id]);
					expect(
						await find({ orderBy, after: [b.id], where: { group: 1 } }),
					).toEqual([d.id]);
					await provider.update(context, {
						...d,
						deletedAt: "2024-01-01T00:00:00.000Z",
					});
					expect(
						await find({ orderBy, after: [b.id], where: { group: 1 } }),
					).toEqual([]);
					expect(
						await find({
							orderBy,
							after: [b.id],
							where: { group: 1 },
							withDeleted: true,
						}),
					).toEqual([d.id]);
					expect(
						await provider.count(context, {
							orderBy,
							after: [b.id],
						} as RepositoryQuery),
					).toBe(5);
				},
			);
		});

		describe("indexes", () => {
			const indexed = (name: string, body: () => Promise<void>) =>
				it(name, async () => {
					const enabled =
						options.indexes ?? (await makeProvider()).capabilities?.indexes;
					if (enabled === true) await body();
				});
			const seeded = async () => {
				const f = await fixture();
				const context: RepositoryContext = {
					...f.context,
					indexes: {
						byGroup: { where: ["group"], orderBy: "n" },
						byName: { where: ["name"] },
					},
				};
				const rows = [
					row({ n: 3, group: 1, name: "Gil" }),
					row({ group: 1, name: "Érico" }),
					row({ n: 2, group: 2, name: "Ana" }),
					row({ n: 2, group: 1, name: "Ana" }),
					row({ n: 1, group: 1, name: "Bia" }),
					row({ n: 4, group: 2, name: "Zoe" }),
				];
				for (const data of rows) await f.provider.insert(context, data);
				await f.provider.update(context, {
					...(rows[4] as Row),
					deletedAt: "2024-01-01T00:00:00.000Z",
				});
				return { ...f, context };
			};

			indexed("an indexed query gives what the scan gives", async () => {
				const { provider, context } = await seeded();
				const queries: [string, ProviderQuery][] = [
					["byGroup", { where: { group: 1 } }],
					[
						"byGroup",
						{
							where: { group: 1 },
							orderBy: [{ key: "n" }, { key: "id" }],
						},
					],
					[
						"byGroup",
						{
							where: { group: 1, name: "Ana" },
							orderBy: [{ key: "n", direction: "desc" }, { key: "id" }],
							limit: 2,
							offset: 1,
						},
					],
					[
						"byGroup",
						{
							where: { group: 1 },
							orderBy: [{ key: "n" }, { key: "id" }],
							withDeleted: true,
						},
					],
					["byName", { where: { name: "Ana" }, orderBy: [{ key: "id" }] }],
				];
				for (const [index, query] of queries) {
					expect(
						ids(await provider.findMany(context, { ...query, index })),
					).toEqual(ids(await provider.findMany(context, query)));
					expect(
						await provider.count(context, {
							...query,
							index,
						} as RepositoryQuery),
					).toBe(await provider.count(context, query));
					expect(
						(
							await provider.findOne(context, {
								...query,
								index,
							} as RepositoryQuery)
						)?.id,
					).toBe((await provider.findOne(context, query))?.id);
				}
			});
		});

		const withTransactions = async () => {
			const enabled =
				options.transactions ??
				(await makeProvider()).capabilities?.transactions;
			return enabled === true;
		};

		describe("transactions", () => {
			const transactional = (name: string, body: () => Promise<void>) =>
				it(name, async () => {
					if (!(await withTransactions())) return;
					await body();
				});

			const open = async () => {
				const f = await fixture();
				const transaction = f.provider.transaction?.bind(f.provider);
				if (!transaction) {
					throw new Error("the provider advertises transactions but has none");
				}
				return { ...f, transaction };
			};

			transactional(
				"commits the writes when the callback resolves",
				async () => {
					const { provider, context, seed, transaction } = await open();
					const [a, b] = [row({ name: "a" }), row()];
					await seed(a);
					const result = await transaction(async (tx) => {
						await tx.insert(context, b);
						await tx.update(context, { ...a, name: "changed" });
						expect(await tx.count(context)).toBe(2);
						return "done";
					});
					expect(result).toBe("done");
					expect(ids(await provider.findMany(context))).toEqual([a.id, b.id]);
					expect(
						(await provider.findOne(context, { where: { id: a.id } }))?.name,
					).toBe("changed");
				},
			);

			transactional(
				"rolls back every write when the callback rejects",
				async () => {
					const { provider, context, seed, transaction } = await open();
					const [a, b] = [row({ name: "a" }), row()];
					await seed(a, b);
					const boom = new Error("boom");
					const error = await failure(
						transaction(async (tx) => {
							await tx.insert(context, row());
							await tx.update(context, { ...a, name: "changed" });
							await tx.remove(context, b.id as string);
							throw boom;
						}),
					);
					expect(error).toBe(boom);
					expect(await provider.findMany(context)).toEqual([a, b]);
				},
			);

			transactional("rolls back after a failed write inside", async () => {
				const { provider, context, seed, transaction } = await open();
				const a = row({ email: "a@example.com" });
				await seed(a);
				const error = await failure(
					transaction(async (tx) => {
						await tx.insert(context, row());
						await tx.insert(context, row({ email: "a@example.com" }));
					}),
				);
				expect(error instanceof RepositoryUniqueViolation).toBe(true);
				expect(await provider.findMany(context)).toEqual([a]);
			});

			transactional("does not lose writes made outside meanwhile", async () => {
				const { provider, context, transaction } = await open();
				const [inside, outside] = [row(), row()];
				let release: () => void = () => {};
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				let started: () => void = () => {};
				const entered = new Promise<void>((resolve) => {
					started = resolve;
				});
				const running = failure(
					transaction(async (tx) => {
						await tx.insert(context, inside);
						started();
						await gate;
						throw new Error("rollback");
					}),
				);
				await entered;
				const writing = provider.insert(context, outside);
				release();
				await running;
				await writing;
				expect(ids(await provider.findMany(context))).toEqual([outside.id]);
			});

			transactional(
				"rejects the scoped provider after the callback",
				async () => {
					const { context, transaction } = await open();
					let scoped: IRepositoryProvider | undefined;
					await transaction(async (tx) => {
						scoped = tx;
					});
					const error = await failure(
						(scoped as IRepositoryProvider).insert(context, row()),
					);
					expect(error instanceof Error).toBe(true);
					const read = await failure(
						(scoped as IRepositoryProvider).count(context),
					);
					expect(read instanceof Error).toBe(true);
				},
			);

			transactional("treats a nested transaction as a savepoint", async () => {
				const { provider, context, transaction } = await open();
				const [outer, kept, dropped] = [row(), row(), row()];
				await transaction(async (tx) => {
					expect(typeof tx.transaction).toBe("function");
					await tx.insert(context, outer);
					await tx.transaction?.(async (inner) => {
						await inner.insert(context, kept);
					});
					const error = await failure(
						tx.transaction?.(async (inner) => {
							await inner.insert(context, dropped);
							throw new Error("inner");
						}) ?? Promise.resolve(),
					);
					expect((error as Error).message).toBe("inner");
					expect(ids(await tx.findMany(context))).toEqual([outer.id, kept.id]);
				});
				expect(ids(await provider.findMany(context))).toEqual([
					outer.id,
					kept.id,
				]);
			});

			transactional(
				"rolls the outer back even if an inner one committed",
				async () => {
					const { provider, context, transaction } = await open();
					await failure(
						transaction(async (tx) => {
							await tx.transaction?.(async (inner) => {
								await inner.insert(context, row());
							});
							throw new Error("outer");
						}),
					);
					expect(await provider.count(context)).toBe(0);
				},
			);
		});
	});
}
