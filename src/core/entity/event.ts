import { type ILogger, resolveLogger, silentLogger } from "../logger/logger";
import { isEntityClass } from "./entity";

/** A class made by `entityOf`, including subclasses. */
export const EntityClassBrand = Symbol("entityClass");
export type AnyEntityClass = (abstract new (
	value: never,
) => object) & { readonly [EntityClassBrand]: true };

const EventBrand = Symbol("event");

/** An immutable event declaration; only `eventOf` creates definitions. */
export interface EventDefinition {
	readonly name: string;
	readonly [EventBrand]: true;
}

/** What the handler of an event gets next to the entity. */
export interface EventHandlerContext {
	/**
	 * The logger of the application whose command raised the event; else the
	 * started application's; a logger that writes nothing without either.
	 */
	readonly logger: ILogger;
}

/** One queued occurrence, referencing the original entity rather than a snapshot. */
export interface EntityEvent<Entity = object> {
	readonly name: string;
	readonly entity: Entity;
	/** Runs the handler; `logger` replaces the one it would get. */
	handle(context?: Partial<EventHandlerContext>): Promise<void>;
}

export type EntityEventReference =
	| EventDefinition
	| readonly EventDefinition[]
	| (() => EventDefinition | readonly EventDefinition[]);

export interface EntityEvents {
	readonly onCreate?: EntityEventReference;
	readonly onUpdate?: EntityEventReference;
	readonly onDelete?: EntityEventReference;
}

export const EntityEventSettings = Symbol("entityEvents");

const definitions = new WeakMap<
	EventDefinition,
	(entity: object) => EntityEvent<object>
>();
const queues = new WeakMap<object, EntityEvent<object>[]>();

/** Defines an event without executing its handler. */
export function eventOf<Class extends AnyEntityClass>(
	name: string,
	entityClass: Class,
	handler: (
		entity: InstanceType<Class>,
		context: EventHandlerContext,
	) => Promise<void>,
): EventDefinition {
	if (!isEntityClass(entityClass)) {
		throw new TypeError("An event requires an entity class");
	}
	const event: EventDefinition = Object.freeze({
		name,
		[EventBrand]: true as const,
	});
	definitions.set(event, (entity) => {
		if (!(entity instanceof entityClass)) {
			throw new TypeError(`Incompatible entity for event ${name}`);
		}
		return Object.freeze({
			name,
			entity,
			async handle(context?: Partial<EventHandlerContext>): Promise<void> {
				await handler(entity as InstanceType<Class>, {
					logger:
						context?.logger ??
						resolveLogger(undefined, undefined) ??
						silentLogger,
				});
			},
		});
	});
	return event;
}

export function enqueueEvent(entity: object, event: EventDefinition): void {
	const bind = definitions.get(event);
	if (!bind) throw new TypeError("Expected an eventOf definition");
	const occurrence = bind(entity);
	const queue = queues.get(entity) ?? [];
	queue.push(occurrence);
	queues.set(entity, queue);
}

export function pullEntityEvents<Entity extends object>(
	entity: Entity,
): EntityEvent<Entity>[] {
	const queue = queues.get(entity) ?? [];
	queues.delete(entity);
	return queue as EntityEvent<Entity>[];
}

export function enqueueLifecycle(
	entity: object,
	cycle: keyof EntityEvents,
): void {
	const settings = (
		entity.constructor as unknown as {
			readonly [EntityEventSettings]: EntityEvents;
		}
	)[EntityEventSettings];
	const reference = settings?.[cycle];
	if (reference === undefined) return;
	const events = typeof reference === "function" ? reference() : reference;
	for (const event of Array.isArray(events) ? events : [events]) {
		enqueueEvent(entity, event);
	}
}
