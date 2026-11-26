import { Exception, UNEXPECTED_ERROR } from "../exception/exception";
import type {
	OperationDescriptor,
	OutputStatuses,
} from "./types/output.interface";

const INVALID_INPUT = new Set([
	"InvalidUseCaseInput",
	"InvalidUseCaseContext",
	"InvalidCommandContext",
]);
/** Configuration the call was given, not input: its issues are not the caller's. */
const CONFIGURATION = new Set(["InvalidCommandEnvironment"]);
/**
 * Exceptions whose message is never the caller's, even when the output lists
 * them: `UnexpectedError` carries the raw message of an error that is not an
 * exception (a driver, a provider, a bug), and the others say the server is
 * misconfigured or broke its own contract (a response that does not fit its
 * blueprint, a step that cannot run). Their `details.issues`, when they have
 * some, describe the server, not the call: they are a 500, never a 400.
 */
const INTERNAL = new Set([
	UNEXPECTED_ERROR,
	...CONFIGURATION,
	"InvalidEnvironment",
	"InvalidApplicationEnvironment",
	"InvalidUseCaseResponse",
	"InvalidUseCaseStep",
	"UndeclaredStatus",
]);

/** Whether `error` is one of afora's internal exceptions, never shown to the caller. */
export function isInternalError(error: unknown): boolean {
	return error instanceof Exception && INTERNAL.has(error.name);
}
const NOT_FOUND = new Set([
	"RepositoryEntityNotFound",
	"UnknownCommandOperation",
	"UseCaseEntityNotFound",
]);
const CONFLICT = new Set([
	"RepositoryUniqueViolation",
	"RepositoryConcurrencyConflict",
	"UseCaseEntityConflict",
	"RepositoryDeleteRestricted",
]);

/**
 * The exception that raised `error` under its name: a use case or a command
 * passes an exception up as a copy with the same name and the original as
 * its cause, so the original is the deepest one with that name.
 */
export function raisedOf(error: Exception): Exception {
	let raised = error;
	for (
		let current: unknown = error.cause;
		current instanceof Exception;
		current = current.cause
	) {
		if (current.name === error.name) raised = current;
	}
	return raised;
}

/**
 * Whether the output declares `error`, so the `detail` of its problem is kept
 * at any status: an exception whose name is in `statuses` or that matches a
 * class of `operation.errors` (by class or by name), afora's own exceptions
 * included when the output lists them, except the internal ones
 * (`UnexpectedError`, or any exception that carries its message,
 * `InvalidCommandEnvironment`, `InvalidEnvironment`,
 * `InvalidApplicationEnvironment`, `InvalidUseCaseResponse`,
 * `InvalidUseCaseStep`, `UndeclaredStatus`). Being made by
 * `exceptionOf` is not enough: afora's own exceptions are made by it too.
 */
export function isDeclaredError(
	error: unknown,
	operation?: Pick<OperationDescriptor, "errors">,
	statuses?: OutputStatuses,
): boolean {
	if (!(error instanceof Exception)) return false;
	const { name } = error;
	if (INTERNAL.has(name)) return false;
	// The raw message of a wrapped error, passed up under another name.
	const { origin } = error;
	if (origin.name === UNEXPECTED_ERROR && origin.message === error.message) {
		return false;
	}
	if (statuses && Object.hasOwn(statuses, name)) return true;
	return (
		operation?.errors.some(
			(Declared) => error.is(Declared) || Declared.name === name,
		) ?? false
	);
}

/**
 * The HTTP-style status of an error, in this order: `statuses` by exception
 * name; 400 for invalid input or context (and any exception whose
 * `details.issues` is a list, except the internal ones, such as
 * `InvalidUseCaseResponse`, `InvalidUseCaseStep` and
 * `InvalidCommandEnvironment`, a 500); 404 for a missing entity or operation; 409 for
 * a unique violation, a concurrency conflict, an entity that already exists
 * or a delete its children restrict; 401 for
 * `UseCaseInvalidCredentials` and `Unauthenticated`; 403 for `Forbidden`; 422 for a class in `operation.errors`; 500 for the
 * rest, errors that are not exceptions included. Exceptions match by name,
 * or by class for `operation.errors`.
 */
export function statusOf(
	error: unknown,
	operation?: Pick<OperationDescriptor, "errors">,
	statuses?: OutputStatuses,
): number {
	if (!(error instanceof Exception)) return 500;
	const { name } = error;
	if (statuses && Object.hasOwn(statuses, name))
		return statuses[name] as number;
	if (INVALID_INPUT.has(name)) return 400;
	// Issues of the server (its response, its steps, its configuration).
	if (INTERNAL.has(name)) return 500;
	if (
		Array.isArray(
			(raisedOf(error).details as { issues?: unknown } | undefined)?.issues,
		)
	) {
		return 400;
	}
	if (NOT_FOUND.has(name)) return 404;
	if (CONFLICT.has(name)) return 409;
	if (name === "UseCaseInvalidCredentials" || name === "Unauthenticated") {
		return 401;
	}
	if (name === "Forbidden") return 403;
	if (
		operation?.errors.some(
			(Declared) => error.is(Declared) || Declared.name === name,
		)
	) {
		return 422;
	}
	return 500;
}
