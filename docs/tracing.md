# Tracing

An application with a `trace` makes a span for each command operation, use case and repository call made through a use case, nested as the calls are. The tracer is an `ITracer`, a small interface of `@afora/core`: [`@afora/otel`](../packages/otel/README.md) gives one over OpenTelemetry, and `memoryTracer()` keeps the spans for tests. `@afora/core` itself has no OpenTelemetry dependency. Without a `trace` nothing is traced.

## Turning it on

```ts
import { applicationOf } from "@afora/core";
import { otelTracer } from "@afora/otel";

export const App = applicationOf({
	name: "blog",
	// ...
	trace: otelTracer(), // the tracer "@afora/otel" of the global tracer provider
});
```

`otelTracer(tracer?)` takes an OpenTelemetry `Tracer`, `trace.getTracer("@afora/otel")` by default, so the spans go wherever the OpenTelemetry SDK of the process sends them (set it up as usual, e.g. with `NodeSDK` and an OTLP exporter). `@opentelemetry/api` is a peer dependency of `@afora/otel`.

One request to an output, on any of the HTTP sinks, is then one trace:

```
command Posts.publish                    afora.command=Posts.publish afora.operation=publish
└─ use-case Publish                      afora.use_case=Publish
   ├─ repository Post.findBySlug         afora.repository=Post afora.method=findBySlug
   ├─ use-case Notify                    (a use case run by Publish)
   │  └─ repository Subscriber.findMany
   └─ repository Post.create
```

A command span is a child of the span active when it runs, such as the server span of an HTTP instrumentation. The nesting below it does not depend on a context manager: afora passes the parent of each span itself, so it holds on Bun, Node, Workers and in the browser. With a context manager (the `NodeSDK` registers one), each call also runs with its span active, so the spans your code and instrumented drivers start inside a use case or a repository call nest in it.

## Spans and attributes

| Span                            | When                                                                                 | Attributes                                            |
| ------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `command <Command>.<operation>` | A command operation runs, from the check of its context to its event policy (`run`). | `afora.command` (`Name.operation`), `afora.operation` |
| `use-case <UseCase>`            | A use case executes, from the check of its dependencies.                             | `afora.use_case`                                      |
| `repository <Entity>.<method>`  | A repository method is called by a use case, or by another method through `this`.    | `afora.repository`, `afora.method`, `afora.use_case`  |

Each span ends with `afora.outcome`, `"ok"` or `"error"`. A failed span also has:

| Attribute                    | Value                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `afora.exception.layer`      | The [layer](exceptions.md) where the exception was first raised (`use-case`, `repository`...).          |
| `afora.exception.name`       | Its name, such as `PostNotFound`; `UnexpectedError` for anything thrown that is not an afora exception. |
| `afora.exception.unexpected` | `true` for an `UnexpectedError`.                                                                        |

With `@afora/otel` its status is `ERROR`, with the exception name as the message; a span that succeeded keeps the status unset, as OpenTelemetry asks of libraries. Every span on the way up fails with the same attributes: the use case that threw, the use cases that ran it, the command.

These are the points that [log](logging.md#what-afora-logs), on the same code paths: a repository called directly, outside a use case, makes no span. A span starts before the checks of its call, so an invalid context or environment of a command, or an invalid override of a use case, leaves a failed span. A repository method that calls another through `this` (a method of your own calling `this.create`) has the span of the inner call as a child of its own, even when calls run concurrently.

The span of a command run with `run` covers its [event policy](commands.md#event-policies): a handler or a publisher that fails sets it to error, though the use case span stays ok. What the policy runs (an event handler calling a use case) nests in the command span when the tracer has a current span, as `@afora/otel` does with a context manager; without one it starts its own trace, since afora cannot hand the span through the handler. `execute`, which applies no policy, ends the span when the use case returns.

## No value in any span

A span holds names and outcomes, never a value: no input, argument, context, response, id or field of a record, so no [sensitive](records.md) value either. A failure gives the layer and the name of the exception, not its message, details or cause, which can hold values (the message of an `UnexpectedError` is the message of whatever was thrown). `@afora/otel` records no exception event for the same reason. Add the attributes you need yourself, in your code, inside the span of the use case.

The tests of the core (with a `sensitive` field) and of `@afora/otel` check it: a request to a Hono output that registers a user with a password (a sensitive field) and fails a second time leaves neither the password, nor its hash, nor any input or id in any span.

## A tracer of your own

`ITracer` is two methods; `memoryTracer()` is one, for tests:

<!-- docs:code skip: the application is elided (`/* ... */`), so `app.commands.Posts` has no type here -->
```ts
import { memoryTracer } from "@afora/core";

const tracer = memoryTracer();
const app = applicationOf({ name: "blog", /* ... */ trace: tracer });
await app.commands.Posts.run("publish", { title: "Hi" });
tracer.spans.map((span) => [span.name, span.parent?.name, span.status]);
// [["command Posts.publish", undefined, "ok"], ["use-case Publish", "command Posts.publish", "ok"], ...]
```

Your own implements `startSpan(name, attributes, parent)`, which returns an `ITraceSpan` with `end(status, attributes)`; `parent` is the span afora started for the caller, `undefined` for a call that starts a trace. `withSpan(span, run)` is optional: it runs `run` with `span` as the current span of your tracing library. A tracer that throws, in `startSpan`, `end` or `withSpan`, breaks no call: afora goes on without the span, runs the call once, and what the call itself throws goes up unchanged. A `trace` that is not a tracer throws `InvalidTraceDeclaration` when the application is declared.

Which tracer traces a call: the one of the application that bound the command or use case (`App.commands.X`, `App.useCases.X`, `app.run`); for a use case class run outside one, the started application's (`app.start()`); none when there is neither. A use case run by a command, or by another use case, is traced with its caller's.

## Cost

Without a `trace`, a call costs what it did: the code looks up the tracer once per use case and per command, as it looks up the logger, and takes the same path, with no allocation and no closure added. A repository call checks only whether its use case has a span. `bun run bench:guard` covers validation, which tracing does not touch.

## Extending

An application that `extends` another without a `trace` of its own is traced by the same tracer; `app.extend(Other)` keeps it. `describe()` gives it as `{ kind: "opaque" }`, and in an `afora.json` it is `"trace": { "import": "./trace.ts#tracer" }` (see [afora.json](afora-json.md#tracing)).

## Design note

Issue #65. **Context:** teams running an afora backend in production ask for traces; the core must stay free of the OpenTelemetry dependency, load in browsers and Workers (so no `AsyncLocalStorage` at module load), and keep its invalid-input and execution paths fast.

**Decision:** a structural hook in the core and the binding in a companion package.

- `ITracer` in `@afora/core` is `startSpan(name, attributes, parent)` and an optional `withSpan(span, run)`; `ITraceSpan` is `end(status, attributes)`. The core decides the span names and attribute keys, so the guarantee about values lives in one place, and an adapter only maps them.
- Spans start and end at the three points that already log (command `perform`, the use case `execute` wrapper, the repository methods bound for a use case), reusing the resolution of the logger: the scope of the call, else the bound class, else the started application.
- The parent is passed explicitly: the command puts its span in the `ExecutionScope`, a use case keeps its span on its execution state for its repository calls and gives its children a scope with it. Nesting holds without a context manager; `withSpan` adds the OpenTelemetry context on top for spans started by other code.
- Without a tracer, the code takes the existing path: one lookup per use case and command, one property check per repository call, no allocation.

**Options weighed:** making the core depend on `@opentelemetry/api` (rejected: a dependency for everyone, and the API's global state in the core); nesting only through the active OpenTelemetry context (rejected: needs a context manager, absent on Workers and in tests by default); a tracer made on start like `logFrom` (not needed: an OpenTelemetry tracer is a proxy that works before the SDK registers).

**Consequences:** `ApplicationDescription` gains `trace`, the `afora.json` spec gains `"trace"`, and every HTTP sink gets tracing through `compileRoutes` and commands, with no change to the sinks. Event handlers and steps inside a use case are not spans of their own yet; they can be added at the same points later.
