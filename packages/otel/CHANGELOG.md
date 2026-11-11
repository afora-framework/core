# Changelog

## Unreleased

### Added

- First release: `otelTracer(tracer?)` gives an afora application (`applicationOf({ trace })`) a span per command, use case and repository call made through a use case, over an OpenTelemetry `Tracer`, nested as the calls are, with no input, response or sensitive value in any span. `AFORA_TRACER_NAME` is the instrumentation scope of the default tracer.
