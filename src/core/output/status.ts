import { Exception } from "../exception/exception";
import type {
	OperationDescriptor,
	OutputStatuses,
} from "./types/output.interface";

const INVALID_INPUT = new Set([
	"InvalidUseCaseInput",
	"InvalidUseCaseContext",
	"InvalidCommandContext",
]);
const NOT_FOUND = new Set([
	"RepositoryEntityNotFound",
	"UnknownCommandOperation",
]);

/**
 * The exception that raised `error` under its name: a use case or a command
 * passes an exception up as a copy with the same name, no details and the
 * original as its cause, so the original is the deepest one with that name.
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
 * The HTTP-style status of an error, in this order: `statuses` by exception
 * name; 400 for invalid input or context (and any exception whose
 * `details.issues` is a list); 404 for a missing entity or operation; 409 for
 * a unique violation; 422 for a class in `operation.errors`; 500 for the
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
	if (
		Array.isArray(
			(raisedOf(error).details as { issues?: unknown } | undefined)?.issues,
		)
	) {
		return 400;
	}
	if (NOT_FOUND.has(name)) return 404;
	if (name === "RepositoryUniqueViolation") return 409;
	if (
		operation?.errors.some(
			(Declared) => error.is(Declared) || Declared.name === name,
		)
	) {
		return 422;
	}
	return 500;
}
