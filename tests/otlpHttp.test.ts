/**
 * Tests for the OTLP-HTTP-JSON span exporter. Mocks `fetch` and the
 * clock + id generator so every assertion is deterministic — no real
 * network IO, no time-flake.
 */
import { describe, expect, test } from 'bun:test';
import {
	createOtlpTracerProvider,
	type OtlpExporterOptions
} from '../src/otlpHttp';
import { SpanStatusCode } from '../src/index';

const flushTicks = async (): Promise<void> => {
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

type RecordedRequest = {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
};

const makeFetchMock = (
	responses: Array<{ status: number; body?: string }> = [{ status: 200 }]
): { fetch: typeof fetch; calls: RecordedRequest[] } => {
	const calls: RecordedRequest[] = [];
	let cursor = 0;
	const fetcher = (async (
		url: string | URL | Request,
		init?: RequestInit
	) => {
		const headers: Record<string, string> = {};
		const initHeaders = init?.headers;
		if (initHeaders !== undefined) {
			if (initHeaders instanceof Headers) {
				initHeaders.forEach((value, key) => {
					headers[key] = value;
				});
			} else if (Array.isArray(initHeaders)) {
				for (const [key, value] of initHeaders) headers[key] = value;
			} else {
				Object.assign(headers, initHeaders as Record<string, string>);
			}
		}
		const bodyText = typeof init?.body === 'string' ? init.body : '';
		calls.push({
			body: bodyText.length > 0 ? JSON.parse(bodyText) : undefined,
			headers,
			method: init?.method ?? 'GET',
			url: url.toString()
		});
		const response = responses[Math.min(cursor, responses.length - 1)];
		cursor += 1;
		return new Response(response?.body ?? '', { status: response?.status ?? 200 });
	}) as unknown as typeof fetch;
	return { calls, fetch: fetcher };
};

const baseOptions = (
	overrides: Partial<OtlpExporterOptions> = {}
): OtlpExporterOptions => ({
	endpoint: 'http://collector.test/v1/traces',
	idGenerator: (() => {
		let span = 0;
		let trace = 0;
		return {
			generateSpanId: () => {
				span += 1;
				return span.toString(16).padStart(16, '0');
			},
			generateTraceId: () => {
				trace += 1;
				return trace.toString(16).padStart(32, '0');
			}
		};
	})(),
	maxBatchSize: 512,
	maxQueueSize: 2048,
	sampleRatio: 1,
	scheduledDelayMs: 50,
	serviceName: 'test-service',
	serviceVersion: '1.0.0',
	...overrides
});

// =============================================================================
// Span lifecycle
// =============================================================================

describe('startSpan / end / flush', () => {
	test('a single completed span is POSTed to the endpoint on flush', async () => {
		const { fetch: fakeFetch, calls } = makeFetchMock();
		const provider = createOtlpTracerProvider(
			baseOptions({ fetch: fakeFetch })
		);
		const tracer = provider.getTracer('@absolutejs/test');
		const span = tracer.startSpan('do-work');
		span.setAttribute('user.id', 'u_42');
		span.setStatus({ code: SpanStatusCode.OK });
		span.end();
		await provider.flush();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.url).toBe('http://collector.test/v1/traces');
		expect(calls[0]?.headers['content-type']).toBe('application/json');
		const payload = calls[0]?.body as {
			resourceSpans: Array<{
				resource: { attributes: Array<{ key: string }> };
				scopeSpans: Array<{
					scope: { name: string };
					spans: Array<{ name: string; attributes: Array<{ key: string }> }>;
				}>;
			}>;
		};
		const resourceAttrs = payload.resourceSpans[0]!.resource.attributes.map(
			(a) => a.key
		);
		expect(resourceAttrs).toContain('service.name');
		expect(resourceAttrs).toContain('service.version');
		expect(payload.resourceSpans[0]!.scopeSpans[0]!.scope.name).toBe(
			'@absolutejs/test'
		);
		const exportedSpan = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
		expect(exportedSpan.name).toBe('do-work');
		const spanAttrKeys = exportedSpan.attributes.map((a) => a.key);
		expect(spanAttrKeys).toContain('user.id');
	});

	test('flush is idempotent on an empty queue', async () => {
		const { fetch: fakeFetch, calls } = makeFetchMock();
		const provider = createOtlpTracerProvider(
			baseOptions({ fetch: fakeFetch })
		);
		await provider.flush();
		await provider.flush();
		expect(calls).toHaveLength(0);
	});

	test('span.end() is a no-op the second time', async () => {
		const { fetch: fakeFetch, calls } = makeFetchMock();
		const provider = createOtlpTracerProvider(
			baseOptions({ fetch: fakeFetch })
		);
		const tracer = provider.getTracer('test');
		const span = tracer.startSpan('once');
		span.end();
		span.end(); // no-op
		await provider.flush();
		const payload = calls[0]?.body as {
			resourceSpans: Array<{
				scopeSpans: Array<{ spans: unknown[] }>;
			}>;
		};
		expect(payload.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(1);
	});
});

// =============================================================================
// Attribute encoding
// =============================================================================

describe('attribute encoding', () => {
	test('strings, ints, doubles, bools, arrays encode per OTLP/JSON', async () => {
		const { fetch: fakeFetch, calls } = makeFetchMock();
		const provider = createOtlpTracerProvider(
			baseOptions({ fetch: fakeFetch })
		);
		const span = provider.getTracer('test').startSpan('attrs');
		span.setAttributes({
			'arr.numbers': [1, 2, 3],
			'arr.strings': ['a', 'b'],
			'bool.value': true,
			'double.value': 3.14,
			'int.value': 42,
			'string.value': 'hello'
		});
		span.end();
		await provider.flush();

		const exported = (calls[0]!.body as {
			resourceSpans: Array<{
				scopeSpans: Array<{
					spans: Array<{ attributes: Array<{ key: string; value: unknown }> }>;
				}>;
			}>;
		}).resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
		const byKey: Record<string, unknown> = {};
		for (const a of exported) byKey[a.key] = a.value;
		expect(byKey['string.value']).toEqual({ stringValue: 'hello' });
		expect(byKey['int.value']).toEqual({ intValue: '42' });
		expect(byKey['double.value']).toEqual({ doubleValue: 3.14 });
		expect(byKey['bool.value']).toEqual({ boolValue: true });
		expect(byKey['arr.strings']).toEqual({
			arrayValue: {
				values: [{ stringValue: 'a' }, { stringValue: 'b' }]
			}
		});
		expect(byKey['arr.numbers']).toEqual({
			arrayValue: {
				values: [
					{ intValue: '1' },
					{ intValue: '2' },
					{ intValue: '3' }
				]
			}
		});
	});
});

// =============================================================================
// Events + status + exceptions
// =============================================================================

describe('events + status + exceptions', () => {
	test('addEvent + recordException land on the exported span', async () => {
		const { fetch: fakeFetch, calls } = makeFetchMock();
		const provider = createOtlpTracerProvider(
			baseOptions({ fetch: fakeFetch })
		);
		const span = provider.getTracer('test').startSpan('with-events');
		span.addEvent('checkpoint', { stage: 'before' });
		span.recordException(new Error('boom'));
		span.setStatus({ code: SpanStatusCode.ERROR, message: 'boom' });
		span.end();
		await provider.flush();

		const exported = (calls[0]!.body as {
			resourceSpans: Array<{
				scopeSpans: Array<{
					spans: Array<{
						events: Array<{ name: string; attributes: Array<{ key: string }> }>;
						status: { code: string; message?: string };
					}>;
				}>;
			}>;
		}).resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
		expect(exported.events.map((e) => e.name)).toEqual([
			'checkpoint',
			'exception'
		]);
		const exception = exported.events.find((e) => e.name === 'exception');
		const keys = exception?.attributes.map((a) => a.key) ?? [];
		expect(keys).toContain('exception.message');
		expect(keys).toContain('exception.type');
		expect(exported.status.code).toBe('STATUS_CODE_ERROR');
		expect(exported.status.message).toBe('boom');
	});
});

// =============================================================================
// Sampling
// =============================================================================

describe('sampling', () => {
	test('sampleRatio=0 drops every span before export', async () => {
		const { fetch: fakeFetch, calls } = makeFetchMock();
		const provider = createOtlpTracerProvider(
			baseOptions({ fetch: fakeFetch, sampleRatio: 0 })
		);
		const span = provider.getTracer('test').startSpan('dropped');
		span.setAttribute('user.id', 'u_42');
		span.end();
		await provider.flush();
		expect(calls).toHaveLength(0);
		const m = provider.metrics();
		expect(m.notSampled).toBe(1);
		expect(m.sampled).toBe(0);
	});

	test('sampleRatio=1 keeps every span', async () => {
		const { fetch: fakeFetch, calls } = makeFetchMock();
		const provider = createOtlpTracerProvider(
			baseOptions({ fetch: fakeFetch, sampleRatio: 1 })
		);
		for (let i = 0; i < 5; i += 1) {
			provider.getTracer('test').startSpan(`s-${i}`).end();
		}
		await provider.flush();
		expect(calls).toHaveLength(1);
		expect(provider.metrics().sampled).toBe(5);
	});

	test('isRecording is false for non-sampled spans', () => {
		const { fetch: fakeFetch } = makeFetchMock();
		const provider = createOtlpTracerProvider(
			baseOptions({ fetch: fakeFetch, sampleRatio: 0 })
		);
		const span = provider.getTracer('test').startSpan('dropped');
		expect(span.isRecording()).toBe(false);
	});
});

// =============================================================================
// Batching + queue limits
// =============================================================================

describe('batching + queue limits', () => {
	test('queue overflows are counted in droppedDueToQueueLimit', async () => {
		const { fetch: fakeFetch } = makeFetchMock();
		const provider = createOtlpTracerProvider(
			baseOptions({
				fetch: fakeFetch,
				maxBatchSize: 1000, // don't auto-flush
				maxQueueSize: 5,
				scheduledDelayMs: 100_000
			})
		);
		const tracer = provider.getTracer('test');
		for (let i = 0; i < 20; i += 1) tracer.startSpan(`s-${i}`).end();
		expect(provider.metrics().droppedDueToQueueLimit).toBe(15);
		await provider.shutdown();
	});

	test('exporting a full batch is triggered when maxBatchSize is reached', async () => {
		const { fetch: fakeFetch, calls } = makeFetchMock();
		const provider = createOtlpTracerProvider(
			baseOptions({
				fetch: fakeFetch,
				maxBatchSize: 3,
				scheduledDelayMs: 100_000
			})
		);
		const tracer = provider.getTracer('test');
		tracer.startSpan('a').end();
		tracer.startSpan('b').end();
		tracer.startSpan('c').end();
		// Three spans = full batch → eager export.
		await flushTicks();
		expect(calls).toHaveLength(1);
		await provider.shutdown();
	});
});

// =============================================================================
// Error handling
// =============================================================================

describe('error handling', () => {
	test('non-2xx response counts as batchError and fires onError', async () => {
		const { fetch: fakeFetch } = makeFetchMock([{ status: 503 }]);
		const errors: unknown[] = [];
		const provider = createOtlpTracerProvider(
			baseOptions({
				fetch: fakeFetch,
				onError: (err) => errors.push(err)
			})
		);
		provider.getTracer('test').startSpan('x').end();
		await provider.flush();
		const m = provider.metrics();
		expect(m.batchErrors).toBe(1);
		expect(m.exported).toBe(0);
		expect(errors).toHaveLength(1);
	});

	test('fetch rejection counts as batchError', async () => {
		const failingFetch = (async () => {
			throw new Error('network down');
		}) as unknown as typeof fetch;
		const errors: unknown[] = [];
		const provider = createOtlpTracerProvider(
			baseOptions({
				fetch: failingFetch,
				onError: (err) => errors.push(err)
			})
		);
		provider.getTracer('test').startSpan('x').end();
		await provider.flush();
		expect(provider.metrics().batchErrors).toBe(1);
		expect((errors[0] as Error).message).toBe('network down');
	});
});

// =============================================================================
// Custom headers + resource attributes
// =============================================================================

describe('custom headers + resource attributes', () => {
	test('headers are forwarded on every POST', async () => {
		const { fetch: fakeFetch, calls } = makeFetchMock();
		const provider = createOtlpTracerProvider(
			baseOptions({
				fetch: fakeFetch,
				headers: { 'x-team': 'platform', 'x-tenant': 'acme' }
			})
		);
		provider.getTracer('test').startSpan('x').end();
		await provider.flush();
		expect(calls[0]?.headers['x-team']).toBe('platform');
		expect(calls[0]?.headers['x-tenant']).toBe('acme');
	});

	test('resourceAttributes are merged into the resource object', async () => {
		const { fetch: fakeFetch, calls } = makeFetchMock();
		const provider = createOtlpTracerProvider(
			baseOptions({
				fetch: fakeFetch,
				resourceAttributes: {
					'deployment.environment': 'production',
					region: 'us-east-2'
				}
			})
		);
		provider.getTracer('test').startSpan('x').end();
		await provider.flush();
		const payload = calls[0]!.body as {
			resourceSpans: Array<{
				resource: {
					attributes: Array<{
						key: string;
						value: { stringValue?: string };
					}>;
				};
			}>;
		};
		const byKey: Record<string, string | undefined> = {};
		for (const a of payload.resourceSpans[0]!.resource.attributes) {
			byKey[a.key] = a.value.stringValue;
		}
		expect(byKey['service.name']).toBe('test-service');
		expect(byKey['service.version']).toBe('1.0.0');
		expect(byKey.region).toBe('us-east-2');
		expect(byKey['deployment.environment']).toBe('production');
	});
});

// =============================================================================
// shutdown
// =============================================================================

describe('shutdown', () => {
	test('drains the queue + ignores subsequent enqueues', async () => {
		const { fetch: fakeFetch, calls } = makeFetchMock();
		const provider = createOtlpTracerProvider(
			baseOptions({ fetch: fakeFetch })
		);
		provider.getTracer('test').startSpan('x').end();
		await provider.shutdown();
		expect(calls).toHaveLength(1);
		// After shutdown, new spans are not enqueued.
		const span = provider.getTracer('test').startSpan('after');
		span.end();
		expect(provider.metrics().queued).toBe(0);
	});
});

// =============================================================================
// metrics
// =============================================================================

describe('metrics', () => {
	test('counters accumulate across batches', async () => {
		const { fetch: fakeFetch } = makeFetchMock([
			{ status: 200 },
			{ status: 500 }
		]);
		const provider = createOtlpTracerProvider(
			baseOptions({
				fetch: fakeFetch,
				maxBatchSize: 2,
				onError: () => {},
				scheduledDelayMs: 100_000
			})
		);
		const tracer = provider.getTracer('test');
		tracer.startSpan('a').end();
		tracer.startSpan('b').end();
		await flushTicks();
		// Second batch
		tracer.startSpan('c').end();
		tracer.startSpan('d').end();
		await flushTicks();
		await provider.shutdown();

		const m = provider.metrics();
		expect(m.sampled).toBe(4);
		expect(m.batches).toBe(2);
		expect(m.batchErrors).toBe(1);
		expect(m.exported).toBe(2); // only the first batch succeeded
	});
});

// =============================================================================
// startActiveSpan
// =============================================================================

describe('startActiveSpan', () => {
	test('runs the fn with the new span + returns its value', async () => {
		const { fetch: fakeFetch, calls } = makeFetchMock();
		const provider = createOtlpTracerProvider(
			baseOptions({ fetch: fakeFetch })
		);
		const result = provider.getTracer('test').startActiveSpan(
			'wrap',
			(span) => {
				span.setAttribute('inside', 'true');
				span.end();
				return 42;
			}
		);
		expect(result).toBe(42);
		await provider.flush();
		expect(calls).toHaveLength(1);
		const payload = calls[0]!.body as {
			resourceSpans: Array<{
				scopeSpans: Array<{
					spans: Array<{ name: string }>;
				}>;
			}>;
		};
		expect(payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name).toBe('wrap');
	});
});
