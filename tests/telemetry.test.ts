import { describe, expect, test } from 'bun:test';
import {
	ABS_ATTRS,
	createNoopSpan,
	createNoopTracer,
	createNoopTracerProvider,
	SpanKind,
	SpanStatusCode,
	tracerOrNoop,
	withSpan,
	withSpanSync,
	type Span,
	type Tracer,
	type TracerProvider
} from '../src/index';

/**
 * A tiny mock tracer that captures every span lifecycle. Used to
 * verify the convenience wrappers (`withSpan` / `withSpanSync`) set
 * status + record exceptions correctly without needing a real OTel
 * SDK installed.
 */
const makeMockTracer = (): {
	tracer: Tracer;
	spans: Array<{
		name: string;
		attrs: Record<string, unknown>;
		events: Array<{ name: string; attrs?: Record<string, unknown> }>;
		status?: { code: number; message?: string };
		exception?: unknown;
		ended: boolean;
	}>;
} => {
	const spans: Array<{
		name: string;
		attrs: Record<string, unknown>;
		events: Array<{ name: string; attrs?: Record<string, unknown> }>;
		status?: { code: number; message?: string };
		exception?: unknown;
		ended: boolean;
	}> = [];
	const tracer: Tracer = {
		startSpan: () => createNoopSpan(),
		startActiveSpan: ((
			name: string,
			optionsOrFn: unknown,
			maybeFn?: unknown
		) => {
			const fn =
				typeof optionsOrFn === 'function'
					? (optionsOrFn as (span: Span) => unknown)
					: (maybeFn as (span: Span) => unknown);
			const options = (typeof optionsOrFn === 'function'
				? {}
				: optionsOrFn ?? {}) as { attributes?: Record<string, unknown> };
			const record = {
				attrs: { ...(options.attributes ?? {}) },
				ended: false,
				events: [] as Array<{
					name: string;
					attrs?: Record<string, unknown>;
				}>,
				exception: undefined as unknown,
				name,
				status: undefined as
					| { code: number; message?: string }
					| undefined
			};
			spans.push(record);
			const span: Span = {
				addEvent: (eventName, attrs) => {
					record.events.push({ attrs, name: eventName });
					return span;
				},
				end: () => {
					record.ended = true;
				},
				isRecording: () => !record.ended,
				recordException: (exception) => {
					record.exception = exception;
				},
				setAttribute: (key, value) => {
					record.attrs[key] = value;
					return span;
				},
				setAttributes: (attrs) => {
					Object.assign(record.attrs, attrs);
					return span;
				},
				setStatus: (status) => {
					record.status = status;
					return span;
				},
				spanContext: () => createNoopSpan().spanContext(),
				updateName: () => span
			};
			return fn(span);
		}) as Tracer['startActiveSpan']
	};
	return { spans, tracer };
};

describe('noop tracer / span / provider', () => {
	test('createNoopSpan().end() is a no-op and reusable', () => {
		const span = createNoopSpan();
		span.setAttribute('a', 1);
		span.setStatus({ code: SpanStatusCode.OK });
		span.recordException(new Error('boom'));
		span.end();
		expect(span.isRecording()).toBe(false);
	});

	test('createNoopTracer() invokes the callback with a noop span and returns its result', () => {
		const tracer = createNoopTracer();
		const value = tracer.startActiveSpan('any', (span) => {
			span.setAttribute('foo', 'bar');
			return 42;
		});
		expect(value).toBe(42);
	});

	test('createNoopTracerProvider().getTracer() returns the noop tracer', () => {
		const provider = createNoopTracerProvider();
		const tracer = provider.getTracer('test');
		expect(
			tracer.startActiveSpan('x', () => 'result')
		).toBe('result');
	});

	test('startActiveSpan accepts the (name, options, fn) form', () => {
		const tracer = createNoopTracer();
		const result = tracer.startActiveSpan(
			'with-options',
			{ kind: SpanKind.SERVER },
			(span) => {
				span.setAttribute('hint', 'noop');
				return 'ok';
			}
		);
		expect(result).toBe('ok');
	});
});

describe('tracerOrNoop()', () => {
	test('returns the provider tracer when present', () => {
		const { tracer: mock, spans } = makeMockTracer();
		const provider: TracerProvider = {
			getTracer: () => mock
		};
		const tracer = tracerOrNoop(provider, '@absolutejs/test');
		tracer.startActiveSpan('span-1', () => 'ok');
		expect(spans).toHaveLength(1);
		expect(spans[0]!.name).toBe('span-1');
	});

	test('returns the noop tracer when provider is undefined', () => {
		const tracer = tracerOrNoop(undefined, '@absolutejs/test');
		const result = tracer.startActiveSpan('noop', () => 'still-ok');
		expect(result).toBe('still-ok');
	});

	test('passes the package name + version through to provider.getTracer', () => {
		const calls: Array<{ name: string; version?: string }> = [];
		const provider: TracerProvider = {
			getTracer: (name, version) => {
				calls.push({ name, version });
				return createNoopTracer();
			}
		};
		tracerOrNoop(provider, '@absolutejs/sync', '1.21.0');
		expect(calls).toEqual([
			{ name: '@absolutejs/sync', version: '1.21.0' }
		]);
	});
});

describe('withSpan() — async wrapper', () => {
	test('sets status OK on success and ends the span', async () => {
		const { tracer, spans } = makeMockTracer();
		const result = await withSpan(
			tracer,
			'op',
			{ attributes: { [ABS_ATTRS.tenant]: 'acme' } },
			async (span) => {
				span.setAttribute(ABS_ATTRS.collection, 'tasks');
				return 'done';
			}
		);
		expect(result).toBe('done');
		expect(spans).toHaveLength(1);
		expect(spans[0]!.status?.code).toBe(SpanStatusCode.OK);
		expect(spans[0]!.attrs[ABS_ATTRS.tenant]).toBe('acme');
		expect(spans[0]!.attrs[ABS_ATTRS.collection]).toBe('tasks');
		expect(spans[0]!.ended).toBe(true);
	});

	test('captures exception + rethrows', async () => {
		const { tracer, spans } = makeMockTracer();
		await expect(
			withSpan(tracer, 'op', {}, async () => {
				throw new Error('kaboom');
			})
		).rejects.toThrow('kaboom');
		expect(spans[0]!.status?.code).toBe(SpanStatusCode.ERROR);
		expect(spans[0]!.status?.message).toBe('kaboom');
		expect(spans[0]!.exception).toBeInstanceOf(Error);
		expect(spans[0]!.ended).toBe(true);
	});

	test('non-Error throws are stringified for status.message', async () => {
		const { tracer, spans } = makeMockTracer();
		await expect(
			withSpan(tracer, 'op', {}, async () => {
				// eslint-disable-next-line @typescript-eslint/no-throw-literal
				throw 'string-error';
			})
		).rejects.toBe('string-error');
		expect(spans[0]!.status?.message).toBe('string-error');
	});
});

describe('withSpanSync() — sync wrapper', () => {
	test('sets OK status + returns sync value', () => {
		const { tracer, spans } = makeMockTracer();
		const value = withSpanSync(
			tracer,
			'sync.op',
			{},
			(span) => {
				span.setAttribute('x', 1);
				return 99;
			}
		);
		expect(value).toBe(99);
		expect(spans[0]!.status?.code).toBe(SpanStatusCode.OK);
		expect(spans[0]!.ended).toBe(true);
	});

	test('captures + rethrows sync errors', () => {
		const { tracer, spans } = makeMockTracer();
		expect(() =>
			withSpanSync(tracer, 'sync.op', {}, () => {
				throw new Error('sync boom');
			})
		).toThrow('sync boom');
		expect(spans[0]!.status?.code).toBe(SpanStatusCode.ERROR);
		expect(spans[0]!.exception).toBeInstanceOf(Error);
	});
});

describe('readActiveTraceId() — 0.0.3', () => {
	test('returns undefined when @opentelemetry/api is not installed', async () => {
		const { readActiveTraceId } = await import('../src/index');
		const traceId = await readActiveTraceId();
		expect(traceId).toBeUndefined();
	});

	test('handles dynamic import failure gracefully (no throw)', async () => {
		const { readActiveTraceId } = await import('../src/index');
		// In the test environment OTel isn't installed; just verify
		// the helper never throws.
		await expect(readActiveTraceId()).resolves.toBeUndefined();
	});
});

describe('ABS_ATTRS — semantic conventions', () => {
	test('attribute names are stable strings', () => {
		// Treat as part of the public contract — these are the names
		// every substrate package emits.
		expect(ABS_ATTRS.tenant).toBe('abs.tenant');
		expect(ABS_ATTRS.engineId).toBe('abs.engine.id');
		expect(ABS_ATTRS.collection).toBe('abs.collection');
		expect(ABS_ATTRS.mutation).toBe('abs.mutation');
		expect(ABS_ATTRS.jobKind).toBe('abs.job.kind');
		expect(ABS_ATTRS.jobId).toBe('abs.job.id');
		expect(ABS_ATTRS.runtimeKey).toBe('abs.runtime.key');
		expect(ABS_ATTRS.runtimeExitReason).toBe('abs.runtime.exit_reason');
	});
});
