import { describe, expect, expectTypeOf, test } from "bun:test";
import type { IRepositoryProvider } from "../../adapters";
import {
	blueprintOf,
	Exception,
	entityOf,
	InvalidRepositoryCursor,
	InvalidRepositoryQuery,
	inMemoryProvider,
	type RepositoryWalkPage,
	type RepositoryWalkResult,
	repositoryOf,
	useCaseOf,
} from "../../index";

const Fields = blueprintOf((ctx) => ({
	name: ctx.string,
	type: ctx.integer,
}));
class Entry extends entityOf(Fields) {}

async function world(count = 7) {
	const Entries = repositoryOf({
		entity: Entry,
		actions: ["create", "delete", "count", "forEachPage"],
		provider: inMemoryProvider(),
	});
	const entries: Entry[] = [];
	for (let index = 0; index < count; index++) {
		entries.push(
			await Entries.create(
				new Entry({ name: `e${index}`, type: index % 2 === 0 ? 1 : 2 }),
			),
		);
	}
	return { Entries, entries };
}

async function rejected(promise: Promise<unknown>): Promise<Exception> {
	const error = await promise.then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(Exception);
	return error as Exception;
}

describe("forEachPage", () => {
	test("walks every item once, page by page, and says it is done", async () => {
		const { Entries, entries } = await world();
		const seen: string[] = [];
		const pages: RepositoryWalkPage[] = [];
		const result = await Entries.forEachPage({ limit: 3 }, (items, page) => {
			expectTypeOf(items).toEqualTypeOf<Entry[]>();
			seen.push(...items.map((entry) => entry.id));
			pages.push(page);
		});
		expectTypeOf(result).toEqualTypeOf<RepositoryWalkResult>();
		expect(result).toEqual({ done: true, pages: 3, items: 7 });
		expect("next" in result).toBe(false);
		expect(seen.sort()).toEqual(entries.map((entry) => entry.id).sort());
		expect(pages.map((page) => page.index)).toEqual([0, 1, 2]);
		expect(pages[0]?.next).toBeString();
		expect(pages[2]?.next).toBeUndefined();
	});

	test("honors where, orderBy and limit", async () => {
		const { Entries } = await world();
		const seen: string[][] = [];
		const result = await Entries.forEachPage(
			{
				where: { type: 1 },
				orderBy: [{ key: "name", direction: "desc" }],
				limit: 2,
			},
			(items) => {
				seen.push(items.map((entry) => entry.name));
			},
		);
		expect(seen).toEqual([
			["e6", "e4"],
			["e2", "e0"],
		]);
		expect(result).toEqual({ done: true, pages: 2, items: 4 });
	});

	test("an empty repository is done with no pages", async () => {
		const { Entries } = await world(0);
		let calls = 0;
		const result = await Entries.forEachPage({}, () => {
			calls++;
		});
		expect(result).toEqual({ done: true, pages: 0, items: 0 });
		expect(calls).toBe(0);
	});

	test("an until already passed runs no page and resumes where it was given", async () => {
		const { Entries } = await world();
		let calls = 0;
		const fn = () => {
			calls++;
		};
		const past = new Date(Date.now() - 1000);
		expect(await Entries.forEachPage({}, fn, { until: past })).toEqual({
			done: false,
			next: undefined,
			pages: 0,
			items: 0,
		});
		const first = await Entries.forEachPage({ limit: 2 }, fn, {
			until: () => calls === 1,
		});
		expect(first.next).toBeString();
		const again = await Entries.forEachPage(
			{ limit: 2, after: first.next },
			fn,
			{ until: Date.now() - 1 },
		);
		expect(again).toEqual({
			done: false,
			next: first.next,
			pages: 0,
			items: 0,
		});
		expect(calls).toBe(1);
	});

	test("a predicate until stops between pages, and resuming from next covers the rest once", async () => {
		const { Entries, entries } = await world();
		const seen: string[] = [];
		let checks = 0;
		const first = await Entries.forEachPage(
			{ limit: 2 },
			(items) => {
				seen.push(...items.map((entry) => entry.name));
			},
			{ until: () => ++checks > 2 },
		);
		expect(first).toMatchObject({ done: false, pages: 2, items: 4 });
		expect(first.next).toBeString();
		const rest = await Entries.forEachPage(
			{ limit: 2, after: first.next },
			(items) => {
				seen.push(...items.map((entry) => entry.name));
			},
		);
		expect(rest).toEqual({ done: true, pages: 2, items: 3 });
		expect(seen.sort()).toEqual(entries.map((entry) => entry.name).sort());
	});

	test("a deadline stops before the next page, never inside one", async () => {
		const { Entries } = await world();
		const deadline = Date.now() + 60_000;
		let now = Date.now();
		const clock = Date.now;
		Date.now = () => now;
		try {
			const result = await Entries.forEachPage(
				{ limit: 3 },
				() => {
					// The time runs out while the first page runs; it still finishes.
					now = deadline;
				},
				{ until: deadline },
			);
			expect(result).toMatchObject({ done: false, pages: 1, items: 3 });
			now = deadline - 1;
			const rest = await Entries.forEachPage(
				{ limit: 3, after: result.next },
				() => {},
				{ until: new Date(deadline) },
			);
			expect(rest).toEqual({ done: true, pages: 2, items: 4 });
		} finally {
			Date.now = clock;
		}
	});

	test("resuming stays exact with rows added and removed between calls", async () => {
		const { Entries, entries } = await world();
		const order = entries.map((entry) => entry.id).sort();
		const seen: string[] = [];
		const walk = (items: Entry[]) => {
			seen.push(...items.map((entry) => entry.id));
		};
		const first = await Entries.forEachPage({ limit: 3 }, walk, {
			until: () => seen.length > 0,
		});
		expect(first).toMatchObject({ done: false, pages: 1, items: 3 });
		// Behind the cursor: an id that sorts first (never read); ahead: one that sorts last.
		const behind = await Entries.create(
			new Entry({
				id: "00000000-0000-7000-8000-000000000000",
				name: "behind",
				type: 1,
			}),
		);
		const ahead = await Entries.create(
			new Entry({
				id: "ffffffff-ffff-7fff-bfff-ffffffffffff",
				name: "ahead",
				type: 1,
			}),
		);
		// One of the rows not read yet is removed.
		const removed = order[4] as string;
		await Entries.delete(removed);
		const rest = await Entries.forEachPage(
			{ limit: 3, after: first.next },
			walk,
		);
		expect(rest.done).toBe(true);
		expect(seen).toEqual([...order.filter((id) => id !== removed), ahead.id]);
		expect(seen).not.toContain(behind.id);
		expect(new Set(seen).size).toBe(seen.length);
	});

	test("deleting the items of each page inside fn walks them all and ends", async () => {
		const { Entries } = await world(10);
		await Entries.create(new Entry({ name: "keep", type: 3 }));
		const result = await Entries.forEachPage(
			{ where: { type: { in: [1, 2] } }, limit: 3 },
			async (items) => {
				await Promise.all(items.map((entry) => Entries.delete(entry)));
			},
		);
		expect(result).toEqual({ done: true, pages: 4, items: 10 });
		expect(await Entries.count()).toBe(1);
	});

	test("an error of fn rejects through the repository and stops the walk", async () => {
		const { Entries } = await world();
		let saved: string | undefined;
		let calls = 0;
		const error = await rejected(
			Entries.forEachPage({ limit: 2 }, (_items, page) => {
				calls++;
				if (page.index === 1) throw new Error("boom");
				saved = page.next;
			}),
		);
		expect(error.message).toBe("boom");
		expect(error.trace.at(-1)?.source).toBe("EntryRepository");
		expect(calls).toBe(2);
		// Resuming from the checkpoint saved by the caller runs the failed page again.
		const names: string[] = [];
		const rest = await Entries.forEachPage(
			{ limit: 2, after: saved },
			(items) => {
				names.push(...items.map((entry) => entry.name));
			},
		);
		expect(rest).toMatchObject({ done: true, items: 5 });
	});

	test("rejects a bad query, cursor, fn or until", async () => {
		const { Entries } = await world();
		const noop = () => {};
		expect(
			await rejected(Entries.forEachPage({ limit: 0 }, noop)),
		).toBeInstanceOf(InvalidRepositoryQuery);
		expect(
			await rejected(Entries.forEachPage({ offset: 2 } as never, noop)),
		).toBeInstanceOf(InvalidRepositoryQuery);
		expect(
			await rejected(Entries.forEachPage({ after: "nope" }, noop)),
		).toBeInstanceOf(InvalidRepositoryCursor);
		expect(
			await rejected(Entries.forEachPage({}, undefined as never)),
		).toBeInstanceOf(InvalidRepositoryQuery);
		expect(
			await rejected(
				Entries.forEachPage({}, noop, { until: "tomorrow" as never }),
			),
		).toBeInstanceOf(InvalidRepositoryQuery);
		// The query is checked even when until has already passed.
		expect(
			await rejected(Entries.forEachPage({ limit: 0 }, noop, { until: 0 })),
		).toBeInstanceOf(InvalidRepositoryQuery);
	});

	test("needs a provider that reads by cursor", async () => {
		const { keyset: _keyset, ...capabilities } =
			inMemoryProvider().capabilities ?? {};
		const provider: IRepositoryProvider = {
			...inMemoryProvider(),
			capabilities,
		};
		const Entries = repositoryOf({
			entity: Entry,
			actions: ["forEachPage"],
			provider,
		});
		expect(await rejected(Entries.forEachPage({}, () => {}))).toBeInstanceOf(
			InvalidRepositoryQuery,
		);
	});

	test("is declared only when listed, and needs findMany", () => {
		const Entries = repositoryOf({ entity: Entry, actions: ["create"] });
		expect("forEachPage" in Entries).toBe(false);
		// @ts-expect-error not declared
		Entries.forEachPage;
		const { findMany: _findMany, ...provider } = inMemoryProvider();
		expect(() =>
			repositoryOf({
				entity: Entry,
				actions: ["forEachPage"],
				provider: provider as never,
			}),
		).toThrow('The provider has no "findMany" for "forEachPage".');
	});
});

describe("forEachPage in a use case", () => {
	test("fn uses the methods execute replaces, and the scope of the call", async () => {
		const { Entries } = await world(5);
		class Purge extends useCaseOf({
			name: "Purge",
			blueprint: blueprintOf(() => ({})),
			response: blueprintOf((ctx) => ({ items: ctx.integer })),
			dependencies: { entries: Entries },
		}) {
			override async execute({ entries = this.dependencies.entries } = {}) {
				const { items } = await entries.forEachPage(
					{ limit: 2 },
					async (page) => {
						for (const entry of page) await entries.delete(entry);
					},
				);
				return { items };
			}
		}
		const deleted: string[] = [];
		const result = await new Purge({}).execute({
			entries: {
				delete: async (entry: Entry | string) => {
					deleted.push(typeof entry === "string" ? entry : entry.name);
					return entry as Entry;
				},
			} satisfies Partial<typeof Entries> as typeof Entries,
		});
		expect(result.items).toBe(5);
		expect(deleted.sort()).toEqual(["e0", "e1", "e2", "e3", "e4"]);
		expect(await Entries.count()).toBe(5);

		// Without overrides, the real delete runs.
		await new Purge({}).execute();
		expect(await Entries.count()).toBe(0);
	});
});
