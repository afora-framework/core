import { ExceptionLayers, exceptionOf } from "@afora/core";

/** A message that is not a frame of the protocol (400); `details.reason` says why. */
export const InvalidWsMessage = exceptionOf({
	layer: ExceptionLayers.Output,
	name: "InvalidWsMessage",
	message: ({ reason }: { readonly reason: string }) => reason,
});

/** A subscription the topics of the options or `authorize` refuse (403). */
export const WsTopicForbidden = exceptionOf({
	layer: ExceptionLayers.Output,
	name: "WsTopicForbidden",
	message: ({ topic }: { readonly topic: string }) =>
		`Subscribing to "${topic}" is not allowed.`,
});

/** A subscription sent where there is no hub: `handle`, or a session without one (501). */
export const WsSubscriptionsUnavailable = exceptionOf({
	layer: ExceptionLayers.Output,
	name: "WsSubscriptionsUnavailable",
	message: "Subscriptions need a session with a hub.",
});
