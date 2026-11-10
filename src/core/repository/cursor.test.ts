import { describe, expect, expectTypeOf, test } from "bun:test";
import type { IRepositoryProvider } from "../../adapters";
import {
	applicationOf,
	blueprintOf,
	Exception,
	entityOf,
	InvalidRepositoryCursor,
	InvalidRepositoryDeclaration,
	InvalidRepositoryQuery,
	inMemoryProvider,
	type RepositoryCursorPage,
	repositoryOf,
} from "../../index";
import { statusOf } from "../output/status";
import { decodeCursor, encodeCursor } from "./cursor";

const Fields = blueprintOf((ctx) => ({
	name: ctx.string,
	group: ctx.integer,
	rank: ctx.optional.integer,
	salary: ctx.integer,
}));
class Person extends entityOf(Fields, { sensitive: ["salary"] }) {}

const ROWS = [
	{ name: "Ana", group: 1, rank: 3 },
	{ name: "Bia", group: 2 },
	{ name: "Caio", group: 1, rank: 1 },
	{ name: "Davi", group: 2, rank: 2 },
	{ name: "Eva", group: 1 },
	{ name: "Érico", group: 2, rank: 2 },
	{ name: "Gil", group: 1, rank: 3 },
];

async function world(deletion: "hard" | "soft" = "hard") {
	const People = repositoryOf({
		entity: Person,
		actions: ["create", "delete", "findMany", "findCursor"],
		provider: inMemoryProvider(),
		deletion,
	});
	const people: Person[] = [];
	for (const row of ROWS) {
		people.push(await People.create(new Person({ ...row, salary: 1 })));
	}
	return { People, people };
}

type Query = NonNullable<
	Parameters<Awaited<ReturnType<typeof world>>["People"]["findCursor"]>[0]
>;

/** The names of every page of `query`, read to the end. */
async function pages(
	People: Awaited<ReturnType<typeof world>>["People"],
	query: Query,
): Promise<string[][]> {
	const read: string[][] = [];
	let after: string | undefined;
	do {
		const page = await People.findCursor({ ...query, after });
		read.push(page.items.map((person) => person.name));
		after = page.next;
	} while (after !== undefined);
	return read;
}

async function rejected(promise: Promise<unknown>): Promise<Exception> {
	const error = await promise.then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(Exception);
	return error as Exception;
}

describe("findCursor", () => {
	test("reads every row once, in the order of the ids by default", async () => {
		const { People } = await world();
		const all = ROWS.map((row) => row.name);

		expect(await pages(People, { limit: 3 })).toEqual([
			all.slice(0, 3),
			all.slice(3, 6),
			all.slice(6),
		]);
		// A page that ends with the last row has no next.
		expect(await pages(People, { limit: 7 })).toEqual([all]);
		const page = await People.findCursor();
		expect(page.limit).toBe(20);
		expect(page.next).toBeUndefined();
		expectTypeOf(page).toEqualTypeOf<RepositoryCursorPage<typeof Person>>();
		expectTypeOf(page.items).toEqualTypeOf<readonly Person[]>();
	});

	test("follows orderBy in both directions, ties broken by id", async () => {
		const { People } = await world();
		const sorted = await People.findMany({
			orderBy: [
				{ key: "group", direction: "desc" },
				{ key: "id", direction: "asc" },
			],
		});

		expect(
			(
				await pages(People, {
					orderBy: [{ key: "group", direction: "desc" }],
					limit: 2,
				})
			).flat(),
		).toEqual(sorted.map((person) => person.name));
		expect(
			(
				await pages(People, {
					orderBy: [{ key: "name", direction: "desc" }],
					limit: 3,
				})
			).flat(),
		).toEqual(["Érico", "Gil", "Eva", "Davi", "Caio", "Bia", "Ana"]);
	});

	test("missing values keep their place: first ascending, last descending", async () => {
		const { People } = await world();
		const order = (direction: "asc" | "desc") =>
			[
				{ key: "rank", direction },
				{ key: "name", direction: "asc" },
			] as const;

		expect(
			(await pages(People, { orderBy: order("asc"), limit: 2 })).flat(),
		).toEqual(["Bia", "Eva", "Caio", "Davi", "Érico", "Ana", "Gil"]);
		expect(
			(await pages(People, { orderBy: order("desc"), limit: 2 })).flat(),
		).toEqual(["Ana", "Gil", "Davi", "Érico", "Caio", "Bia", "Eva"]);
	});

	test("where narrows every page", async () => {
		const { People } = await world();
		expect(
			await pages(People, {
				where: { group: 1 },
				orderBy: [{ key: "name" }],
				limit: 3,
			}),
		).toEqual([["Ana", "Caio", "Eva"], ["Gil"]]);
	});

	test("rows removed or added between pages do not shift the others", async () => {
		for (const deletion of ["hard", "soft"] as const) {
			const { People, people } = await world(deletion);
			const query = { orderBy: [{ key: "name" }], limit: 2 } as const;
			const first = await People.findCursor(query);
			expect(first.items.map((person) => person.name)).toEqual(["Ana", "Bia"]);

			// One already read and one still to read go; one is added before the cursor.
			await People.delete(people[0] as Person);
			await People.delete(people[2] as Person);
			await People.create(new Person({ name: "Abel", group: 1, salary: 1 }));

			const second = await People.findCursor({ ...query, after: first.next });
			expect(second.items.map((person) => person.name)).toEqual([
				"Davi",
				"Eva",
			]);
		}
	});

	test("rejects what cannot be paged by cursor", async () => {
		const { People } = await world();
		const reasons = [
			[{ offset: 1 }, 'Unknown query option "offset".'],
			[{ limit: 0 }, "Expected a positive integer for limit."],
			[
				{ orderBy: [{ key: "salary" }] },
				'"salary" is sensitive and cannot order a cursor.',
			],
		] as const;
		for (const [query, reason] of reasons) {
			const error = await rejected(People.findCursor(query as never));
			expect(error).toBeInstanceOf(InvalidRepositoryQuery);
			expect(error.message).toBe(reason);
		}
		// `after` belongs to findCursor only.
		expect(
			await rejected(People.findMany({ after: "x" } as never)),
		).toBeInstanceOf(InvalidRepositoryQuery);
	});

	test("rejects a cursor that is not its own, as invalid input", async () => {
		const { People } = await world();
		const { next } = await People.findCursor({
			orderBy: [{ key: "name" }],
			limit: 2,
		});
		const cursors = [
			"",
			"not a cursor",
			"e30",
			1,
			btoa(JSON.stringify({ v: 2, k: ["id:asc"], a: ["x"] })),
			btoa(JSON.stringify({ v: 1, k: ["id:asc"], a: [{ x: 1 }] })),
		];
		for (const after of cursors) {
			const error = await rejected(People.findCursor({ after } as never));
			expect(error).toBeInstanceOf(InvalidRepositoryCursor);
			expect(statusOf(error)).toBe(400);
		}
		// A cursor of another order, or of the other direction.
		for (const orderBy of [
			[{ key: "group" }],
			[{ key: "name", direction: "desc" }],
			[],
		] as const) {
			const error = await rejected(
				People.findCursor({ orderBy, after: next } as never),
			);
			expect(error).toBeInstanceOf(InvalidRepositoryCursor);
			expect(error.message).toBe("The cursor was made for another orderBy.");
		}
	});

	test("needs a provider that reads by cursor", async () => {
		const { capabilities: _capabilities, ...memory } = inMemoryProvider();
		const provider = { ...memory, capabilities: { transactions: true } };
		// Declared with it: rejected, and the type has no findCursor.
		expect(() =>
			repositoryOf({ entity: Person, actions: ["findCursor"], provider }),
		).toThrow(InvalidRepositoryDeclaration);
		const Kept = repositoryOf({
			entity: Person,
			actions: ["findMany", "findCursor"],
		});
		expectTypeOf(Kept).toHaveProperty("findCursor");
		const Without = (() => {
			try {
				return repositoryOf({
					entity: Person,
					actions: ["findMany", "findCursor"],
					provider,
				});
			} catch {
				return undefined;
			}
		})();
		expectTypeOf<NonNullable<typeof Without>>().not.toHaveProperty(
			"findCursor",
		);
		// Bound to it by an application: the call still throws.
		const app = applicationOf({
			name: "cursors",
			entities: { Person },
			repositories: { Kept },
			provider: provider as IRepositoryProvider,
		});
		const error = await rejected(app.repositories.Kept.findCursor());
		expect(error).toBeInstanceOf(InvalidRepositoryQuery);
		expect(error.message).toBe(
			"The provider does not read by cursor (capabilities.keyset).",
		);
	});

	test("is only a method when declared", () => {
		const People = repositoryOf({ entity: Person, actions: ["findMany"] });
		expect("findCursor" in People).toBe(false);
		// @ts-expect-error not one of its actions
		People.findCursor;
	});
});

describe("cursor", () => {
	const orders = [{ key: "name" }, { key: "at", direction: "desc" }] as const;

	test("keeps text, numbers, dates, bigints and missing values", () => {
		const at = new Date("2026-01-02T03:04:05.678Z");
		for (const name of ["Érico 日本 🙂", 12.5, true, 10n, undefined, null]) {
			const cursor = encodeCursor(orders, { name, at });
			expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
			expect(decodeCursor("People", orders, cursor)).toEqual([
				name ?? undefined,
				at,
			]);
		}
	});
});
