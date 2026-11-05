import type { Exception } from "../exception/exception";
import type { Issue } from "./types/parse.interface";

/** `issue` with a `cause` that is built the first time it is read, and kept. */
export function withLazyCause(issue: Issue, build: () => Exception): Issue {
	let cause: Exception | undefined;
	return Object.defineProperty(issue, "cause", {
		get: () => {
			cause ??= build();
			return cause;
		},
		enumerable: false,
		configurable: true,
	});
}

/** A copy of `issue` at `path`, with the same `cause`, built lazily or not. */
export function movedIssue(
	issue: Issue,
	path: readonly (string | number)[],
): Issue {
	const moved = { ...issue, path };
	const cause = Object.getOwnPropertyDescriptor(issue, "cause");
	if (cause && !cause.enumerable) Object.defineProperty(moved, "cause", cause);
	return moved;
}
