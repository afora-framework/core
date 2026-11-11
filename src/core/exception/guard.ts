import { Exception } from "./exception";
import type { ExceptionScope } from "./types/exception.interface";

/**
 * Handles what `run` throws, or rejects with, in `scope` (see {@link ExceptionScope}). Without `resolve`,
 * or when it calls `pass`, the exception goes up to the next layer with its
 * trace; otherwise `resolve` returns the value to use instead.
 *
 * @throws {@link Exception} what `run` throws or rejects with, in `scope` and with its trace, unless `resolve` gives a value instead.
 *
 * @example
 * ```ts
 * import { ExceptionLayers, guard } from "@afora/core";
 *
 * const scope = { layer: ExceptionLayers.UseCase, source: "LoadConfig" };
 *
 * // Without `resolve`, what `run` throws goes up to the next layer with its trace
 * guard(scope, () => JSON.parse('{"port":3000}'));
 *
 * // With `resolve`, it can give a value instead, or call `pass` to go up
 * const config = guard(
 * 	scope,
 * 	() => JSON.parse("{") as { port: number },
 * 	() => ({ port: 8080 }),
 * );
 * ```
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
