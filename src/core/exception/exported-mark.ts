import { isDeclaredException } from "./exception";

/**
 * The exception classes counted as exported by the package. A leaf: a module
 * that declares exceptions (`std` among them) marks its own here without
 * importing the modules `exported.ts` collects, so what only a server runs
 * stays out of a bundle that imports it.
 */
const exported = new WeakSet<object>();

/** Counts `Exception` classes the package exports from a module the core cannot import. */
export function markExported(...classes: readonly unknown[]): void {
	for (const Declared of classes) {
		if (isDeclaredException(Declared)) exported.add(Declared);
	}
}

/** Whether `Declared` was counted by `markExported`. */
export function isMarkedExported(Declared: unknown): boolean {
	return typeof Declared === "function" && exported.has(Declared);
}
