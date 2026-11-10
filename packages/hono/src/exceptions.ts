import { ExceptionLayers, exceptionOf } from "@afora/core";

/**
 * A webhook request whose signature is missing, malformed, expired or wrong
 * (401). The message never says which: `details.reason` does, and reaches
 * the caller only in the `trace` of a `debug` problem.
 */
export const InvalidWebhookSignature = exceptionOf({
	layer: ExceptionLayers.Output,
	name: "InvalidWebhookSignature",
	message: (_: { readonly scheme: string; readonly reason: string }) =>
		"The webhook signature is missing, invalid or expired.",
});

/** None of the variables that hold a webhook secret is set (500: configuration). */
export const WebhookSecretMissing = exceptionOf({
	layer: ExceptionLayers.Output,
	name: "WebhookSecretMissing",
	message: ({ variables }: { readonly variables: readonly string[] }) =>
		`No webhook secret is set (${variables.join(", ")}).`,
});
