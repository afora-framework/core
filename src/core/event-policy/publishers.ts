import { startedApplication } from "../application/registry";
import { PublisherNotBound } from "./exceptions";
import type { IEventPublisher } from "./types/event-policy.interface";

/** The publishers of an application, by key. */
export type Publishers = Readonly<Record<string, IEventPublisher>>;

/**
 * Carries the publishers of an application, when it declares any: on the
 * application itself. @internal
 */
export const ApplicationPublishersKey: unique symbol = Symbol(
	"afora.application.publishers",
);

/** The publishers of the application that bound a command, by command. */
const boundPublishers = new WeakMap<object, Publishers>();

/** Gives `command` the publishers of the application that bound it. @internal */
export function bindPublishers(command: object, publishers: Publishers): void {
	boundPublishers.set(command, publishers);
}

/** Whether `value` can publish: an object with a `publish` function. @internal */
export function isEventPublisher(value: unknown): value is IEventPublisher {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { publish?: unknown }).publish === "function"
	);
}

/**
 * The publisher `name` for a call of `command`: one of the application that
 * bound the command, else one of the started application. Throws
 * `PublisherNotBound` when neither declares it. @internal
 */
export function resolvePublisher(
	command: object,
	name: string,
	source: string,
): IEventPublisher {
	const publishers =
		boundPublishers.get(command) ??
		(
			startedApplication() as
				| { readonly [ApplicationPublishersKey]?: Publishers }
				| undefined
		)?.[ApplicationPublishersKey];
	const publisher =
		publishers && Object.hasOwn(publishers, name)
			? publishers[name]
			: undefined;
	if (!publisher) {
		throw new PublisherNotBound({ source, details: { publisher: name } });
	}
	return publisher;
}
