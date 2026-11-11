import type { ExceptionLayers } from "../enums/exception-layers";

/** Where an exception is: the layer and who, in it, raised or handled it. */
export interface ExceptionScope {
	readonly layer: ExceptionLayers;
	/** Who raised it, e.g. the property, blueprint or use case name. */
	readonly source: string;
}

/** One step of an exception's trace. */
export interface ExceptionFrame<Details = unknown> extends ExceptionScope {
	readonly name: string;
	readonly message: string;
	readonly details: Details;
}

/**
 * What the {@link Exception} constructor takes: the scope (`layer` and
 * `source`), the `name` and `message`, optional `details` and the `cause`.
 */
export interface ExceptionInit<Details = unknown> extends ExceptionScope {
	readonly name: string;
	readonly message: string;
	readonly details?: Details;
	/** What caused it; an exception here keeps its trace. */
	readonly cause?: unknown;
}

/** What `propagate` takes: the new scope, and optionally a new name or message. */
export interface ExceptionPropagation<Details = unknown>
	extends ExceptionScope {
	readonly name?: string;
	readonly message?: string;
	readonly details?: Details;
}

/** An exception class, abstract or declared with `exceptionOf`. */
// biome-ignore lint/suspicious/noExplicitAny: any exception, whatever its details
export type ExceptionClass<Instance = any> = abstract new (
	...args: never[]
) => Instance;

/**
 * The `message` of an exception declared with {@link exceptionOf}: a string, or
 * a function of the `details` and the `source` that gives it.
 */
export type ExceptionMessage<Details> =
	| string
	| ((details: Details, source: string) => string);

/**
 * What {@link exceptionOf} takes: the `layer` of the exception, its `name` and
 * its `message`. `Details` is the type of the `details` it carries, taken from
 * the parameter of `message` when that is a function.
 */
export interface ExceptionDeclaration<Details> {
	readonly layer: ExceptionLayers;
	readonly name: string;
	readonly message: ExceptionMessage<Details>;
}

/** What a class declared with `exceptionOf` takes; `details` is required when typed. */
export type ExceptionArgs<Details> = {
	readonly source: string;
	readonly cause?: unknown;
	/** Replaces the declared message. */
	readonly message?: string;
} & (undefined extends Details
	? { readonly details?: Details }
	: { readonly details: Details });
