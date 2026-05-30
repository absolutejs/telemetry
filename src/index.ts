/**
 * @absolutejs/telemetry — tiny shared OpenTelemetry substrate for the
 * AbsoluteJS substrate packages.
 *
 * **The problem this solves.** The deep-research audit flagged G2: each
 * substrate package needs OTel for the "one trace from edge router →
 * runtime spawn → sync mutation → queue job → secret resolve" SRE
 * narrative. Without coordination, every package writes its own
 * boilerplate (peer-dep handling, noop fallback, attribute names).
 * `@elysiajs/opentelemetry` covers the HTTP request lifecycle but the
 * substrate's internal spans are out of its scope.
 *
 * **The shape this package provides.**
 *
 *   1. **Type-replicated OTel surface.** We do NOT take a peer-dep on
 *      `@opentelemetry/api`. Instead this module type-replicates the
 *      shape (Tracer, Span, TracerProvider, SpanContext, SpanStatus,
 *      SpanKind, SpanOptions). When the user has `@opentelemetry/api`
 *      installed and passes their `TracerProvider`, it conforms to our
 *      types structurally. When they don't, our types are still
 *      complete and our noop tracer is used. The substrate packages
 *      take a single `tracerProvider?: TracerProvider` option and
 *      never need to import `@opentelemetry/api` at all.
 *
 *   2. **Zero-cost noop.** `createNoopTracer()` returns a tracer that
 *      executes the user's callback immediately with a noop span. No
 *      allocations beyond the callback args.
 *
 *   3. **`ABS_ATTRS` semantic conventions.** Standard attribute names
 *      so every substrate package's spans use the same vocabulary
 *      (`abs.tenant`, `abs.engine.id`, `abs.job.kind`). Customer SREs
 *      can correlate across packages without reading source.
 *
 *   4. **`tracerOrNoop(provider, name)`** — the canonical entry point.
 *      Every substrate package factory accepts `tracerProvider?` and
 *      calls `const tracer = tracerOrNoop(options.tracerProvider, '@absolutejs/pkg-name')`.
 *
 * **Context propagation.** When `tracer.startActiveSpan(...)` runs
 * inside an existing OTel context (set by `@elysiajs/opentelemetry`,
 * a parent span in user code, etc.), the new span nests as a child
 * automatically — that's the OTel spec contract. So an HTTP request
 * span from `@elysiajs/opentelemetry` automatically contains the
 * substrate spans for any sync mutations or queue dispatches the
 * handler runs.
 */

// -----------------------------------------------------------------------------
// Type-replicated OTel surface
// -----------------------------------------------------------------------------
//
// These mirror @opentelemetry/api but live here so substrate packages
// don't pick up the peer dep. A real OTel installation's types
// structurally satisfy ours (same shape).

/** Trace flags (W3C trace context). */
export type TraceFlags = number;

/** Span context — the bits that travel across boundaries. */
export type SpanContext = {
	traceId: string;
	spanId: string;
	traceFlags: TraceFlags;
	traceState?: { serialize(): string };
	isRemote?: boolean;
};

/** Span kind enum — values match `@opentelemetry/api`'s `SpanKind`. */
export const SpanKind = {
	INTERNAL: 0,
	SERVER: 1,
	CLIENT: 2,
	PRODUCER: 3,
	CONSUMER: 4
} as const;
export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind];

/** Span status codes — values match `@opentelemetry/api`'s `SpanStatusCode`. */
export const SpanStatusCode = {
	UNSET: 0,
	OK: 1,
	ERROR: 2
} as const;
export type SpanStatusCode =
	(typeof SpanStatusCode)[keyof typeof SpanStatusCode];

export type SpanStatus = {
	code: SpanStatusCode;
	message?: string;
};

/** OTel attribute value — primitives and arrays of primitives. */
export type AttributeValue =
	| string
	| number
	| boolean
	| string[]
	| number[]
	| boolean[]
	| undefined;

export type Attributes = Record<string, AttributeValue>;

/** Span options accepted by `startActiveSpan`. */
export type SpanOptions = {
	kind?: SpanKind;
	attributes?: Attributes;
	links?: Array<{ context: SpanContext; attributes?: Attributes }>;
	startTime?: number;
	root?: boolean;
};

/** A span — the thing you set attributes / status / errors on. */
export type Span = {
	spanContext(): SpanContext;
	setAttribute(key: string, value: AttributeValue): Span;
	setAttributes(attrs: Attributes): Span;
	setStatus(status: SpanStatus): Span;
	updateName(name: string): Span;
	addEvent(name: string, attrs?: Attributes, time?: number): Span;
	recordException(exception: unknown, time?: number): void;
	isRecording(): boolean;
	end(endTime?: number): void;
};

/** A tracer — what you get from `tracerProvider.getTracer(name)`. */
export type Tracer = {
	/**
	 * Create a span without setting it as the active context. Returns
	 * the Span directly — the caller manages `setStatus` /
	 * `recordException` / `end` lifecycle. Most useful for long-running
	 * code where the callback shape of `startActiveSpan` is awkward.
	 *
	 * The new span automatically links to the currently-active span as
	 * its parent (standard OTel behavior).
	 */
	startSpan(name: string, options?: SpanOptions): Span;
	startActiveSpan<T>(name: string, fn: (span: Span) => T): T;
	startActiveSpan<T>(
		name: string,
		options: SpanOptions,
		fn: (span: Span) => T
	): T;
};

/** A tracer provider — typically the OTel SDK's NodeTracerProvider. */
export type TracerProvider = {
	getTracer(name: string, version?: string): Tracer;
};

// -----------------------------------------------------------------------------
// Noop implementations
// -----------------------------------------------------------------------------

const NOOP_SPAN_CONTEXT: SpanContext = {
	spanId: '0000000000000000',
	traceFlags: 0,
	traceId: '00000000000000000000000000000000'
};

const noopSpan: Span = {
	addEvent: () => noopSpan,
	end: () => {},
	isRecording: () => false,
	recordException: () => {},
	setAttribute: () => noopSpan,
	setAttributes: () => noopSpan,
	setStatus: () => noopSpan,
	spanContext: () => NOOP_SPAN_CONTEXT,
	updateName: () => noopSpan
};

/** Returns a singleton noop span. All methods are no-ops; safe to call. */
export const createNoopSpan = (): Span => noopSpan;

const startActiveSpanNoop = <T>(
	_name: string,
	optionsOrFn: SpanOptions | ((span: Span) => T),
	maybeFn?: (span: Span) => T
): T => {
	const fn =
		typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn!;
	return fn(noopSpan);
};

const noopTracer: Tracer = {
	startActiveSpan: startActiveSpanNoop as Tracer['startActiveSpan'],
	startSpan: () => noopSpan
};

/** Returns a tracer whose `startActiveSpan` invokes the callback with a
 *  noop span and returns the callback's result. Zero allocations. */
export const createNoopTracer = (): Tracer => noopTracer;

/** Returns a tracer provider whose `getTracer()` always returns the
 *  noop tracer. Useful for tests + as the default substrate behavior. */
export const createNoopTracerProvider = (): TracerProvider => ({
	getTracer: () => noopTracer
});

// -----------------------------------------------------------------------------
// The canonical helper
// -----------------------------------------------------------------------------

/**
 * Resolve a tracer from an optional provider. Returns the provider's
 * tracer for `name` if a provider was passed; otherwise a noop tracer.
 *
 * Every substrate package's factory should call:
 *
 * ```ts
 * const tracer = tracerOrNoop(options.tracerProvider, '@absolutejs/<pkg-name>');
 * ```
 *
 * and then `tracer.startActiveSpan(...)` in hot paths.
 */
export const tracerOrNoop = (
	provider: TracerProvider | undefined,
	name: string,
	version?: string
): Tracer => (provider !== undefined ? provider.getTracer(name, version) : noopTracer);

// -----------------------------------------------------------------------------
// Semantic conventions — ABS_ATTRS
// -----------------------------------------------------------------------------
//
// Standard attribute names so spans from different substrate packages
// use the same vocabulary. Treat these as STRING CONSTANTS — they're
// part of the public contract; renaming an existing attribute is a
// breaking change for anyone querying their span store.

/**
 * Cross-package semantic conventions. Use these EVERYWHERE rather than
 * inline string literals so a customer's APM query for
 * `abs.tenant = "acme"` resolves spans from sync + queue + runtime in
 * one filter. Added in 0.0.1; additive new attributes are minor bumps.
 */
export const ABS_ATTRS = {
	/** Tenant identifier (shard key / customer id). */
	tenant: 'abs.tenant',
	/** Shard / cluster member id (stable across processes). */
	shardId: 'abs.shard.id',

	// sync
	engineId: 'abs.engine.id',
	collection: 'abs.collection',
	mutation: 'abs.mutation',
	mutationAttempt: 'abs.mutation.attempt',
	subscriptionId: 'abs.subscription.id',
	batchSize: 'abs.batch.size',
	clusterMessageOrigin: 'abs.cluster.origin',

	// queue
	jobId: 'abs.job.id',
	jobKind: 'abs.job.kind',
	jobAttempt: 'abs.job.attempt',
	jobMaxAttempts: 'abs.job.max_attempts',
	workerId: 'abs.worker.id',

	// runtime
	runtimeKey: 'abs.runtime.key',
	runtimePid: 'abs.runtime.pid',
	runtimePort: 'abs.runtime.port',
	runtimeExitReason: 'abs.runtime.exit_reason',
	runtimeReadinessMs: 'abs.runtime.readiness_ms',

	// router
	routeShard: 'abs.route.shard',
	routeDecision: 'abs.route.decision',

	// secrets
	secretName: 'abs.secret.name',
	secretFingerprint: 'abs.secret.fingerprint',

	// audit
	auditKind: 'abs.audit.kind'
} as const;

export type AbsAttrName = (typeof ABS_ATTRS)[keyof typeof ABS_ATTRS];

// -----------------------------------------------------------------------------
// Convenience wrappers for the common pattern
// -----------------------------------------------------------------------------

/**
 * Wrap an async fn in a span that captures success / error status and
 * exception details automatically. Returns the fn's resolved value or
 * rethrows its rejection (with the span ended either way).
 *
 * ```ts
 * await withSpan(tracer, 'sync.runMutation', { attributes: { [ABS_ATTRS.mutation]: name } }, async (span) => {
 *   span.setAttribute(ABS_ATTRS.mutationAttempt, attempt);
 *   return await actuallyRunMutation();
 * });
 * ```
 */
export const withSpan = async <T>(
	tracer: Tracer,
	name: string,
	options: SpanOptions,
	fn: (span: Span) => Promise<T>
): Promise<T> =>
	tracer.startActiveSpan(name, options, async (span) => {
		try {
			const result = await fn(span);
			span.setStatus({ code: SpanStatusCode.OK });
			return result;
		} catch (error) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message:
					error instanceof Error
						? error.message
						: String(error)
			});
			span.recordException(error);
			throw error;
		} finally {
			span.end();
		}
	});

/**
 * Sync variant of {@link withSpan}. Use when the wrapped fn is
 * synchronous; the async version's extra microtask is wasted otherwise.
 */
export const withSpanSync = <T>(
	tracer: Tracer,
	name: string,
	options: SpanOptions,
	fn: (span: Span) => T
): T =>
	tracer.startActiveSpan(name, options, (span) => {
		try {
			const result = fn(span);
			span.setStatus({ code: SpanStatusCode.OK });
			return result;
		} catch (error) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message:
					error instanceof Error
						? error.message
						: String(error)
			});
			span.recordException(error);
			throw error;
		} finally {
			span.end();
		}
	});
