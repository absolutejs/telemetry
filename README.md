# @absolutejs/telemetry

Tiny shared OpenTelemetry substrate for the AbsoluteJS substrate
packages.

**Docs:** [absolutejs.com/documentation/telemetry-overview](https://absolutejs.com/documentation/telemetry-overview)

**What it is.** Type-replicated OTel surface + noop implementations +
the `tracerOrNoop()` helper + `ABS_ATTRS` semantic conventions. ~250
LOC, zero runtime deps.

**What it solves.** The deep-research audit's G2 gap: substrate
packages (runtime / sync / queue / router / secrets / rate-limit /
isolated-jsc) need OTel spans for the "one trace from edge → runtime
→ sync → queue → secret" SRE narrative. Without a shared substrate,
every package writes its own peer-dep / noop-fallback boilerplate
and picks its own attribute names.

**How it's wired.** Every substrate package factory takes an
optional `tracerProvider?: TracerProvider`. Internally it calls:

```ts
const tracer = tracerOrNoop(options.tracerProvider, '@absolutejs/<pkg>');
```

and uses `tracer.startActiveSpan(name, options, fn)` in hot paths.
When the user passes their `@opentelemetry/api` `TracerProvider`, real
spans flow through. When they don't, the noop tracer executes the
callback with zero allocations.

## Install

```sh
bun add @absolutejs/telemetry
# Optional — only if you want real OTel spans:
bun add @opentelemetry/api @opentelemetry/sdk-node
```

The package has **no** runtime dependencies. It does not peer-dep
`@opentelemetry/api` — its types are structurally compatible, so a
real OTel `TracerProvider` satisfies the shape this package expects.

## Usage

### As a substrate-package author

```ts
import { tracerOrNoop, ABS_ATTRS, type TracerProvider } from '@absolutejs/telemetry';

export type MyPackageOptions = {
  // existing options...
  tracerProvider?: TracerProvider;
};

export const createMyPackage = (options: MyPackageOptions) => {
  const tracer = tracerOrNoop(options.tracerProvider, '@absolutejs/my-package');

  return {
    doWork: async (input: string) => {
      return tracer.startActiveSpan(
        'my-package.doWork',
        { attributes: { [ABS_ATTRS.tenant]: input } },
        async (span) => {
          try {
            const result = await actuallyDoWork(input);
            return result;
          } catch (error) {
            span.recordException(error);
            throw error;
          } finally {
            span.end();
          }
        }
      );
    },
  };
};
```

Or use the convenience wrapper `withSpan(tracer, name, options, fn)`
that auto-sets `status` + `recordException` + `end()` for the common
case.

### As a consumer wiring it all together

```ts
import { NodeTracerProvider } from '@opentelemetry/sdk-node';
import { createMyPackage } from '@absolutejs/my-package';

const tracerProvider = new NodeTracerProvider({ /* exporter, sampler, etc */ });
tracerProvider.register();

const pkg = createMyPackage({ tracerProvider });
// Spans now flow through to your configured exporter.
```

## API

### `tracerOrNoop(provider, name, version?)`

Returns `provider.getTracer(name, version)` if `provider` is defined;
otherwise a noop tracer. The canonical entry point for substrate
packages.

### `withSpan(tracer, name, options, fn)` / `withSpanSync(...)`

Wrap an async (or sync) callback in a span that auto-sets:

- `status: OK` on success
- `status: ERROR` + `recordException(error)` on throw
- `span.end()` in either case (`finally`)

```ts
const result = await withSpan(
  tracer,
  'sync.runMutation',
  { attributes: { [ABS_ATTRS.mutation]: 'createIssue' } },
  async (span) => {
    span.setAttribute(ABS_ATTRS.mutationAttempt, 1);
    return await engine.runMutation('createIssue', args, ctx);
  }
);
```

### `createNoopSpan()` / `createNoopTracer()` / `createNoopTracerProvider()`

Singletons. Useful in tests + as default fallbacks.

### `ABS_ATTRS`

Standard attribute names. Use these instead of inline string literals
so cross-package queries (`abs.tenant = "acme"`) resolve in one
filter:

```
abs.tenant                  // tenant / shard key
abs.shard.id

// sync
abs.engine.id
abs.collection
abs.mutation
abs.mutation.attempt
abs.subscription.id
abs.batch.size
abs.cluster.origin

// queue
abs.job.id
abs.job.kind
abs.job.attempt
abs.job.max_attempts
abs.worker.id

// runtime
abs.runtime.key
abs.runtime.pid
abs.runtime.port
abs.runtime.exit_reason
abs.runtime.readiness_ms

// router
abs.route.shard
abs.route.decision

// secrets
abs.secret.name
abs.secret.fingerprint

// audit
abs.audit.kind
```

Adding NEW attributes is a minor bump; renaming an existing one is a
breaking change (anyone querying their span store has hard-coded the
old name).

### Type re-exports

`Tracer`, `Span`, `TracerProvider`, `SpanContext`, `SpanStatus`,
`SpanStatusCode`, `SpanKind`, `SpanOptions`, `Attributes`,
`AttributeValue`, `AbsAttrName`. Mirror `@opentelemetry/api` exactly;
a real OTel `TracerProvider` satisfies these types structurally.

## License

[Apache 2.0](./LICENSE). Tier B substrate-adjacent under the
AbsoluteJS licensing policy.
