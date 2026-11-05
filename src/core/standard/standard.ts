import type { ParseResult } from "../parse/types/parse.interface";
import { STANDARD_VENDOR, type StandardSchemaV1 } from "./standard-schema";

/** The `~standard` of a field that handles values with `parse`; its `validate` never throws. */
function standardOf<Input, Output>(
	parse: (value: unknown) => ParseResult<Output>,
): StandardSchemaV1.Props<Input, Output> {
	return Object.freeze({
		version: 1 as const,
		vendor: STANDARD_VENDOR,
		validate: (value: unknown) => parse(value),
	});
}

/**
 * Gives `target` a `~standard` that handles values with `parse`. It is not
 * enumerable, so that spreading `target` never copies another field's.
 */
export function withStandard<Target extends object>(
	target: Target,
	parse: (value: unknown) => ParseResult<unknown>,
): Target {
	return Object.defineProperty(target, "~standard", {
		value: standardOf(parse),
		enumerable: false,
	});
}

const cache = new WeakMap<object, StandardSchemaV1.Props>();

/**
 * The `~standard` of the class `Class`, made on first read and the same
 * after, that handles values with its `safeParse`.
 */
export function standardOfClass(Class: {
	safeParse(value: unknown): ParseResult<unknown>;
}): StandardSchemaV1.Props {
	let standard = cache.get(Class);
	if (!standard) {
		standard = standardOf((value) => Class.safeParse(value));
		cache.set(Class, standard);
	}
	return standard;
}
