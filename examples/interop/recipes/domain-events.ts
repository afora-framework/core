import {
	applicationOf,
	blueprintOf,
	commandOf,
	type EventDefinition,
	entityOf,
	eventOf,
	publishEvents,
	repositoryOf,
} from "@afora/core";

// onCreate queues OrderPlaced when an order is built, not when it is loaded
export class Order extends entityOf(
	blueprintOf((ctx) => ({ item: ctx.text })),
	{ onCreate: () => OrderPlaced },
) {}

// No handler: the event only carries the order, for a policy to publish
const OrderPlaced: EventDefinition = eventOf("order.placed", Order);

const Orders = repositoryOf({
	entity: Order,
	actions: ["create", "findById"],
});

const Shop = commandOf({
	name: "Shop",
	useCases: (ctx) => ({ place: ctx.create(Orders) }),
	// after the call committed, send each event to the publisher "bus"
	events: publishEvents({ publisher: "bus", topic: "{command}/{event}" }),
});

// Anything with publish(topic, event) is a publisher: a queue, a broker, a hub
export const appWith = (bus: {
	publish(topic: string, event: unknown): void | Promise<void>;
}) =>
	applicationOf({
		name: "shop",
		entities: { Order },
		repositories: { Orders },
		commands: { Shop },
		publishers: { bus },
	});
