import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	applicationOf,
	blueprintOf,
	commandOf,
	type EntityEvent,
	type EventDefinition,
	entityOf,
	environmentOf,
	eventOf,
	InvalidUseCaseDeclaration,
	InvalidUseCaseDependencies,
	inMemoryProvider,
	Logger,
	repositoryOf,
	ServiceNotBound,
	serviceOf,
	UnusedUseCaseReplacement,
	type UseCaseExecution,
	useCaseOf,
} from "../../index";

// PlaceOrder → ReserveStock → Stock, and PlaceOrder → SendReceipt → Mailer,
// Settings and Logger. Made anew for each application that binds them.
function declarations() {
	class Item extends entityOf(
		blueprintOf((ctx) => ({ sku: ctx.string })),
		{
			onCreate: () => ItemAdded,
		},
	) {}
	// The annotation avoids a circular inference between the entity and its event.
	const ItemAdded: EventDefinition = eventOf("item.added", Item);
	const Stock = repositoryOf({ entity: Item, actions: ["findById", "create"] });
	const Mailer = serviceOf<{ send(to: string): Promise<boolean> }>("mailer");
	const Settings = environmentOf(
		blueprintOf((ctx) => ({ RECEIPT_FROM: ctx.email })),
		{ source: () => ({ RECEIPT_FROM: "shop@example.com" }) },
	);

	class ReserveStock extends useCaseOf({
		name: "ReserveStock",
		blueprint: blueprintOf((ctx) => ({ id: ctx.string })),
		response: blueprintOf((ctx) => ({ reserved: ctx.boolean })),
		dependencies: { Stock },
	}) {
		override async execute({ Stock = this.dependencies.Stock } = {}) {
			return { reserved: (await Stock.findById(this.input.id)) !== undefined };
		}
	}

	class SendReceipt extends useCaseOf({
		name: "SendReceipt",
		blueprint: blueprintOf((ctx) => ({ to: ctx.email })),
		response: blueprintOf((ctx) => ({ sent: ctx.boolean, from: ctx.string })),
		dependencies: { mailer: Mailer, settings: Settings, logger: Logger },
	}) {
		override async execute({
			mailer = this.dependencies.mailer,
			settings = this.dependencies.settings,
			logger = this.dependencies.logger,
		} = {}) {
			logger.info("receipt", { to: this.input.to });
			return {
				sent: await mailer.send(this.input.to),
				from: settings.RECEIPT_FROM,
			};
		}
	}

	class PlaceOrder extends useCaseOf({
		name: "PlaceOrder",
		blueprint: blueprintOf((ctx) => ({ id: ctx.string, email: ctx.email })),
		response: blueprintOf((ctx) => ({
			reserved: ctx.boolean,
			sent: ctx.boolean,
			from: ctx.string,
		})),
		dependencies: { reserve: ReserveStock, receipt: SendReceipt },
	}) {
		override async execute({
			reserve = this.dependencies.reserve,
			receipt = this.dependencies.receipt,
		} = {}) {
			const { reserved } = await reserve({ id: this.input.id });
			const { sent, from } = await receipt({ to: this.input.email });
			return { reserved, sent, from };
		}
	}
	return {
		Item,
		Stock,
		Mailer,
		Settings,
		ReserveStock,
		SendReceipt,
		PlaceOrder,
	};
}

const { Item, Stock, Mailer, Settings, ReserveStock, PlaceOrder } =
	declarations();

const order = { id: "item-1", email: "ana@example.com" };
const item = new Item({ sku: "A-1" });
const fakeStock = { findById: async () => item };
const fakeMailer = { send: async () => true };

describe("UseCase.run", () => {
	test("runs a new instance each time and gives the response", async () => {
		const first = await ReserveStock.run({ id: "x" });
		const second = await ReserveStock.run({ id: "x" });
		expect(first).toEqual({ reserved: false });
		expect(second).toEqual({ reserved: false });
		expectTypeOf(first).toEqualTypeOf<{ reserved: boolean }>();
	});

	test("takes the overrides of execute", async () => {
		expect(
			await ReserveStock.run(
				{ id: "x" },
				{ dependencies: { Stock: fakeStock } },
			),
		).toEqual({ reserved: true });
	});

	test("with events: true, gives the response and the events", async () => {
		class AddItem extends useCaseOf({
			name: "AddItem",
			blueprint: blueprintOf((ctx) => ({ sku: ctx.string })),
			response: blueprintOf(() => ({ item: Item })),
			dependencies: { Stock },
		}) {
			override async execute({ Stock = this.dependencies.Stock } = {}) {
				return { item: await Stock.create(new Item(this.input)) };
			}
		}
		const result = await AddItem.run({ sku: "B-2" }, { events: true });
		expectTypeOf(result).toEqualTypeOf<
			UseCaseExecution<{ item: InstanceType<typeof Item> }>
		>();
		expect(result.value.item.sku).toBe("B-2");
		expect(result.events.map((event: EntityEvent) => event.name)).toEqual([
			"item.added",
		]);
		// Without it, the response only.
		const value = await AddItem.run({ sku: "C-3" });
		expect(value.item.sku).toBe("C-3");
	});

	test("takes the context of a use case that declares one", async () => {
		class Whoami extends useCaseOf({
			name: "Whoami",
			blueprint: blueprintOf(() => ({})),
			response: blueprintOf((ctx) => ({ user: ctx.string })),
			context: blueprintOf((ctx) => ({ user: ctx.string })),
		}) {
			override async execute() {
				return { user: this.context.user };
			}
		}
		expect(await Whoami.run({}, { context: { user: "ana" } })).toEqual({
			user: "ana",
		});
		// @ts-expect-error the context is required
		await expect(Whoami.run({})).rejects.toThrow(/Invalid UseCase context/);
	});

	test("runs a steps use case", async () => {
		const Check = useCaseOf({
			name: "Check",
			blueprint: blueprintOf((ctx) => ({ id: ctx.string })),
			response: blueprintOf((ctx) => ({ reserved: ctx.boolean })),
			dependencies: { reserve: ReserveStock },
			steps: [
				{ call: "reserve", input: "$input", as: "result" },
				{ return: "$result" },
			],
		});
		expect(await Check.run({ id: "x" })).toEqual({ reserved: false });
		expect(
			await Check.run({ id: "x" }, { replace: [[Stock, fakeStock]] }),
		).toEqual({ reserved: true });
	});

	test("cannot run the abstract class useCaseOf gives", async () => {
		const Base = useCaseOf({
			name: "Base",
			blueprint: blueprintOf(() => ({})),
			response: blueprintOf(() => ({})),
		});
		await expect(Base.run()).rejects.toBeInstanceOf(InvalidUseCaseDeclaration);
	});
});

describe("replace", () => {
	test("reaches the use cases of the graph that declare each declaration", async () => {
		const response = await PlaceOrder.run(order, {
			replace: [
				[Stock, fakeStock],
				[Mailer, fakeMailer],
			],
		});
		expect(response).toEqual({
			reserved: true,
			sent: true,
			from: "shop@example.com",
		});
	});

	test("replaces environments, the logger and use cases", async () => {
		const lines: unknown[] = [];
		const logger = {
			debug() {},
			info: (message: string) => lines.push(message),
			warn() {},
			error() {},
		};
		const response = await PlaceOrder.run(order, {
			replace: [
				[ReserveStock, async () => ({ reserved: true })],
				[Mailer, fakeMailer],
				[Settings, { RECEIPT_FROM: "orders@example.com" }],
				[Logger, logger],
			],
		});
		expect(response).toEqual({
			reserved: true,
			sent: true,
			from: "orders@example.com",
		});
		expect(lines).toEqual(["receipt"]);
	});

	test("checks a replaced use case like a direct override", async () => {
		await expect(
			PlaceOrder.run(order, {
				replace: [
					// @ts-expect-error the response does not fit
					[ReserveStock, async () => ({ reserved: "yes" })],
					[Mailer, fakeMailer],
				],
			}),
		).rejects.toThrow(/Invalid UseCase response/);
	});

	test("rejects the wrong kind of value, a duplicate or what is not a pair", async () => {
		const wrong: unknown[] = [
			[[Stock, "not methods"]],
			[[ReserveStock, { reserved: true }]],
			[[Settings, { RECEIPT_FROM: "not an email" }]],
			[[Logger, {}]],
			[[{}, {}]],
			[[Stock]],
			[
				[Stock, fakeStock],
				[Stock, fakeStock],
			],
			"Stock",
		];
		for (const replace of wrong) {
			await expect(
				PlaceOrder.run(order, { replace: replace as never }),
			).rejects.toBeInstanceOf(InvalidUseCaseDependencies);
		}
	});

	test("rejects a replacement no use case of the call declares", async () => {
		const Other = repositoryOf({ entity: Item, actions: ["findById"] });
		const Unrelated = serviceOf<string>("unrelated");
		const error = await PlaceOrder.run(order, {
			replace: [
				[Stock, fakeStock],
				[Unrelated, "x"],
			],
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(UnusedUseCaseReplacement);
		expect(
			(error as InstanceType<typeof UnusedUseCaseReplacement>).details,
		).toEqual({ replacements: ['the service "unrelated"'] });
		// Another repository of the same entity is another declaration.
		await expect(
			ReserveStock.run({ id: "x" }, { replace: [[Other, fakeStock]] }),
		).rejects.toBeInstanceOf(UnusedUseCaseReplacement);
		// The use case called is not a dependency of itself.
		await expect(
			ReserveStock.run(
				{ id: "x" },
				{ replace: [[ReserveStock, async () => ({ reserved: true })]] },
			),
		).rejects.toBeInstanceOf(UnusedUseCaseReplacement);
	});

	test("counts as unused what only a replaced use case declares", async () => {
		await expect(
			PlaceOrder.run(order, {
				replace: [
					[ReserveStock, async () => ({ reserved: true })],
					[Stock, fakeStock],
				],
			}),
		).rejects.toBeInstanceOf(UnusedUseCaseReplacement);
		await expect(
			PlaceOrder.run(order, {
				dependencies: { reserve: async () => ({ reserved: true }) },
				replace: [[Stock, fakeStock]],
			}),
		).rejects.toBeInstanceOf(UnusedUseCaseReplacement);
	});

	test("leaves the direct overrides first", async () => {
		const response = await PlaceOrder.run(order, {
			dependencies: { reserve: async () => ({ reserved: false }) },
			replace: [[Mailer, fakeMailer]],
		});
		expect(response.reserved).toBe(false);
		expect(response.sent).toBe(true);
	});

	test("without a replacement, a nested service stays unbound", async () => {
		await expect(
			PlaceOrder.run(order, { replace: [[Stock, fakeStock]] }),
		).rejects.toBeInstanceOf(ServiceNotBound);
	});

	test("types each replacement from its declaration", () => {
		expectTypeOf(PlaceOrder.run).toBeFunction();
		// The parameters of a replacement are typed by the declaration.
		void (() =>
			PlaceOrder.run(order, {
				replace: [
					[Stock, { findById: async (id) => (id === "x" ? item : undefined) }],
					[ReserveStock, async (input) => ({ reserved: input.id === "x" })],
					[Mailer, { send: async (to) => to.length > 0 }],
				],
			}));
		void (() =>
			PlaceOrder.run(order, {
				// @ts-expect-error not a method of the repository
				replace: [[Stock, { nope: async () => item }]],
			}));
	});
});

describe("replace through an application and a command", () => {
	const {
		Item,
		Stock,
		Mailer,
		Settings,
		ReserveStock,
		SendReceipt,
		PlaceOrder,
	} = declarations();
	const item = new Item({ sku: "A-1" });
	const fakeStock = { findById: async () => item };
	const App = applicationOf({
		name: "shop",
		provider: inMemoryProvider(),
		entities: { Item },
		environments: { Settings },
		repositories: { Stock },
		useCases: { PlaceOrder, ReserveStock, SendReceipt },
		services: { mailer: () => ({ send: async () => false }) },
	});

	test("app.run replaces the bound declarations by the declared ones", async () => {
		expect(
			await App.run(PlaceOrder, order, {
				replace: [
					[Stock, fakeStock],
					[Mailer, fakeMailer],
				],
			}),
		).toEqual({ reserved: true, sent: true, from: "shop@example.com" });
		// The bound repository names the same declaration.
		expect(
			await App.run(PlaceOrder, order, {
				replace: [[App.repositories.Stock, fakeStock]],
			}),
		).toEqual({ reserved: true, sent: false, from: "shop@example.com" });
		await expect(
			App.run(PlaceOrder, order, {
				replace: [[serviceOf<string>("other"), "x"]],
			}),
		).rejects.toBeInstanceOf(UnusedUseCaseReplacement);
	});

	test("the static run of a bound use case runs over the application", async () => {
		expect(
			await App.useCases.PlaceOrder.run(order, {
				replace: [[ReserveStock, async () => ({ reserved: true })]],
			}),
		).toEqual({ reserved: true, sent: false, from: "shop@example.com" });
	});

	test("command.run and command.execute take the same replace", async () => {
		const {
			Item,
			Stock,
			Mailer,
			Settings,
			ReserveStock,
			SendReceipt,
			PlaceOrder,
		} = declarations();
		const item = new Item({ sku: "A-1" });
		const fakeStock = { findById: async () => item };
		const Orders = commandOf({
			name: "orders",
			useCases: { place: PlaceOrder },
		});
		const Bound = applicationOf({
			name: "orders-app",
			provider: inMemoryProvider(),
			entities: { Item },
			environments: { Settings },
			repositories: { Stock },
			useCases: { PlaceOrder, ReserveStock, SendReceipt },
			commands: { orders: Orders },
			services: { mailer: () => ({ send: async () => false }) },
		}).command(Orders);
		expect(
			await Bound.run("place", order, { replace: [[Stock, fakeStock]] }),
		).toEqual({ reserved: true, sent: false, from: "shop@example.com" });
		const { value } = await Bound.execute("place", order, {
			replace: [
				[Stock, fakeStock],
				[Mailer, fakeMailer],
			],
		});
		expect(value).toEqual({
			reserved: true,
			sent: true,
			from: "shop@example.com",
		});
		await expect(
			Bound.run("place", order, {
				replace: [[serviceOf<string>("other"), "x"]],
			}),
		).rejects.toBeInstanceOf(UnusedUseCaseReplacement);
		await expect(
			Orders.run("place", order, { replace: [[Stock, "x" as never]] }),
		).rejects.toBeInstanceOf(InvalidUseCaseDependencies);
	});
});
