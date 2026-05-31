# Changelog

## [0.1.0] — 2026-05-31

Closes the third piece of G9 (observability triad) — the substrate
now has a bundled OTLP-HTTP-JSON span exporter. The instrumentation
investment across `runtime` / `sync` / `queue` / `router` /
`secrets` / `rate-limit` / `isolated-jsc` finally has a one-line
"send to OTel collector" path that doesn't require operators to
wire `@opentelemetry/sdk-node` themselves.

### Added — `@absolutejs/telemetry/otlp-http` subpath

- **`createOtlpTracerProvider({ endpoint, serviceName, … })`**
  returns an `OtlpTracerProvider` that satisfies the
  `TracerProvider` interface from the root subpath. Pass it to any
  substrate package's `tracerProvider` option and spans leave the
  process.
- **OTLP/JSON wire format.** Standardized HTTP encoding; works
  against the OTel Collector, Grafana Agent, Tempo, Honeycomb,
  Datadog (via OTLP intake), Lightstep, etc.
- **Zero dependencies.** No `@opentelemetry/sdk-node`, no
  `@opentelemetry/api`, no protobuf runtime. ~500 lines we own.
- **Head-based ratio sampling.** Sampled at root; every child of a
  sampled trace inherits. Non-sampled spans skip serialization
  entirely (zero overhead).
- **Batching.** `maxBatchSize` (default 512) + `scheduledDelayMs`
  (default 5000) + `maxQueueSize` (default 2048). Queue overflow
  counted in `metrics().droppedDueToQueueLimit` so operators can
  spot back-pressure.
- **Standard attribute encoding.** Strings, integers, doubles,
  booleans, arrays of primitives — per OTLP/JSON spec
  (`stringValue` / `intValue` (string) / `doubleValue` /
  `boolValue` / `arrayValue`).
- **Exceptions + status.** `recordException(err)` emits a standard
  OTel `exception` event with `exception.message` /
  `exception.type` / `exception.stacktrace`. `setStatus` maps to
  `STATUS_CODE_OK` / `STATUS_CODE_ERROR` / `STATUS_CODE_UNSET`.
- **Resource attributes.** Required `serviceName` + optional
  `serviceVersion` + arbitrary `resourceAttributes` for region /
  deployment.environment / etc.
- **Operator visibility.** `provider.metrics()` returns
  `{ queued, exported, droppedDueToQueueLimit, sampled,
  notSampled, batches, batchErrors }`.
- **`flush()` + `shutdown()`.** `flush()` drains the queue;
  `shutdown()` flushes + closes so further spans don't enqueue.

### Limitations (intentional — use `@opentelemetry/sdk-node` if you need them)

- No async context propagation across `await` boundaries — each
  `tracer.startSpan(name)` creates a fresh root unless the caller
  threads the parent.
- No inbound `traceparent` parsing — that's the HTTP layer's job.
- No OTLP/Protobuf encoding — JSON is universal and zero-dep.
- Spans only — no metric/log exports through this provider.

### Tests

17 new tests across span lifecycle, attribute encoding, events +
status + exceptions, sampling (0% / 100% / isRecording), batching
(full-batch trigger, queue overflow), error handling (non-2xx,
fetch rejection), custom headers + resource attributes, shutdown
drain, multi-batch metrics accumulation, `startActiveSpan`.

### Build

Added `src/otlpHttp.ts` as a second bundle entry. `./otlp-http`
subpath in `exports`. Build uses `--root src` for clean
`dist/<name>.js` layout.

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
