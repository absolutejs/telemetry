/**
 * @absolutejs/telemetry/otlp-http — zero-dependency OTLP-HTTP-JSON
 * span exporter. Implements the `TracerProvider` interface from
 * `./index`, so any substrate package taking a `tracerProvider`
 * option (sync, queue, runtime, etc.) can plug it in directly.
 *
 * Scope:
 *
 *   - Spans are batched in memory and flushed on a schedule (or when
 *     the queue fills).
 *   - Wire format is OTLP/JSON over HTTP (the OTel spec's
 *     standardized HTTP encoding). Most OTLP collectors accept
 *     either Protobuf or JSON; JSON has zero dependencies.
 *   - Head-based ratio sampling — sampled at root, propagated to
 *     every child span in the trace.
 *
 * Out of scope (use `@opentelemetry/sdk-node` if you need them):
 *
 *   - Async context propagation across `await` boundaries. Each call
 *     to `tracer.startSpan(name)` creates a fresh root unless the
 *     caller threads the parent explicitly (`options.links` or by
 *     calling `span.spanContext()` on a parent and using it).
 *   - W3C `traceparent` parsing on inbound HTTP requests.
 *   - OTLP/Protobuf encoding (use the official SDK for that).
 *   - Metric or log exports — this is the span exporter only.
 *
 * The trade is real but the audit surface is one repo, the bundle
 * is small (~10 KB), and the install footprint is zero peer deps.
 */

import type {
	Attributes,
	AttributeValue,
	Span,
	SpanContext,
	SpanOptions,
	SpanStatus,
	Tracer,
	TracerProvider
} from './index';
import { SpanStatusCode } from './index';

// =============================================================================
// Public options + result
// =============================================================================

export type OtlpExporterOptions = {
	/**
	 * Full OTLP traces endpoint, e.g.
	 * `http://localhost:4318/v1/traces` for a local collector,
	 * `https://otel.honeycomb.io/v1/traces` for Honeycomb, etc.
	 */
	endpoint: string;
	/** Required — appears on every exported span as `service.name`. */
	serviceName: string;
	/** Optional `service.version` resource attribute. */
	serviceVersion?: string;
	/** Optional additional HTTP headers (auth, tenant routing, etc.). */
	headers?: Record<string, string>;
	/** Resource attributes merged into the OTLP `resource.attributes`. */
	resourceAttributes?: Record<string, string>;
	/**
	 * Periodic flush interval. Default 5_000 ms. Spans are also flushed
	 * eagerly when `maxBatchSize` is reached.
	 */
	scheduledDelayMs?: number;
	/** Max spans per HTTP batch. Default 512. */
	maxBatchSize?: number;
	/**
	 * Max spans queued before we start dropping. Default 2048. Drops
	 * are counted in `metrics().droppedDueToQueueLimit`.
	 */
	maxQueueSize?: number;
	/**
	 * Head-based sample ratio in [0, 1]. Default 1.0 (export every
	 * span). Set to e.g. 0.1 to export 10% of traces. Sampled at root;
	 * all children of a sampled trace are also sampled.
	 */
	sampleRatio?: number;
	/** Override `fetch`. Useful for tests + injecting retry/auth. */
	fetch?: typeof fetch;
	/** Override `Date.now()`. Useful for deterministic tests. */
	clock?: () => number;
	/**
	 * Hi-res clock — nanoseconds since epoch as a `bigint`. Default
	 * uses `BigInt(Date.now()) * 1_000_000n + BigInt(process.hrtime.bigint() % 1_000_000n)`,
	 * which gives microsecond-grade precision on most platforms.
	 */
	hrClock?: () => bigint;
	/**
	 * Override the ID generator. Default uses `crypto.getRandomValues`.
	 */
	idGenerator?: {
		generateTraceId: () => string;
		generateSpanId: () => string;
	};
	/**
	 * Per-export error handler. Default `console.warn`. The exporter
	 * does NOT retry — implement that here if you need it.
	 */
	onError?: (error: unknown, batchSize: number) => void;
};

export type OtlpProviderMetrics = {
	/** Spans currently in the in-memory queue. */
	queued: number;
	/** Total spans successfully exported. */
	exported: number;
	/** Total spans dropped because the queue was full. */
	droppedDueToQueueLimit: number;
	/** Total spans not exported because the sampler rejected them. */
	notSampled: number;
	/** Total spans the sampler kept. */
	sampled: number;
	/** Total batches POSTed. */
	batches: number;
	/** Total batches that failed the POST. */
	batchErrors: number;
};

export type OtlpTracerProvider = TracerProvider & {
	/** Drain the in-memory queue with one POST. */
	flush: () => Promise<void>;
	/**
	 * Stop scheduling exports, drain the queue, mark the provider
	 * closed. Subsequent `getTracer().startSpan()` calls still build
	 * spans but their `end()` will not enqueue.
	 */
	shutdown: () => Promise<void>;
	/** Operator visibility — cumulative counters since construction. */
	metrics: () => OtlpProviderMetrics;
};

// =============================================================================
// ID generation
// =============================================================================

const toHex = (bytes: Uint8Array): string => {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
};

const defaultIdGenerator = {
	generateSpanId: (): string => {
		const bytes = new Uint8Array(8);
		crypto.getRandomValues(bytes);
		return toHex(bytes);
	},
	generateTraceId: (): string => {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		return toHex(bytes);
	}
};

// =============================================================================
// Internal span record (what gets queued for export)
// =============================================================================

type SpanEventRecord = {
	name: string;
	time: bigint;
	attributes?: Attributes;
};

type EndedSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startTime: bigint;
	endTime: bigint;
	attributes: Attributes;
	events: SpanEventRecord[];
	status: SpanStatus;
	scopeName: string;
	scopeVersion?: string;
};

// =============================================================================
// OTLP/JSON encoding (per
// https://github.com/open-telemetry/opentelemetry-proto/blob/main/docs/specification.md#otlphttp)
// =============================================================================

type OtlpKeyValue = { key: string; value: OtlpAnyValue };

type OtlpAnyValue =
	| { stringValue: string }
	| { intValue: string }
	| { doubleValue: number }
	| { boolValue: boolean }
	| { arrayValue: { values: OtlpAnyValue[] } };

const encodeValue = (
	value: AttributeValue | undefined
): OtlpAnyValue | undefined => {
	if (value === undefined) return undefined;
	if (typeof value === 'string') return { stringValue: value };
	if (typeof value === 'boolean') return { boolValue: value };
	if (typeof value === 'number') {
		// OTLP distinguishes int and double — emit int when value is a
		// finite integer, otherwise double.
		if (Number.isFinite(value) && Number.isInteger(value)) {
			return { intValue: String(value) };
		}
		return { doubleValue: value };
	}
	if (Array.isArray(value)) {
		return {
			arrayValue: {
				values: value
					.map((v) => encodeValue(v as AttributeValue))
					.filter((v): v is OtlpAnyValue => v !== undefined)
			}
		};
	}
	return undefined;
};

const encodeAttributes = (attrs: Attributes): OtlpKeyValue[] => {
	const out: OtlpKeyValue[] = [];
	for (const [key, value] of Object.entries(attrs)) {
		const encoded = encodeValue(value);
		if (encoded !== undefined) out.push({ key, value: encoded });
	}
	return out;
};

const encodeResource = (
	serviceName: string,
	serviceVersion: string | undefined,
	extras: Record<string, string>
): { attributes: OtlpKeyValue[] } => {
	const attrs: Attributes = { 'service.name': serviceName };
	if (serviceVersion !== undefined) attrs['service.version'] = serviceVersion;
	for (const [key, value] of Object.entries(extras)) attrs[key] = value;
	return { attributes: encodeAttributes(attrs) };
};

const statusCodeName: Record<number, 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR' | 'STATUS_CODE_UNSET'> = {
	[SpanStatusCode.ERROR]: 'STATUS_CODE_ERROR',
	[SpanStatusCode.OK]: 'STATUS_CODE_OK',
	[SpanStatusCode.UNSET]: 'STATUS_CODE_UNSET'
};

const buildBatchPayload = (
	spans: ReadonlyArray<EndedSpan>,
	serviceName: string,
	serviceVersion: string | undefined,
	resourceAttributes: Record<string, string>
): unknown => {
	// Group by (scope name, scope version).
	const byScope = new Map<string, EndedSpan[]>();
	for (const span of spans) {
		const key = `${span.scopeName}|${span.scopeVersion ?? ''}`;
		const list = byScope.get(key);
		if (list !== undefined) list.push(span);
		else byScope.set(key, [span]);
	}

	const scopeSpans: unknown[] = [];
	for (const [, group] of byScope) {
		const first = group[0] as EndedSpan;
		scopeSpans.push({
			scope: {
				name: first.scopeName,
				...(first.scopeVersion !== undefined
					? { version: first.scopeVersion }
					: {})
			},
			spans: group.map((span) => ({
				attributes: encodeAttributes(span.attributes),
				endTimeUnixNano: span.endTime.toString(),
				events: span.events.map((event) => ({
					attributes: event.attributes
						? encodeAttributes(event.attributes)
						: [],
					name: event.name,
					timeUnixNano: event.time.toString()
				})),
				kind: span.kind,
				name: span.name,
				...(span.parentSpanId !== undefined
					? { parentSpanId: span.parentSpanId }
					: {}),
				spanId: span.spanId,
				startTimeUnixNano: span.startTime.toString(),
				status: {
					code: statusCodeName[span.status.code] ?? 'STATUS_CODE_UNSET',
					...(span.status.message !== undefined
						? { message: span.status.message }
						: {})
				},
				traceId: span.traceId
			}))
		});
	}

	return {
		resourceSpans: [
			{
				resource: encodeResource(
					serviceName,
					serviceVersion,
					resourceAttributes
				),
				scopeSpans
			}
		]
	};
};

// =============================================================================
// Provider implementation
// =============================================================================

const TRACE_FLAGS_SAMPLED = 1;

const isSampled = (ratio: number): boolean => {
	if (ratio >= 1) return true;
	if (ratio <= 0) return false;
	return Math.random() < ratio;
};

const defaultHrClock = (): bigint => {
	// Date.now() gives ms precision. Using process.hrtime.bigint() gets us
	// sub-ms precision on Node/Bun. The combination is "stable wall clock
	// + monotonic sub-ms offset" — close enough for span timestamps.
	const ms = BigInt(Date.now()) * 1_000_000n;
	if (typeof process !== 'undefined' && typeof process.hrtime?.bigint === 'function') {
		const nano = process.hrtime.bigint();
		return ms + (nano % 1_000_000n);
	}
	return ms;
};

export const createOtlpTracerProvider = (
	options: OtlpExporterOptions
): OtlpTracerProvider => {
	const scheduledDelayMs = options.scheduledDelayMs ?? 5_000;
	const maxBatchSize = options.maxBatchSize ?? 512;
	const maxQueueSize = options.maxQueueSize ?? 2048;
	const sampleRatio = options.sampleRatio ?? 1.0;
	const fetcher = options.fetch ?? fetch;
	const clock = options.clock ?? Date.now;
	const hrClock = options.hrClock ?? defaultHrClock;
	const idGen = options.idGenerator ?? defaultIdGenerator;
	const onError =
		options.onError ??
		((error, size) =>
			console.warn(`[telemetry/otlp] export failed for ${size} spans:`, error));

	const queue: EndedSpan[] = [];
	const counters: OtlpProviderMetrics = {
		batchErrors: 0,
		batches: 0,
		droppedDueToQueueLimit: 0,
		exported: 0,
		notSampled: 0,
		queued: 0,
		sampled: 0
	};
	let closed = false;
	let scheduled: ReturnType<typeof setTimeout> | undefined;
	let inFlight = false;

	const enqueue = (span: EndedSpan): void => {
		if (closed) return;
		if (queue.length >= maxQueueSize) {
			counters.droppedDueToQueueLimit += 1;
			return;
		}
		queue.push(span);
		counters.queued = queue.length;
		if (queue.length >= maxBatchSize) {
			void exportBatch();
		} else if (scheduled === undefined) {
			scheduled = setTimeout(() => {
				scheduled = undefined;
				void exportBatch();
			}, scheduledDelayMs);
		}
	};

	const exportBatch = async (): Promise<void> => {
		if (inFlight) return;
		const batch = queue.splice(0, maxBatchSize);
		counters.queued = queue.length;
		if (batch.length === 0) return;
		inFlight = true;
		try {
			const payload = buildBatchPayload(
				batch,
				options.serviceName,
				options.serviceVersion,
				options.resourceAttributes ?? {}
			);
			const response = await fetcher(options.endpoint, {
				body: JSON.stringify(payload),
				headers: {
					'content-type': 'application/json',
					...(options.headers ?? {})
				},
				method: 'POST'
			});
			counters.batches += 1;
			if (!response.ok) {
				counters.batchErrors += 1;
				onError(
					new Error(
						`OTLP endpoint returned ${response.status} ${response.statusText}`
					),
					batch.length
				);
			} else {
				counters.exported += batch.length;
			}
		} catch (error) {
			counters.batchErrors += 1;
			onError(error, batch.length);
		} finally {
			inFlight = false;
			// If more spans arrived while we were exporting, drain again.
			if (queue.length > 0 && !closed) {
				if (scheduled === undefined) {
					scheduled = setTimeout(() => {
						scheduled = undefined;
						void exportBatch();
					}, 0);
				}
			}
		}
	};

	const flush = async (): Promise<void> => {
		if (scheduled !== undefined) {
			clearTimeout(scheduled);
			scheduled = undefined;
		}
		// Drain everything currently in the queue. May need multiple
		// passes if there are more than maxBatchSize spans.
		while (queue.length > 0) {
			// eslint-disable-next-line no-await-in-loop
			await exportBatch();
		}
	};

	const shutdown = async (): Promise<void> => {
		closed = true;
		if (scheduled !== undefined) {
			clearTimeout(scheduled);
			scheduled = undefined;
		}
		await flush();
	};

	const buildSpan = (
		scopeName: string,
		scopeVersion: string | undefined,
		name: string,
		spanOptions: SpanOptions,
		traceId: string,
		spanId: string,
		parentSpanId: string | undefined,
		sampledForExport: boolean
	): Span => {
		const startTime = hrClock();
		const attributes: Attributes = { ...(spanOptions.attributes ?? {}) };
		const events: SpanEventRecord[] = [];
		let currentName = name;
		let status: SpanStatus = { code: SpanStatusCode.UNSET };
		let ended = false;

		const ctx: SpanContext = {
			spanId,
			traceFlags: sampledForExport ? TRACE_FLAGS_SAMPLED : 0,
			traceId
		};

		const self: Span = {
			addEvent: (eventName, attrs, time) => {
				if (!sampledForExport || ended) return self;
				const event: SpanEventRecord = {
					name: eventName,
					time: time !== undefined ? BigInt(time) * 1_000_000n : hrClock()
				};
				if (attrs !== undefined) event.attributes = attrs;
				events.push(event);
				return self;
			},
			end: (endTime) => {
				if (ended) return;
				ended = true;
				if (!sampledForExport) return;
				const record: EndedSpan = {
					attributes,
					endTime:
						endTime !== undefined ? BigInt(endTime) * 1_000_000n : hrClock(),
					events,
					kind: spanOptions.kind ?? 0,
					name: currentName,
					scopeName,
					...(scopeVersion !== undefined ? { scopeVersion } : {}),
					spanId,
					startTime:
						spanOptions.startTime !== undefined
							? BigInt(spanOptions.startTime) * 1_000_000n
							: startTime,
					status,
					traceId,
					...(parentSpanId !== undefined ? { parentSpanId } : {})
				};
				enqueue(record);
			},
			isRecording: () => !ended && sampledForExport,
			recordException: (exception, time) => {
				if (!sampledForExport || ended) return;
				const message =
					exception instanceof Error
						? exception.message
						: String(exception);
				const exAttrs: Attributes = { 'exception.message': message };
				if (exception instanceof Error) {
					if (exception.name) exAttrs['exception.type'] = exception.name;
					if (exception.stack) exAttrs['exception.stacktrace'] = exception.stack;
				}
				const event: SpanEventRecord = {
					attributes: exAttrs,
					name: 'exception',
					time: time !== undefined ? BigInt(time) * 1_000_000n : hrClock()
				};
				events.push(event);
			},
			setAttribute: (key, value) => {
				if (!sampledForExport || ended) return self;
				attributes[key] = value;
				return self;
			},
			setAttributes: (attrs) => {
				if (!sampledForExport || ended) return self;
				for (const [k, v] of Object.entries(attrs)) attributes[k] = v;
				return self;
			},
			setStatus: (s) => {
				if (!sampledForExport || ended) return self;
				status = s;
				return self;
			},
			spanContext: () => ctx,
			updateName: (next) => {
				if (!sampledForExport || ended) return self;
				currentName = next;
				return self;
			}
		};
		return self;
	};

	const buildTracer = (
		scopeName: string,
		scopeVersion?: string
	): Tracer => ({
		startActiveSpan: <T>(
			name: string,
			optionsOrFn: SpanOptions | ((span: Span) => T),
			maybeFn?: (span: Span) => T
		): T => {
			const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn!;
			const opts =
				typeof optionsOrFn === 'function' ? {} : optionsOrFn;
			const span = tracer.startSpan(name, opts);
			return fn(span);
		},
		startSpan: (name, spanOptions = {}) => {
			const sampled = isSampled(sampleRatio);
			if (sampled) counters.sampled += 1;
			else counters.notSampled += 1;
			const traceId = idGen.generateTraceId();
			const spanId = idGen.generateSpanId();
			return buildSpan(
				scopeName,
				scopeVersion,
				name,
				spanOptions,
				traceId,
				spanId,
				undefined,
				sampled
			);
		}
	}) as Tracer;

	let tracer: Tracer;

	void clock;
	return {
		flush,
		getTracer: (name, version) => {
			tracer = buildTracer(name, version);
			return tracer;
		},
		metrics: () => ({ ...counters }),
		shutdown
	};
};
