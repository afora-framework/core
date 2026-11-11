import type {
	ITracer,
	ITraceSpan,
	TraceAttributes,
	TraceStatus,
} from "@afora/core";
import {
	context,
	type Span,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";

/** The instrumentation scope of the default tracer. */
export const AFORA_TRACER_NAME = "@afora/otel";

/** A span of afora over one OpenTelemetry span. */
class OtelSpan implements ITraceSpan {
	constructor(readonly span: Span) {}

	end(status: TraceStatus, attributes: TraceAttributes): void {
		this.span.setAttributes(attributes);
		// Success leaves the status unset, as OpenTelemetry asks of libraries.
		if (status === "error") {
			const name = attributes["afora.exception.name"];
			this.span.setStatus({
				code: SpanStatusCode.ERROR,
				...(typeof name === "string" ? { message: name } : {}),
			});
		}
		this.span.end();
	}
}

/**
 * The `trace` of an application, over an OpenTelemetry `Tracer` (by default
 * `trace.getTracer("@afora/otel")`, of the global tracer provider):
 *
 * ```ts
 * applicationOf({ name: "blog", trace: otelTracer(), ... });
 * ```
 *
 * A command span is a child of the active span (an HTTP server span of your
 * instrumentation, say); a use case span a child of its command or of the use
 * case that ran it; a repository span a child of its use case, whether or not
 * a context manager is registered. With one, each call also runs with its
 * span active, so the spans of your code and of instrumented drivers nest in it.
 */
export function otelTracer(
	tracer: Tracer = trace.getTracer(AFORA_TRACER_NAME),
): ITracer {
	return Object.freeze({
		startSpan(
			name: string,
			attributes: TraceAttributes,
			parent: ITraceSpan | undefined,
		): ITraceSpan {
			const active = context.active();
			return new OtelSpan(
				tracer.startSpan(
					name,
					{ attributes },
					parent instanceof OtelSpan
						? trace.setSpan(active, parent.span)
						: active,
				),
			);
		},
		withSpan<Result>(span: ITraceSpan, run: () => Result): Result {
			return span instanceof OtelSpan
				? context.with(trace.setSpan(context.active(), span.span), run)
				: run();
		},
	});
}
