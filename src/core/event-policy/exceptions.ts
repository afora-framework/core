import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";

/** `eventPolicyOf`, a policy's options or a catalog got something it cannot use; `details.reason` says what. */
export const InvalidEventPolicy = exceptionOf({
	layer: ExceptionLayers.Event,
	name: "InvalidEventPolicy",
	message: ({ reason }: { readonly reason: string }) => reason,
});

/**
 * An event policy asked for a publisher that neither the application that
 * bound the command nor the started application declares.
 */
export const PublisherNotBound = exceptionOf({
	layer: ExceptionLayers.Application,
	name: "PublisherNotBound",
	message: ({ publisher }: { readonly publisher: string }) =>
		`No publisher "${publisher}" is declared: add it to applicationOf({ publishers }).`,
});
