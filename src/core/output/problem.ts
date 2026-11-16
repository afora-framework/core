import { Exception } from "../exception/exception";
import type { Issue } from "../parse/types/parse.interface";
import { takeStatus } from "../use-case/status";
import { isDeclaredError, isInternalError, raisedOf } from "./status";
import type { Problem, ProblemOptions } from "./types/output.interface";

/** The media type of a problem response. */
export const PROBLEM_MEDIA_TYPE = "application/problem+json";

const INTERNAL = "Internal error.";

/**
 * An RFC 9457 problem for `error`. `issues` (`path`, `code`, `message`; no
 * values or causes) is present only for a 400, `trace` only with `debug`,
 * and the `detail` of a 5xx is `"Internal error."` unless `debug` is set or
 * the output declares the exception (its name in `statuses`, or a class of
 * `operation.errors`, except afora's internal ones), so internal messages do not leak.
 * An internal exception (`InvalidUseCaseResponse`, `InvalidUseCaseStep`, ...)
 * is masked and has no `issues` at any status, even one `statuses` chose,
 * unless `debug` is set.
 */
export function problemOf(error: unknown, options: ProblemOptions): Problem {
	const { status, debug = false, statuses, operation } = options;
	const exception = error instanceof Exception ? error : undefined;
	const title = exception?.name ?? "UnexpectedError";
	const message =
		exception?.message ??
		(error instanceof Error ? error.message : String(error));
	const raised = exception && raisedOf(exception);
	const masked = !debug && isInternalError(error);
	const rawIssues = (raised?.details as { issues?: unknown } | undefined)
		?.issues;
	const issues =
		status === 400 && !masked && Array.isArray(rawIssues)
			? (rawIssues as readonly Issue[]).map((issue) => ({
					path: [...issue.path],
					code: issue.code as string,
					message: issue.message,
				}))
			: undefined;
	return {
		type: `urn:afora:exception:${title}`,
		title,
		status,
		detail:
			masked ||
			(status >= 500 && !debug && !isDeclaredError(error, operation, statuses))
				? INTERNAL
				: message,
		...(raised ? { layer: raised.layer } : {}),
		...(issues ? { issues } : {}),
		...(debug
			? { trace: exception ? exception.toString() : String(error) }
			: {}),
	};
}

/**
 * The JSON a sink sends: `JSON.parse(JSON.stringify(value))`. Every record
 * goes through its `toJSON`, so sensitive values are always masked. A
 * status chosen with `withStatus` is not part of the value: a sink that does
 * not speak HTTP ignores it.
 */
export function outputValueOf(value: unknown): unknown {
	const text = JSON.stringify(takeStatus(value).body);
	return text === undefined ? undefined : JSON.parse(text);
}
