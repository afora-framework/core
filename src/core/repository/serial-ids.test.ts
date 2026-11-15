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
	repositoryOf,
	Serial,
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

	test("create assigns increasing ids, skipping those in use", async () => {
		const Tickets = repositoryOf({
			entity: Ticket,
			actions: ["create", "findById", "delete", "findMany"],
		});
		const first = await Tickets.create({ title: "First" });
		expect(first.id).toBe(1);
		await Tickets.create(new Ticket({ id: 2, title: "Given" }));
		const third = await Tickets.create(new Ticket({ title: "Third" }));
		expect(third.id).toBe(3);
		expect((await Tickets.findById(3))?.title).toBe("Third");
		await Tickets.delete(3);
		// As a sequence, an id is never given twice.
		expect((await Tickets.create({ title: "Fourth" })).id).toBe(4);
		expect((await Tickets.findMany()).map((ticket) => ticket.id)).toEqual([
			1, 2, 4,
		]);
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
