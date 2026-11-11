import { startedApplication } from "../application/registry";
import type { ExceptionLayers } from "../exception/enums/exception-layers";
import { Exception, UNEXPECTED_ERROR } from "../exception/exception";
import { InvalidTraceDeclaration } from "./exceptions";

/**
 * What a span carries: names and outcomes only, never an input, an argument,
 * a response or any value of a record.
 */
export type TraceAttributes = Readonly<
	Record<string, string | number | boolean>
>;

/** How a span ended. */
export type TraceStatus = "ok" | "error";

/** A span afora started; it ends it once, with the attributes of the outcome. */
export interface ITraceSpan {
	end(status: TraceStatus, attributes: TraceAttributes): void;
}

/**
 * What traces an application: a span per command operation, use case and
 * repository call made through a use case. `@afora/otel` adapts an
 * OpenTelemetry `Tracer` to it; `memoryTracer()` keeps the spans for tests.
 */
export interface ITracer {
	/**
	 * Starts a span. `parent` is the span of the call that made this one (the
	 * command of a use case, the use case of a repository call), `undefined`
	 * for a call that starts a trace.
	 */
	startSpan(
		name: string,
		attributes: TraceAttributes,
		parent: ITraceSpan | undefined,
	): ITraceSpan;
	/**
	 * Runs `run` with `span` as the current span, when the tracer has a notion
	 * of one (an OpenTelemetry context): what your code and the instrumented
	 * drivers start inside the call is nested in its span.
	 */
	withSpan?<Result>(span: ITraceSpan, run: () => Result): Result;
}

/** Throws unless `value` can trace an application. */
export function checkTracer(value: unknown): ITracer {
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as ITracer).startSpan !== "function" ||
		((value as ITracer).withSpan !== undefined &&
			typeof (value as ITracer).withSpan !== "function")
	) {
		throw new InvalidTraceDeclaration({
			source: "trace",
			details: {
				reason:
					"Expected `trace` to be a tracer: { startSpan(name, attributes, parent), withSpan? }.",
			},
		});
	}
	return value as ITracer;
}

/**
 * Carries the tracer of an application, when it has a `trace`: on the
 * application and on the use case classes it binds.
 */
export const ApplicationTracerKey: unique symbol = Symbol(
	"afora.application.tracer",
);

type TracerHolder = { readonly [ApplicationTracerKey]?: ITracer } | undefined;

/**
 * The tracer of a call: the one its scope carries, else the one of the
 * application its class was bound by, else the started application's.
 */
export function resolveTracer(
	scoped: ITracer | undefined,
	owner: unknown,
): ITracer | undefined {
	return (
		scoped ??
		(owner as TracerHolder)?.[ApplicationTracerKey] ??
		(startedApplication() as TracerHolder)?.[ApplicationTracerKey]
	);
}

/** Starts a span; a tracer that throws never breaks the call it traces. */
export function startSpan(
	tracer: ITracer,
	name: string,
	attributes: TraceAttributes,
	parent: ITraceSpan | undefined,
): ITraceSpan | undefined {
	try {
		return tracer.startSpan(name, attributes, parent);
	} catch {
		// Tracing is bookkeeping.
		return undefined;
	}
}

/** Runs `run` inside `span`, if the tracer can make it current. */
export function runInSpan<Result>(
	tracer: ITracer,
	span: ITraceSpan,
	run: () => Result,
): Result {
	if (tracer.withSpan === undefined) return run();
	// A `withSpan` that throws breaks nothing: `run` runs once, and what it
	// throws goes up unchanged.
	let ran = "no" as "no" | "returned" | "threw";
	let result: Result | undefined;
	let thrown: unknown;
	const once = (): Result => {
		try {
			result = run();
			ran = "returned";
			return result;
		} catch (error) {
			ran = "threw";
			thrown = error;
			throw error;
		}
	};
	try {
		return tracer.withSpan(span, once);
	} catch {
		if (ran === "threw") throw thrown;
		return ran === "returned" ? (result as Result) : run();
	}
}

const OK: TraceAttributes = Object.freeze({ "afora.outcome": "ok" });

/** Ends a span that succeeded. */
export function endSpan(span: ITraceSpan | undefined): void {
	if (span === undefined) return;
	try {
		span.end("ok", OK);
	} catch {
		// Tracing is bookkeeping.
	}
}

/**
 * Ends a span that failed, with the layer and name of the exception where it
 * was first raised (`layer` and `UnexpectedError` for anything else thrown).
 * Never its message, details or cause: they can hold values.
 */
export function failSpan(
	span: ITraceSpan | undefined,
	error: unknown,
	layer: ExceptionLayers,
): void {
	if (span === undefined) return;
	const origin = error instanceof Exception ? error.origin : undefined;
	const name = origin?.name ?? UNEXPECTED_ERROR;
	try {
		span.end("error", {
			"afora.outcome": "error",
			"afora.exception.layer": origin?.layer ?? layer,
			"afora.exception.name": name,
			"afora.exception.unexpected": name === UNEXPECTED_ERROR,
		});
	} catch {
		// Tracing is bookkeeping.
	}
}

/** A span as `memoryTracer` keeps it. */
export interface MemorySpan {
	readonly name: string;
	/** Those it started with, then those it ended with. */
	readonly attributes: TraceAttributes;
	readonly parent: MemorySpan | undefined;
	/** `undefined` until it ends. */
	readonly status: TraceStatus | undefined;
}

/** A tracer that keeps the spans, for tests. */
export interface MemoryTracer extends ITracer {
	/** Every span, in the order they started. */
	readonly spans: readonly MemorySpan[];
	clear(): void;
}

/** Keeps every span in `spans`, with its parent, for tests. */
export function memoryTracer(): MemoryTracer {
	const spans: MemorySpan[] = [];
	const recorded = new WeakMap<ITraceSpan, MemorySpan>();
	return Object.freeze({
		spans,
		clear: () => {
			spans.length = 0;
		},
		startSpan(
			name: string,
			attributes: TraceAttributes,
			parent: ITraceSpan | undefined,
		): ITraceSpan {
			const span: {
				name: string;
				attributes: TraceAttributes;
				parent: MemorySpan | undefined;
				status: TraceStatus | undefined;
			} = {
				name,
				attributes: { ...attributes },
				parent: parent === undefined ? undefined : recorded.get(parent),
				status: undefined,
			};
			spans.push(span);
			const handle: ITraceSpan = {
				end(status, ended) {
					if (span.status !== undefined) return;
					span.status = status;
					span.attributes = { ...span.attributes, ...ended };
				},
			};
			recorded.set(handle, span);
			return handle;
		},
	});
}
