# Changelog

## 27.0.0-rc.5 — 2026-11-24

A candidate of 27.0.0, with no changes since 27.0.0-rc.4. See the [root CHANGELOG](../../CHANGELOG.md).

## 27.0.0-rc.4 — 2026-11-16

A candidate of 27.0.0, with no changes since 27.0.0-rc.3. See the [root CHANGELOG](../../CHANGELOG.md).

## 27.0.0-rc.3 — 2026-11-16

A candidate of 27.0.0, with no changes since 27.0.0-rc.2. See the [root CHANGELOG](../../CHANGELOG.md).

## 27.0.0-rc.2 — 2026-11-16

A candidate of 27.0.0, with no changes since 27.0.0-rc.1. See the [root CHANGELOG](../../CHANGELOG.md).

## 27.0.0-rc.1 — 2026-11-16

The first release candidate of 27.0, with the API of 0.0.13; it needs `@afora/core >=27.0.0-rc.1`. See the [root CHANGELOG](../../CHANGELOG.md).

## 0.0.13 — 2026-11-16

### Added

- First release: `otelTracer(tracer?)` gives an afora application (`applicationOf({ trace })`) a span per command, use case and repository call made through a use case, over an OpenTelemetry `Tracer`, nested as the calls are, with no input, response or sensitive value in any span. `AFORA_TRACER_NAME` is the instrumentation scope of the default tracer.
