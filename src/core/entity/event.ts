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

/** One queued occurrence, referencing the original entity rather than a snapshot. */
export interface EntityEvent<Entity = object> {
	readonly name: string;
	readonly entity: Entity;
	handle(): Promise<void>;
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
	handler: (entity: InstanceType<Class>) => Promise<void>,
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
			async handle(): Promise<void> {
				await handler(entity as InstanceType<Class>);
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
