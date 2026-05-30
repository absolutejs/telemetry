# Changelog

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
