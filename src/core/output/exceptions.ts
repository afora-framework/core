import { ExceptionLayers } from "../exception/enums/exception-layers";
import { exceptionOf } from "../exception/exception";

/** `outputOf`, an operation patch or a stage got something it cannot use; `details.reason` says what. */
export const InvalidOutputStage = exceptionOf({
	layer: ExceptionLayers.Output,
	name: "InvalidOutputStage",
	message: ({ reason }: { readonly reason: string }) => reason,
});

/** Two operations of an output share an id. */
export const DuplicateOperation = exceptionOf({
	layer: ExceptionLayers.Output,
	name: "DuplicateOperation",
	message: ({ id }: { readonly id: string }) =>
		`The operation "${id}" is declared twice.`,
});

/**
 * An operation that declares its `access` was called without an
 * authenticated caller: no credentials, or ones that were not accepted. A
 * 401.
 */
export const Unauthenticated = exceptionOf({
	layer: ExceptionLayers.Output,
	name: "Unauthenticated",
	message: "Authentication is required.",
});

/**
 * The caller is authenticated but may not call the operation: it lacks a
 * scope the `access` of the operation asks for (`details.reason` is
 * `"scope"`, with the missing `scopes`), or is not the owner (`"owner"`). A
 * 403.
 */
export const Forbidden = exceptionOf({
	layer: ExceptionLayers.Output,
	name: "Forbidden",
	message: (_details: {
		readonly reason: "scope" | "owner";
		readonly scopes?: readonly string[];
	}) => "The caller may not do this.",
});
