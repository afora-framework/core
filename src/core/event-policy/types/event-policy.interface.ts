import type {
	CommandEventHandler,
	CommandEventInfo,
} from "../../command/types/command.interface";
import type { JsonValue } from "../../json";
import type { Kind } from "../../symbols/kind";

/** The options of an event policy: JSON, so it can live in an `afora.json`. */
export type EventPolicyOptions = { readonly [key: string]: JsonValue };

/** What `eventPolicyOf` takes. */
export interface EventPolicySettings<
	Options extends object = EventPolicyOptions,
> {
	/** The name the policy is known by in a catalog and in `afora.json`. */
	readonly name: string;
	/** Why `options` cannot be used, or `undefined` when they can. */
	readonly validate?: (options: Options) => string | undefined;
	/** The handler a command awaits with the events of a call that succeeded. */
	readonly handle: (
		events: Parameters<CommandEventHandler>[0],
		info: CommandEventInfo,
		options: Options,
	) => void | Promise<void>;
	/** The keys of the application `publishers` the policy uses, so an application checks them when declared. */
	readonly publishers?: (options: Options) => readonly string[];
}

/**
 * Makes an event policy for the `events` setting of `commandOf`: a
 * `CommandEventHandler` that remembers its name and options.
 */
export type EventPolicyFactory<Options extends object = EventPolicyOptions> = (
	options?: Options,
) => CommandEventHandler;

/** How an event policy made by a factory is described: by name and options. */
export interface EventPolicyDescription {
	readonly kind: "policy";
	readonly name: string;
	readonly options: EventPolicyOptions;
}

/** Event policy factories by name: what resolves `{ "policy": name, "options": {...} }` of an `afora.json`. */
export interface IEventPolicyCatalog {
	readonly [Kind]: "event-policy-catalog";
	readonly policies: Readonly<Record<string, EventPolicyFactory<never>>>;
	/** Makes the policy `name` with `options`; throws `InvalidEventPolicy` for an unknown name or invalid options. */
	resolve(name: string, options?: EventPolicyOptions): CommandEventHandler;
}

/** An event as a publisher receives it: JSON, the entity masked by its `toJSON`. */
export interface PublishedEvent {
	/** The name given to `eventOf`. */
	readonly name: string;
	readonly command: string;
	readonly operation: string;
	/** The entity as JSON: sensitive values are masked. */
	readonly entity: JsonValue;
}

/**
 * Where published events go: a WebSocket hub, a queue, a broker. Declared
 * under a key in `applicationOf({ publishers })`.
 */
export interface IEventPublisher {
	publish(topic: string, event: PublishedEvent): void | Promise<void>;
}

/** The options of the `publishEvents` policy. */
export interface PublishEventsOptions {
	/** The key of the publisher in `applicationOf({ publishers })`. */
	readonly publisher: string;
	/**
	 * The topic of each event. `{event}`, `{command}`, `{operation}` and
	 * `{id}` (the id of the entity) are replaced: `"posts/{id}"`.
	 */
	readonly topic: string;
	/** The names of the events to publish; all of them by default. */
	readonly events?: readonly string[];
	/** Whether each event runs its own handler first, as `"after-commit"` does. `true` by default. */
	readonly handle?: boolean;
	/**
	 * What a failed publish does: `"log"` (default) writes an error to the
	 * logger and goes on, since the call already committed; `"throw"` makes
	 * the call fail with `CommandEventFailed`.
	 */
	readonly onPublishError?: "log" | "throw";
}
