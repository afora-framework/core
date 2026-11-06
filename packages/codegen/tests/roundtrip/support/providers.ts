import { inMemoryProvider, providerOf } from "@afora/core";

export interface MemoryOptions {
	label?: string;
	store?: unknown;
}

/** A catalog provider: named through `providerOf`, delegating to the in-memory one. */
export function memoryProvider(options: MemoryOptions = {}) {
	return providerOf({
		name: "memory",
		options: { label: options.label ?? null },
		create: () => inMemoryProvider(),
	});
}
