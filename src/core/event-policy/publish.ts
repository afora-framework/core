import { CommandEventFailed } from "../command/exceptions";
import type { EntityEvent } from "../entity/event";
import type { JsonValue } from "../json";
import { logFailure } from "../logger/logger";
import { eventPolicyOf } from "./event-policy";
import type {
	PublishEventsOptions,
	PublishedEvent,
} from "./types/event-policy.interface";

const KEYS = ["publisher", "topic", "events", "handle", "onPublishError"];
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const PLACEHOLDER = /\{(event|command|operation|id)\}/g;

function validate(options: PublishEventsOptions): string | undefined {
	const given = options as unknown as Record<string, unknown>;
	for (const key of Object.keys(given)) {
		if (!KEYS.includes(key)) return `publishEvents has no option "${key}".`;
	}
	const { publisher, topic, events, handle, onPublishError } = given;
	if (typeof publisher !== "string" || !IDENTIFIER.test(publisher)) {
		return "Expected publishEvents.publisher to be the key of a publisher of the application.";
	}
	if (typeof topic !== "string" || topic === "") {
		return 'Expected publishEvents.topic to be a non-empty string, such as "posts/{id}".';
	}
	const unknown = topic.replaceAll(PLACEHOLDER, "").match(/\{[^}]*\}/);
	if (unknown) {
		return `publishEvents.topic has an unknown placeholder ${unknown[0]}: use {event}, {command}, {operation} or {id}.`;
	}
	if (
		events !== undefined &&
		(!Array.isArray(events) ||
			events.some((name) => typeof name !== "string" || name === ""))
	) {
		return "Expected publishEvents.events to be a list of event names.";
	}
	if (handle !== undefined && typeof handle !== "boolean") {
		return "Expected publishEvents.handle to be a boolean.";
	}
	if (
		onPublishError !== undefined &&
		onPublishError !== "log" &&
		onPublishError !== "throw"
	) {
		return 'Expected publishEvents.onPublishError to be "log" or "throw".';
	}
	return undefined;
}

/** The entity of an event as JSON: its `toJSON` masks sensitive values. */
function entityJson(event: EntityEvent): JsonValue {
	const text = JSON.stringify(event.entity);
	return text === undefined ? null : (JSON.parse(text) as JsonValue);
}

/**
 * An event policy that publishes the events of a call to a publisher of the
 * application, once the call succeeded (and committed):
 * `events: publishEvents({ publisher: "realtime", topic: "posts/{id}" })`.
 *
 * For each event, in order, it runs the event's own handler first (unless
 * `handle: false`), then publishes `{ name, command, operation, entity }`
 * to the topic, the entity as JSON with sensitive values masked; the context
 * and the variables are never published. `events` limits it to some names.
 * A handler that fails stops the call with `CommandEventFailed`, as with
 * `"after-commit"`. A publish that fails is logged and skipped
 * (`onPublishError: "log"`, the default) or fails the call (`"throw"`). A
 * publisher the application does not declare fails the call, caused by
 * `PublisherNotBound`.
 */
export const publishEvents = eventPolicyOf<PublishEventsOptions>({
	name: "publishEvents",
	validate,
	publishers: (options) => [options.publisher],
	handle: async (events, info, options) => {
		const { command, operation, logger } = info;
		const commandName = command.commandName;
		const source = `${commandName}.${operation}`;
		const only = options.events ? new Set(options.events) : undefined;
		const failed = (cause: unknown, event: EntityEvent, index: number) =>
			new CommandEventFailed({
				source,
				cause,
				details: {
					operation,
					event: event.name,
					handled: index,
					remaining: events.length - index - 1,
				},
			});

		for (const [index, event] of events.entries()) {
			if (options.handle !== false) {
				try {
					await event.handle({ logger });
				} catch (cause) {
					throw failed(cause, event, index);
				}
			}
			if (only && !only.has(event.name)) continue;

			let publisher: ReturnType<typeof info.publisher>;
			try {
				publisher = info.publisher(options.publisher);
			} catch (cause) {
				throw failed(cause, event, index);
			}
			const entity = entityJson(event);
			const id = (entity as { id?: unknown } | null)?.id;
			const topic = options.topic.replaceAll(PLACEHOLDER, (_, key: string) =>
				key === "event"
					? event.name
					: key === "command"
						? commandName
						: key === "operation"
							? operation
							: id === undefined
								? ""
								: String(id),
			);
			const published: PublishedEvent = Object.freeze({
				name: event.name,
				command: commandName,
				operation,
				entity,
			});
			try {
				await publisher.publish(topic, published);
			} catch (cause) {
				if (options.onPublishError === "throw")
					throw failed(cause, event, index);
				logFailure(
					logger,
					"event-publish-failed",
					{
						command: commandName,
						operation,
						event: event.name,
						publisher: options.publisher,
						topic,
					},
					cause,
				);
			}
		}
	},
});
