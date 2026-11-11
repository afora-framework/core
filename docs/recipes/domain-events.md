# Publishing domain events

When an order is placed, something outside the app (a queue, a WebSocket hub, a mailer) has to hear about it, once the order is saved.

```ts
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
```

An entity queues events (`onCreate` here, queued only when the order is built, not when it is loaded). Nothing runs them by itself: a command decides. `publishEvents` runs after the call succeeded and committed, and sends `{ name, command, operation, entity }` to the topic, where `entity` is the entity as JSON, so sensitive values are masked. The publisher is any object with `publish(topic, event)`, registered by key in `applicationOf({ publishers })`; the command names it.

In a test, give `memoryPublisher()` of `@afora/core/testing` as the publisher and read its `published` list. If a publish fails, the call has already committed, so by default the failure is logged (`event-publish-failed`) and the next event goes on; `onPublishError: "throw"` makes it a `CommandEventFailed`.

More: [Entities](../entities.md) (events), [Commands](../commands.md#event-policies), [Applications](../applications.md), [`@afora/ws`](../../packages/ws/README.md) (a hub as publisher).
