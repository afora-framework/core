import type { Exception } from "../exception/exception";
import type { Issue, IssueCode } from "./types/parse.interface";

/**
 * What a step gives back, in place of a value, for a value it rejects; the
 * issues are then found where the step says, so a valid value costs no result
 * object.
 * @internal
 */
export const REJECTED: unique symbol = Symbol("rejected");

/** Who knows the exception an issue stands for, and builds it only when asked. */
export interface IssueOrigin {
	exception(): Exception;
}

/**
 * An issue whose `cause` is built the first time it is read, by its origin,
 * which keeps it: every issue of one origin has the same cause. Its own keys
 * are those of any issue, `cause` is not one of them.
 */
export class LazyIssue implements Issue {
	readonly message: string;
	readonly path: readonly (string | number)[];
	readonly code: IssueCode;
	readonly source: string;
	readonly #origin: IssueOrigin;

	constructor(
		message: string,
		path: readonly (string | number)[],
		code: IssueCode,
		source: string,
		origin: IssueOrigin,
	) {
		this.message = message;
		this.path = path;
		this.code = code;
		this.source = source;
		this.#origin = origin;
	}

	get cause(): Exception {
		return this.#origin.exception();
	}

	/** A copy of the issue at `path`, with the same cause. */
	at(path: readonly (string | number)[]): LazyIssue {
		return new LazyIssue(
			this.message,
			path,
			this.code,
			this.source,
			this.#origin,
		);
	}
}

/** A copy of `issue` at `path`, with the same `cause`, built lazily or not. */
export function movedIssue(
	issue: Issue,
	path: readonly (string | number)[],
): Issue {
	if (issue instanceof LazyIssue) return issue.at(path);
	const moved = { ...issue, path };
	const cause = Object.getOwnPropertyDescriptor(issue, "cause");
	if (cause && !cause.enumerable) Object.defineProperty(moved, "cause", cause);
	return moved;
}
