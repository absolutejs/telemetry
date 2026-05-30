# Changelog

## [0.0.3] — 2026-05-30

### Added — `readActiveTraceId()` helper

Extracts the "dynamic-optional `@opentelemetry/api` import to read the
active span's trace id" pattern out of `@absolutejs/audit-elysia` (and
anywhere else that wanted to attach `metadata.traceId` to a non-span
artifact). The single place in the substrate that does this dynamic
import.

- Returns `string | undefined`. Resolves to `undefined` when OTel
  isn't installed OR when no span is active. No throws.
- Module specifier built at runtime so bundlers don't statically
  resolve `@opentelemetry/api` — truly optional dep.

2 new tests; 13 → 15.

## [0.0.2] — 2026-05-30

### Added — `Tracer.startSpan(name, options?)`

`startActiveSpan(name, options, fn)` forces a callback shape that's
awkward to wrap around long-running inline code (engine.runMutation's
~150-line retry loop, etc.). `startSpan` returns the Span directly so
the caller manages `setStatus` / `recordException` / `end` themselves,
in a regular try/catch/finally. Parent linking still works via OTel's
active-context lookup (standard behavior).

Noop tracer's `startSpan` returns the singleton noop span. Mock
tracers in test code need to add a `startSpan` field; the public
`Tracer` type requires it now.

## [0.0.1] — 2026-05-30

Initial preview. Tiny shared OpenTelemetry substrate for the
AbsoluteJS substrate packages.

### Surface

- **`tracerOrNoop(provider, name, version?)`** — canonical helper.
  Returns the provider's tracer if defined; otherwise a noop tracer.
- **`withSpan(tracer, name, options, fn)`** + **`withSpanSync(...)`** —
  convenience wrappers that auto-set `OK` / `ERROR` status,
  `recordException`, and `end()` around an async (or sync) callback.
- **`createNoopSpan()` / `createNoopTracer()` / `createNoopTracerProvider()`** —
  singleton noops. Zero allocation overhead beyond the user's
  callback args.
- **Type-replicated OTel surface**: `Tracer`, `Span`,
  `TracerProvider`, `SpanContext`, `SpanStatus`, `SpanStatusCode`,
  `SpanKind`, `SpanOptions`, `Attributes`, `AttributeValue`,
  `AbsAttrName`. Mirrors `@opentelemetry/api` so a real OTel
  `TracerProvider` is structurally compatible without taking a peer
  dep.
- **`ABS_ATTRS`** semantic conventions. Standard attribute names
  (`abs.tenant`, `abs.engine.id`, `abs.job.kind`, etc.) so substrate
  spans use one vocabulary. Adding new attributes is a minor bump;
  renaming is breaking.

### License

Apache 2.0 (Tier B substrate-adjacent — no runtime deps).
