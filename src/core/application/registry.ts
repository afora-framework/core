import { ApplicationNotStarted } from "./exceptions";
import type { AnyApplication } from "./types/application.interface";

/**
 * Declares the type of the application `useApplication()` gives, by module
 * augmentation, once per project:
 *
 * ```ts
 * declare module "@afora/core" {
 *   interface Register { application: typeof App }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: filled by module augmentation
export interface Register {}

/** The application declared in `Register`, or any application. */
export type RegisteredApplication = Register extends {
	readonly application: infer Application extends AnyApplication;
}
	? Application
	: AnyApplication;

/** What the process keeps: the started application. */
interface Slot {
	current: AnyApplication | undefined;
}

// `Symbol.for`, so that two copies of the package loaded in one process
// (a duplicated module, a dual package) share the started application.
const SLOT = Symbol.for("afora.application");

function slot(): Slot {
	const global = globalThis as { [SLOT]?: Slot };
	global[SLOT] ??= { current: undefined };
	return global[SLOT];
}

/**
 * The application started in this process, from anywhere, without importing
 * it (so a hand-written use case or handler that the application imports can
 * reach it without an import cycle). Throws `ApplicationNotStarted` when none
 * is. Typed by `Register`.
 */
export function useApplication(): RegisteredApplication {
	const { current } = slot();
	if (current === undefined) {
		throw new ApplicationNotStarted({ source: "useApplication", details: {} });
	}
	return current as RegisteredApplication;
}

/**
 * Forgets the started application without stopping it, e.g. between tests,
 * so that another one can start.
 */
export function resetApplication(): void {
	slot().current = undefined;
}

/** The started application of the process, if any. @internal */
export function startedApplication(): AnyApplication | undefined {
	return slot().current;
}

/** Makes `application` the started one. @internal */
export function setStartedApplication(
	application: AnyApplication | undefined,
): void {
	slot().current = application;
}
