# @afora/otel

[OpenTelemetry](https://opentelemetry.io) tracing for [`@afora/core`](../../README.md) applications: a span per command operation, use case and repository call made through a use case, nested as the calls are, with the exception layer and name on failure and no input, response or sensitive value in any span. What the spans are and carry is in [docs/tracing.md](../../docs/tracing.md).

```bash
bun add @afora/core @afora/otel @opentelemetry/api
```

`@afora/core` and `@opentelemetry/api` (`^1.9.0`) are peer dependencies. Set up an OpenTelemetry SDK as usual (`@opentelemetry/sdk-node`, an exporter); the package itself uses only the API, so it runs on Bun, Node >= 22 and Workers.

## Example

<!-- docs:code skip: Post, Posts, Blog and Api are the declarations of your application -->
```ts
import { applicationOf } from "@afora/core";
import { otelTracer } from "@afora/otel";

export const App = applicationOf({
	name: "blog",
	entities: { Post },
	repositories: { Posts },
	commands: { Blog },
	outputs: { Api },
	trace: otelTracer(),
});
```

A request to `App.outputs.Api.build()`, on Hono or any HTTP sink, gives one trace:

```
command Blog.publish          afora.command=Blog.publish afora.operation=publish afora.outcome=ok
└─ use-case Publish           afora.use_case=Publish afora.outcome=ok
   └─ repository Post.create  afora.repository=Post afora.method=create afora.use_case=Publish
```

## API

- **`otelTracer(tracer?)`**: the `ITracer` of `@afora/core` over an OpenTelemetry `Tracer`, by default `trace.getTracer(AFORA_TRACER_NAME)` of the global tracer provider (it works before the SDK registers, as OpenTelemetry tracers do).
  - A command span is a child of the active span, such as the server span of your HTTP instrumentation; the spans below it are children of their caller's span whether or not a context manager is registered.
  - With a context manager, each call runs with its span active, so the spans your code and instrumented drivers start inside a use case or a repository call nest in it.
  - A failed span has the status `ERROR`, with the exception name as its message, and the attributes `afora.exception.layer`, `afora.exception.name` and `afora.exception.unexpected`; no exception event is recorded, since the message and stack of an error can hold values. A span that succeeded keeps the status unset.
- **`AFORA_TRACER_NAME`**: `"@afora/otel"`, the instrumentation scope of the default tracer.

## In an afora.json

```json
{ "version": 1, "name": "blog", "trace": { "import": "../trace.ts#tracer" } }
```

with `export const tracer = otelTracer();` in `trace.ts` (see [afora.json](../../docs/afora-json.md#tracing)).

## Tests

```bash
bun run test:otel  # from the repository root
```

The tests serve an application through [`@afora/hono`](../hono/README.md) with an in-memory span exporter, and check the trace of a request (command, use cases, repository calls), the attributes of a failure, and that no password, hash, input or id reaches any span.
