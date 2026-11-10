import type {
	IEventPublisher,
	PublishedEvent,
} from "../core/event-policy/types/event-policy.interface";

/** A publisher that keeps what it is given, for tests. */
export interface MemoryPublisher extends IEventPublisher {
	/** Each publish, in order. */
	readonly published: readonly {
		readonly topic: string;
		readonly event: PublishedEvent;
	}[];
	/** Forgets what was published. */
	clear(): void;
}

/**
 * A publisher for `applicationOf({ publishers })` in tests: it keeps each
 * `{ topic, event }` it is given in `published`.
 */
export function memoryPublisher(): MemoryPublisher {
	const published: { topic: string; event: PublishedEvent }[] = [];
	return {
		published,
		publish(topic, event) {
			published.push({ topic, event });
		},
		clear() {
			published.length = 0;
		},
	};
}
