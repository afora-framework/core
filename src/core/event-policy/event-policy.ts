import type { CommandEventHandler } from "../command/types/command.interface";
import { frozenJson } from "../json";
import { Kind } from "../symbols/kind";
import { InvalidEventPolicy } from "./exceptions";
import type {
	EventPolicyDescription,
	EventPolicyFactory,
	EventPolicyOptions,
	EventPolicySettings,
	IEventPolicyCatalog,
} from "./types/event-policy.interface";

const described = new WeakMap<
	object,
	{
		readonly description: EventPolicyDescription;
		readonly publishers: readonly string[];
	}
>();
const factories = new WeakMap<object, string>();

function invalid(source: string, reason: string): never {
	throw new InvalidEventPolicy({ source, details: { reason } });
}

/** The frozen JSON options of the policy `name`. */
function optionsOf<Options extends object>(
	name: string,
	given: unknown,
	validate: ((options: Options) => string | undefined) | undefined,
): Options {
	const options = frozenJson(given ?? {}, "Event policy options", (reason) =>
		invalid(name, reason),
	);
	if (
		options === null ||
		typeof options !== "object" ||
		Array.isArray(options)
	) {
		invalid(name, "Event policy options must be an object.");
	}
	const reason = validate?.(options as Options);
	if (reason !== undefined) invalid(name, reason);
	return options as Options;
}

/**
 * A factory of event policies for the `events` setting of `commandOf`:
 * `events: publishEvents({ publisher: "realtime", topic: "posts/{id}" })`.
 * Its options are JSON, checked by `validate` when the policy is made (an
 * `InvalidEventPolicy` otherwise), so the policy can be written in an
 * `afora.json` and an application describes it by name and options instead
 * of `{ kind: "opaque" }`. `handle` gets the events of a call that succeeded,
 * what a handler policy gets, and the options.
 */
export function eventPolicyOf<Options extends object = EventPolicyOptions>(
	settings: EventPolicySettings<Options>,
): EventPolicyFactory<Options> {
	const name = settings?.name;
	if (typeof name !== "string" || !/^[A-Za-z_$][\w$]*$/.test(name)) {
		invalid("eventPolicyOf", "Expected the policy name to be an identifier.");
	}
	if (typeof settings.handle !== "function") {
		invalid(name, "Expected handle to be a function.");
	}
	if (
		settings.publishers !== undefined &&
		typeof settings.publishers !== "function"
	) {
		invalid(name, "Expected publishers to be a function.");
	}
	const { handle, validate, publishers } = settings;
	const factory = (given?: Options): CommandEventHandler => {
		const options = optionsOf(name, given, validate);
		const handler: CommandEventHandler = (events, info) =>
			handle(events, info, options);
		Object.defineProperty(handler, "name", { value: name });
		described.set(handler, {
			description: Object.freeze({
				kind: "policy" as const,
				name,
				options: options as EventPolicyOptions,
			}),
			publishers: Object.freeze([...(publishers?.(options) ?? [])]),
		});
		return handler;
	};
	factories.set(factory, name);
	return factory;
}

/**
 * The name and options of a policy made by `eventPolicyOf`; `undefined` for
 * any other value, such as a handler written by hand.
 */
export function eventPolicyDescriptionOf(
	handler: unknown,
): EventPolicyDescription | undefined {
	return typeof handler === "function"
		? described.get(handler)?.description
		: undefined;
}

/** The keys of the application `publishers` a policy uses; none for a handler written by hand. @internal */
export function eventPolicyPublishersOf(handler: unknown): readonly string[] {
	return typeof handler === "function"
		? (described.get(handler)?.publishers ?? [])
		: [];
}

/**
 * A catalog of event policy factories, by name: what resolves
 * `{ "policy": name, "options": {...} }` back to a policy. Throws
 * `InvalidEventPolicy` for a function that is not a factory made by
 * `eventPolicyOf` or for two with the same name.
 */
export function eventPolicyCatalogOf(
	...policies: readonly EventPolicyFactory<never>[]
): IEventPolicyCatalog {
	const byName: Record<string, EventPolicyFactory<never>> = {};
	for (const factory of policies) {
		const name = factories.get(factory);
		if (name === undefined) {
			invalid("catalog", "A catalog takes factories made by `eventPolicyOf`.");
		}
		if (Object.hasOwn(byName, name)) {
			invalid(name, "The catalog has another event policy with its name.");
		}
		byName[name] = factory;
	}
	return Object.freeze({
		[Kind]: "event-policy-catalog" as const,
		policies: Object.freeze(byName),
		resolve(name: string, options?: EventPolicyOptions): CommandEventHandler {
			const factory = Object.hasOwn(byName, name) ? byName[name] : undefined;
			if (!factory) invalid("catalog", `Unknown event policy "${name}".`);
			return (factory as (options?: EventPolicyOptions) => CommandEventHandler)(
				options,
			);
		},
	});
}
