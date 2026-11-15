// Entities whose ids the database assigns (`Serial`): built without one,
// stored by a provider with `capabilities.generatedIds`, rejected otherwise.
import { describe, expect, expectTypeOf, test } from "bun:test";
import type { IRepositoryProvider } from "../../adapters";
import {
	applicationOf,
	blueprintOf,
	type EventDefinition,
	entityOf,
	eventOf,
	inMemoryProvider,
	providerFrom,
	RepositoryUniqueViolation,
	repositoryOf,
	Serial,
	UnstoredEntity,
	UnsupportedIdentity,
	useCaseOf,
	wrapProvider,
} from "../../index";

const Titled = blueprintOf((ctx) => ({ title: ctx.string }));

const seen: unknown[] = [];
class Ticket extends entityOf(Titled, {
	id: Serial,
	change: ["title"],
	onCreate: () => TicketCreated,
}) {}
const TicketCreated: EventDefinition = eventOf(
	"ticket.created",
	Ticket,
	async (ticket) => {
		seen.push(ticket.id);
	},
);

/** A provider without `generatedIds`, as a store that assigns no ids. */
function withoutGeneratedIds(): IRepositoryProvider {
	const inner = inMemoryProvider();
	return {
		findOne: inner.findOne,
		findMany: inner.findMany,
		insert: inner.insert,
		update: inner.update,
		remove: inner.remove,
		count: inner.count,
		capabilities: { keyset: true },
	};
}

describe("an entity with Serial ids", () => {
	test("is valid without an id, which it has once created", async () => {
		const ticket = new Ticket({ title: "First" });
		expect(ticket.id).toBeUndefined();
		expect(JSON.stringify(ticket)).not.toContain('"id"');
		expectTypeOf(ticket.id).toEqualTypeOf<number>();
		expect(Ticket.safeParse({ title: "Second" }).issues).toBeUndefined();
		expect(Ticket.safeParse({ id: 0, title: "Zero" }).issues).toBeDefined();
		expect(Ticket.safeParse({ id: "a", title: "Text" }).issues).toBeDefined();
		expect(new Ticket({ id: 7, title: "Loaded" }).id).toBe(7);
	});

	test("describe tells the database assigns its ids", () => {
		const app = applicationOf({ name: "described", entities: { Ticket } });
		expect(app.describe().entities.Ticket?.id).toEqual({
			property: "serial",
			generated: "database",
		});
	});

	test("equals only itself before it has an id", () => {
		const one = new Ticket({ title: "A" });
		expect(one.equals(one)).toBe(true);
		expect(one.equals(new Ticket({ title: "A" }))).toBe(false);
		expect(
			new Ticket({ id: 3, title: "A" }).equals(
				new Ticket({ id: 3, title: "B" }),
			),
		).toBe(true);
	});

	test("create assigns increasing ids, never twice", async () => {
		const Tickets = repositoryOf({
			entity: Ticket,
			actions: ["create", "findById", "delete", "findMany"],
		});
		const first = await Tickets.create({ title: "First" });
		expect(first.id).toBe(1);
		const second = await Tickets.create(new Ticket({ title: "Second" }));
		expect(second.id).toBe(2);
		expect((await Tickets.findById(2))?.title).toBe("Second");
		await Tickets.delete(2);
		// As a sequence, an id is never given twice.
		expect((await Tickets.create({ title: "Third" })).id).toBe(3);
		expect((await Tickets.findMany()).map((ticket) => ticket.id)).toEqual([
			1, 3,
		]);
	});

	test("an id given for a new entity is rejected", async () => {
		const Tickets = repositoryOf({
			entity: Ticket,
			actions: ["create", "increment", "count"],
		});
		await expect(
			Tickets.create(new Ticket({ id: 2, title: "Given" })),
		).rejects.toThrow(UnsupportedIdentity);
		await expect(
			Tickets.create({ id: 2, title: "Given" } as never),
		).rejects.toThrow(UnsupportedIdentity);
		class Counted extends entityOf(
			blueprintOf((ctx) => ({ views: ctx.integer })),
			{ id: Serial, change: ["views"] },
		) {}
		const Counts = repositoryOf({ entity: Counted, actions: ["increment"] });
		await expect(
			Counts.increment(1, { views: 1 }, { create: {} }),
		).rejects.toThrow(UnsupportedIdentity);
		expect(await Tickets.count()).toBe(0);
	});

	test("the in-memory sequence does not skip a row inserted with its own id", async () => {
		const provider = inMemoryProvider();
		const Tickets = repositoryOf({
			entity: Ticket,
			actions: ["create"],
			provider,
		});
		await provider.insert(
			{ entity: Ticket, name: "TicketRepository", unique: ["id"], env: {} },
			{ id: 1, title: "Seeded", createdAt: new Date().toISOString() },
		);
		// As a database sequence, which a row with its own id does not move.
		await expect(Tickets.create({ title: "Next" })).rejects.toThrow(
			RepositoryUniqueViolation,
		);
		expect((await Tickets.create({ title: "Next" })).id).toBe(2);
	});

	test("an entity without an id yet cannot be updated, deleted, restored or incremented", async () => {
		class Counted extends entityOf(
			blueprintOf((ctx) => ({ views: ctx.integer })),
			{ id: Serial, change: ["views"] },
		) {}
		const Counts = repositoryOf({
			entity: Counted,
			actions: ["update", "delete", "restore", "increment"],
			deletion: "soft",
		});
		const unsaved = new Counted({ views: 0 });
		const message = (error: unknown) => (error as Error).message;
		const updated = await Counts.update(unsaved).catch((e: unknown) => e);
		expect(updated).toBeInstanceOf(UnstoredEntity);
		expect(message(updated)).toBe(
			'"CountedRepository" cannot update a Counted that has no id yet: create gives it the id the database assigns.',
		);
		await expect(Counts.delete(unsaved)).rejects.toThrow(UnstoredEntity);
		// Checked before destroy: the entity is left as it was.
		expect(unsaved.isDeleted).toBe(false);
		await expect(Counts.restore(unsaved)).rejects.toThrow(UnstoredEntity);
		await expect(Counts.increment(unsaved, { views: 1 })).rejects.toThrow(
			UnstoredEntity,
		);
	});

	test("an entity without an id yet cannot be held by another one", async () => {
		class Board extends entityOf(
			blueprintOf((ctx) => ({
				name: ctx.string,
				lead: ctx.optionalOf(Ticket),
				tickets: ctx.listOf(Ticket),
			})),
		) {}
		const Boards = repositoryOf({
			entity: Board,
			actions: ["create"],
			relations: [repositoryOf({ entity: Ticket, actions: ["findById"] })],
		});
		const unsaved = new Ticket({ title: "A" });
		await expect(
			Boards.create({ name: "One", lead: unsaved, tickets: [] }),
		).rejects.toThrow(UnstoredEntity);
		const error = await Boards.create({
			name: "Two",
			tickets: [new Ticket({ id: 4, title: "Stored" }), unsaved],
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(UnstoredEntity);
		expect((error as Error).message).toContain("create it first");
	});

	test("an id the entity rejects, from the provider, is refused", async () => {
		for (const given of [0, 2 ** 60, "5", 1.5]) {
			const inner = inMemoryProvider();
			const Tickets = repositoryOf({
				entity: Ticket,
				actions: ["create"],
				provider: {
					...withoutGeneratedIds(),
					capabilities: { generatedIds: true },
					insert: async (context, data) => {
						await inner.insert(context, data);
						return { id: given };
					},
				},
			});
			const ticket = new Ticket({ title: "A" });
			await expect(Tickets.create(ticket)).rejects.toThrow(UnsupportedIdentity);
			expect(ticket.id).toBeUndefined();
		}
	});

	test("a rolled back transaction does not give its ids back", async () => {
		const provider = inMemoryProvider();
		const Tickets = repositoryOf({
			entity: Ticket,
			actions: ["create"],
			provider,
		});
		await provider
			.transaction?.(async (inner) => {
				await inner.insert(
					{
						entity: Ticket,
						name: "TicketRepository",
						unique: ["id"],
						env: {},
					},
					{ title: "Lost", createdAt: new Date().toISOString() },
				);
				throw new Error("rollback");
			})
			.catch(() => {});
		expect((await Tickets.create({ title: "Kept" })).id).toBe(2);
	});

	test("onCreate waits for the id, and comes before later events", async () => {
		class Noted extends entityOf(Titled, {
			id: Serial,
			onCreate: () => TicketNoted,
		}) {
			note(): void {
				this.emit(Later);
			}
		}
		const TicketNoted: EventDefinition = eventOf("ticket.noted", Noted);
		const Later: EventDefinition = eventOf("ticket.later", Noted);
		const Notes = repositoryOf({ entity: Noted, actions: ["create"] });
		const note = new Noted({ title: "A" });
		note.note();
		expect(note.pullEvents().map((event) => event.name)).toEqual([
			"ticket.later",
		]);
		note.note();
		const created = await Notes.create(note);
		const events = created.pullEvents();
		expect(events.map((event) => event.name)).toEqual([
			"ticket.noted",
			"ticket.later",
		]);
		expect(events[0]?.entity.id).toBe(1);
	});

	test("a use case handles onCreate with the assigned id", async () => {
		seen.length = 0;
		const Tickets = repositoryOf({ entity: Ticket, actions: ["create"] });
		class Open extends useCaseOf({
			name: "Open",
			blueprint: Titled,
			response: blueprintOf((ctx) => ({ id: ctx.integer })),
			dependencies: { Tickets },
		}) {
			override async execute() {
				const ticket = await this.dependencies.Tickets.create({
					title: this.input.title,
				});
				return { id: ticket.id };
			}
		}
		const open = new Open({ title: "A" });
		expect(await open.execute()).toEqual({ id: 1 });
		const events = open.pullEvents();
		expect(events.map((event) => event.name)).toEqual(["ticket.created"]);
		for (const event of events) await event.handle();
		expect(seen).toEqual([1]);
	});

	test("a wrapped provider gives the assigned id through", async () => {
		const Tickets = repositoryOf({
			entity: Ticket,
			actions: ["create"],
			provider: wrapProvider(inMemoryProvider(), {
				around: (_call, next) => next(),
			}),
		});
		expect((await Tickets.create({ title: "A" })).id).toBe(1);
	});
});

describe("a provider that assigns no ids", () => {
	test("is rejected when the repository is declared", () => {
		expect(() =>
			repositoryOf({
				entity: Ticket,
				actions: ["create"],
				provider: withoutGeneratedIds(),
			}),
		).toThrow(UnsupportedIdentity);
		// Reading needs no ids assigned.
		expect(() =>
			repositoryOf({
				entity: Ticket,
				actions: ["findById"],
				provider: withoutGeneratedIds(),
			}),
		).not.toThrow();
	});

	test("is rejected when an application binds it", () => {
		const Tickets = repositoryOf({ entity: Ticket, actions: ["create"] });
		expect(() =>
			applicationOf({
				name: "bound",
				provider: withoutGeneratedIds(),
				entities: { Ticket },
				repositories: { Tickets },
			}),
		).toThrow(UnsupportedIdentity);
	});

	test("is rejected when made on start", async () => {
		const Tickets = repositoryOf({ entity: Ticket, actions: ["create"] });
		const app = applicationOf({
			name: "started",
			provider: providerFrom(() => withoutGeneratedIds()),
			entities: { Ticket },
			repositories: { Tickets },
		});
		const error = await app.start().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(UnsupportedIdentity);
		expect((error as Error).message).toContain("capabilities.generatedIds");
	});

	test("an insert that gives no id is rejected", async () => {
		const inner = inMemoryProvider();
		const Tickets = repositoryOf({
			entity: Ticket,
			actions: ["create"],
			provider: {
				...withoutGeneratedIds(),
				capabilities: { generatedIds: true },
				insert: async (context, data) => {
					await inner.insert(context, data);
				},
			},
		});
		await expect(Tickets.create({ title: "A" })).rejects.toThrow(
			UnsupportedIdentity,
		);
	});
});
