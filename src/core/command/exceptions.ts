import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";
import type { Issue } from "../parse/types/parse.interface";

/** `commandOf` got a setting it cannot use; `details.reason` says which. */
export const InvalidCommandDeclaration = exceptionOf({
	layer: ExceptionLayers.Command,
	name: "InvalidCommandDeclaration",
	message: ({ reason }: { readonly reason: string }) => reason,
});

/** A command was asked for an operation it does not declare. */
export const UnknownCommandOperation = exceptionOf({
	layer: ExceptionLayers.Command,
	name: "UnknownCommandOperation",
	message: ({ operation }: { readonly operation: string }) =>
		`Unknown command operation "${operation}".`,
});

/** The context of a call does not fit the context blueprint of the command. */
export const InvalidCommandContext = exceptionOf({
	layer: ExceptionLayers.Command,
	name: "InvalidCommandContext",
	message: (_details: { readonly issues: readonly Issue[] }) =>
		"Invalid Command context.",
});

/**
 * The `env` of a call holds a key no environment of the command declares, or
 * a value its blueprint rejects. It is configuration, not input.
 */
export const InvalidCommandEnvironment = exceptionOf({
	layer: ExceptionLayers.Command,
	name: "InvalidCommandEnvironment",
	message: (_details: {
		readonly keys: readonly string[];
		readonly issues: readonly Issue[];
	}) => "Invalid Command environment.",
});

/**
 * An event handler failed after the call succeeded (and, with a
 * transaction, committed). `handled` events ran before the failure and
 * `remaining` events after it were not handled.
 */
export const CommandEventFailed = exceptionOf({
	layer: ExceptionLayers.Command,
	name: "CommandEventFailed",
	message: ({
		operation,
		event,
	}: {
		readonly operation: string;
		/** The failed event; absent when a handler policy failed. */
		readonly event?: string;
		readonly handled: number;
		readonly remaining: number;
	}) =>
		event === undefined
			? `The event handler of "${operation}" failed after the call succeeded.`
			: `The event "${event}" of "${operation}" failed after the call succeeded.`,
});
