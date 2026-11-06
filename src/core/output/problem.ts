import { Exception } from "../exception/exception";
import type { Issue } from "../parse/types/parse.interface";
import type { Problem, ProblemOptions } from "./types/output.interface";

/** The media type of a problem response. */
export const PROBLEM_MEDIA_TYPE = "application/problem+json";

const INTERNAL = "Internal error.";

/**
 * An RFC 9457 problem for `error`. `issues` (`path`, `code`, `message`; no
 * values or causes) is present only for a 400, `trace` only with `debug`,
 * and the `detail` of a 5xx is `"Internal error."` unless `debug` is set, so
 * internal messages do not leak.
 */
export function problemOf(error: unknown, options: ProblemOptions): Problem {
	const { status, debug = false } = options;
	const exception = error instanceof Exception ? error : undefined;
	const title = exception?.name ?? "UnexpectedError";
	const message =
		exception?.message ??
		(error instanceof Error ? error.message : String(error));
	const rawIssues = (exception?.details as { issues?: unknown } | undefined)
		?.issues;
	const issues =
		status === 400 && Array.isArray(rawIssues)
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
		detail: status >= 500 && !debug ? INTERNAL : message,
		...(exception ? { layer: exception.layer } : {}),
		...(issues ? { issues } : {}),
		...(debug
			? { trace: exception ? exception.toString() : String(error) }
			: {}),
	};
}

/**
 * The JSON a sink sends: `JSON.parse(JSON.stringify(value))`. Every record
 * goes through its `toJSON`, so sensitive values are always masked.
 */
export function outputValueOf(value: unknown): unknown {
	const text = JSON.stringify(value);
	return text === undefined ? undefined : JSON.parse(text);
}
