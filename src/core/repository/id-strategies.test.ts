// Repositories of entities whose ids are not UUID v7: a natural key (`Key`)
// and integers (`idOf(Integer, ...)`), by id, as references and in cursors.
import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	blueprintOf,
	entityOf,
	Integer,
	idOf,
	inMemoryProvider,
	Key,
	RepositoryEntityNotFound,
	repositoryOf,
} from "../../index";

const Named = blueprintOf((ctx) => ({ name: ctx.string }));

class Setting extends entityOf(Named, { id: Key, change: ["name"] }) {}

function counter() {
	let next = 0;
	return () => ++next;
}

describe("a natural key", () => {
	const declare = () =>
		repositoryOf({
			entity: Setting,
			actions: ["create", "update", "findById", "delete", "findMany"],
			provider: inMemoryProvider(),
		});

	test("finds, updates and deletes by the key", async () => {
		const Settings = declare();
		await Settings.create({ id: "profile", name: "Profile" });
		await Settings.create({ id: "seo", name: "SEO" });

		const found = await Settings.findById("seo");
		expect(found?.name).toBe("SEO");
		expectTypeOf<
			Parameters<typeof Settings.findById>[0]
		>().toEqualTypeOf<string>();

		await Settings.update((found as Setting).change.name("Search"));
		expect((await Settings.findById("seo"))?.name).toBe("Search");

		const deleted = await Settings.delete("profile");
		expect(deleted.id).toBe("profile");
		expect(await Settings.findById("profile")).toBeUndefined();
		const error = await Settings.delete("missing").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RepositoryEntityNotFound);
	});

	test("a key is unique", async () => {
		const Settings = declare();
		await Settings.create({ id: "profile", name: "Profile" });
		await expect(
			Settings.create({ id: "profile", name: "Again" }),
		).rejects.toThrow();
	});

	test("an entity held by another one is stored by its key and loaded back", async () => {
		const Settings = declare();
		class Page extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string, setting: Setting })),
		) {}
		const Pages = repositoryOf({
			entity: Page,
			actions: ["create", "findById"],
			provider: inMemoryProvider(),
			relations: [Settings],
		});
		const setting = await Settings.create({ id: "seo", name: "SEO" });
		const page = await Pages.create({ title: "Home", setting });

		const loaded = await Pages.findById(page.id);
		expect(loaded?.setting).toBeInstanceOf(Setting);
		expect(loaded?.setting.id).toBe("seo");
		expect(loaded?.setting.name).toBe("SEO");
	});
});

describe("integer ids", () => {
	const declare = () => {
		class Ticket extends entityOf(
			blueprintOf((ctx) => ({ title: ctx.string, rank: ctx.integer })),
			{ id: idOf(Integer, counter()) },
		) {}
		const Tickets = repositoryOf({
			entity: Ticket,
			actions: [
				"create",
				"findById",
				"delete",
				"increment",
				"findCursor",
				"findMany",
			],
			provider: inMemoryProvider(),
		});
		return { Ticket, Tickets };
	};

	test("finds and deletes by a number", async () => {
		const { Ticket, Tickets } = declare();
		const first = await Tickets.create({ title: "a", rank: 1 });
		expect(first.id).toBe(1);
		expectTypeOf(first.id).toEqualTypeOf<number>();
		expectTypeOf<
			Parameters<typeof Tickets.findById>[0]
		>().toEqualTypeOf<number>();
		expectTypeOf<Parameters<typeof Tickets.delete>[0]>().toEqualTypeOf<
			InstanceType<typeof Ticket> | number
		>();

		expect((await Tickets.findById(1))?.title).toBe("a");
		expect(await Tickets.findById("1" as never)).toBeUndefined();
		expect((await Tickets.delete(1)).id).toBe(1);
		expect(await Tickets.findById(1)).toBeUndefined();
	});

	test("orders the ties of a cursor numerically by id", async () => {
		const { Tickets } = declare();
		for (let index = 0; index < 12; index++) {
			await Tickets.create({ title: `t${index}`, rank: 0 });
		}
		const read: number[] = [];
		let after: string | undefined;
		do {
			const page = await Tickets.findCursor({
				orderBy: [{ key: "rank", direction: "asc" }],
				limit: 5,
				after,
			});
			read.push(...page.items.map((ticket) => ticket.id));
			after = page.next;
		} while (after !== undefined);
		expect(read).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
	});

	test("references to an entity of integer ids resolve", async () => {
		const { Ticket, Tickets } = declare();
		class Comment extends entityOf(
			blueprintOf((ctx) => ({ text: ctx.string, ticket: Ticket })),
		) {}
		const Comments = repositoryOf({
			entity: Comment,
			actions: ["create", "findMany"],
			provider: inMemoryProvider(),
			relations: [Tickets],
		});
		const ticket = await Tickets.create({ title: "a", rank: 1 });
		await Comments.create({ text: "hi", ticket });

		const [comment] = await Comments.findMany({
			where: { ticket: ticket.id },
		});
		expect(comment?.ticket).toBeInstanceOf(Ticket);
		expect(comment?.ticket.id).toBe(1);
	});
});
