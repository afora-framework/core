import { Exception } from "./exception";
import type { ExceptionScope } from "./types/exception.interface";

/**
 * Handles what `run` throws, or rejects with, in `scope`. Without `resolve`,
 * or when it calls `pass`, the exception goes up to the next layer with its
 * trace; otherwise `resolve` returns the value to use instead.
 */
export function guard<Result>(
	scope: ExceptionScope,
	run: () => Result,
	resolve?: (
		exception: Exception,
		pass: () => never,
	) => Result | Awaited<Result>,
): Result {
	const handle = (error: unknown) => {
		const exception = Exception.from(error, scope);
		const pass = (): never => {
			// An error wrapped by `from` is already in `scope`.
			throw exception === error ? exception.propagate(scope) : exception;
		};

		return resolve ? resolve(exception, pass) : pass();
	};

	try {
		const result = run();
		return (
			result instanceof Promise ? result.catch(handle) : result
		) as Result;
	} catch (error) {
		return handle(error) as Result;
	}
}
