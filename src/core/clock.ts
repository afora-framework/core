import { activeRuntime } from "./runtime-scope";

/** Reads the current time as epoch milliseconds. */
export type Clock = () => number;

let source: Clock | undefined;

/**
 * The current time, in epoch milliseconds: the clock of the `withRuntime` or
 * of the application running the call, else the one set by `setClock`, else
 * the platform's. The one place afora reads the time from (the logger's `at` apart,
 * which is about when things really happened).
 */
export function currentTime(): number {
	const scoped = activeRuntime()?.clock;
	if (scoped !== undefined) return scoped();
	return source === undefined ? Date.now() : source();
}

/** Replaces the clock `currentTime` reads; `undefined` restores the platform's. */
export function setClock(clock: Clock | undefined): void {
	source = clock;
}
