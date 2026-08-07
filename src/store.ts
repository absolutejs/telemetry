export type TelemetryAttributeScalar = boolean | number | string;

export type TelemetryAttributeValue =
  | TelemetryAttributeScalar
  | TelemetryAttributeScalar[];

export type TelemetryAttributes = Record<string, TelemetryAttributeValue>;

export type StoredSpanEvent = {
  attributes: TelemetryAttributes;
  name: string;
  timeUnixNano: string;
};

export type StoredSpanLink = {
  attributes: TelemetryAttributes;
  spanId: string;
  traceId: string;
  traceState?: string;
};

export type StoredSpan = {
  attributes: TelemetryAttributes;
  durationNano: string;
  endedAtUnixNano: string;
  events: StoredSpanEvent[];
  kind: number;
  links: StoredSpanLink[];
  name: string;
  parentSpanId?: string;
  resourceAttributes: TelemetryAttributes;
  scopeName: string;
  scopeVersion?: string;
  serviceName: string;
  spanId: string;
  startedAtUnixNano: string;
  statusCode: number;
  statusMessage?: string;
  traceFlags: number;
  traceId: string;
  traceState?: string;
};

export type TraceSummary = {
  durationNano: string;
  endedAtUnixNano: string;
  errorSpanCount: number;
  rootName: string;
  serviceNames: string[];
  spanCount: number;
  startedAtUnixNano: string;
  traceId: string;
};

export type TraceFilter = {
  limit?: number;
  serviceName?: string;
  sinceUnixNano?: string;
  statusCode?: number;
  untilUnixNano?: string;
};

export type TraceStore = {
  getTrace: (traceId: string) => Promise<StoredSpan[]>;
  listTraces: (filter?: TraceFilter) => Promise<TraceSummary[]>;
  prune: (beforeUnixNano: string) => Promise<number>;
  write: (spans: readonly StoredSpan[]) => Promise<void>;
};

type HrTime = readonly [number, number];

type SpanContextLike = {
  spanId: string;
  traceFlags: number;
  traceId: string;
  traceState?: { serialize: () => string };
};

type SpanEventLike = {
  attributes?: Record<string, unknown>;
  name: string;
  time: HrTime;
};

type SpanLinkLike = {
  attributes?: Record<string, unknown>;
  context: SpanContextLike;
};

export type ReadableSpanLike = {
  attributes: Record<string, unknown>;
  duration: HrTime;
  endTime: HrTime;
  events: SpanEventLike[];
  instrumentationScope?: { name: string; version?: string };
  kind: number;
  links: SpanLinkLike[];
  name: string;
  parentSpanContext?: SpanContextLike;
  resource: { attributes: Record<string, unknown> };
  spanContext: () => SpanContextLike;
  startTime: HrTime;
  status: { code: number; message?: string };
};

export type SpanExportResult = {
	code: 0 | 1;
  error?: Error;
};

export type TraceStoreSpanExporter = {
  export: (
    spans: ReadableSpanLike[],
    callback: (result: SpanExportResult) => void,
  ) => void;
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
};

export type StoredSpanProjectionOptions = {
  redact?: (value: string) => string;
  serviceName?: string;
};

const MAX_ATTRIBUTE_COUNT = 128;
const MAX_ATTRIBUTE_KEY_LENGTH = 256;
const MAX_ATTRIBUTE_STRING_LENGTH = 4_096;
const MAX_EVENT_COUNT = 128;
const MAX_LINK_COUNT = 128;
const MAX_NAME_LENGTH = 512;
const SECRET_ATTRIBUTE =
  /(^|[._-])(authorization|cookie|credential|password|secret|token|api[._-]?key)($|[._-])/i;

const validTraceId = (value: string) => /^[0-9a-f]{32}$/i.test(value);
const validSpanId = (value: string) => /^[0-9a-f]{16}$/i.test(value);

const bounded = (value: string, maximum: number) =>
  value.length <= maximum ? value : value.slice(0, maximum);

const sanitizeUrl = (value: string) => {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return value.split(/[?#]/u, 1)[0] ?? "";
  }
};

const scalar = (
  value: unknown,
  key: string,
  redact: (value: string) => string,
): TelemetryAttributeScalar | undefined => {
  if (typeof value === "boolean" || typeof value === "number")
    return Number.isFinite(value) || typeof value === "boolean"
      ? value
      : undefined;
  if (typeof value !== "string") return undefined;
  const safe = /(^|[._-])url$/i.test(key) ? sanitizeUrl(value) : value;
  return bounded(redact(safe), MAX_ATTRIBUTE_STRING_LENGTH);
};

const attributesFrom = (
  input: Record<string, unknown> | undefined,
  redact: (value: string) => string,
): TelemetryAttributes => {
  const entries: Array<[string, TelemetryAttributeValue]> = [];
  for (const [rawKey, rawValue] of Object.entries(input ?? {})) {
    if (entries.length >= MAX_ATTRIBUTE_COUNT) break;
    const key = bounded(rawKey, MAX_ATTRIBUTE_KEY_LENGTH);
    if (!key || SECRET_ATTRIBUTE.test(key)) continue;
    if (Array.isArray(rawValue)) {
      const values = rawValue
        .slice(0, MAX_ATTRIBUTE_COUNT)
        .map((value) => scalar(value, key, redact))
        .filter(
          (value): value is TelemetryAttributeScalar => value !== undefined,
        );
      if (values.length > 0) entries.push([key, values]);
      continue;
    }
    const value = scalar(rawValue, key, redact);
    if (value !== undefined) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
};

const unixNano = ([seconds, nanoseconds]: HrTime) =>
  (BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds)).toString();

const durationNano = ([seconds, nanoseconds]: HrTime) =>
  (BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds)).toString();

const traceState = (context: SpanContextLike) => {
  const encoded = context.traceState?.serialize().trim();
  return encoded ? bounded(encoded, 512) : undefined;
};

export const projectStoredSpan = (
  span: ReadableSpanLike,
  options: StoredSpanProjectionOptions = {},
): StoredSpan => {
  const context = span.spanContext();
  if (!validTraceId(context.traceId) || !validSpanId(context.spanId))
    throw new Error("Telemetry span has an invalid trace or span id");
  const parent = span.parentSpanContext;
  if (parent && !validSpanId(parent.spanId))
    throw new Error("Telemetry span has an invalid parent span id");
  const redact = options.redact ?? ((value: string) => value);
  const resourceAttributes = attributesFrom(span.resource.attributes, redact);
  const configuredService = options.serviceName?.trim();
  const resourceService = resourceAttributes["service.name"];
  const serviceName = bounded(
    configuredService ||
      (typeof resourceService === "string"
        ? resourceService
        : "unknown-service"),
    MAX_NAME_LENGTH,
  );
  const statusMessage = span.status.message
    ? bounded(redact(span.status.message), MAX_ATTRIBUTE_STRING_LENGTH)
    : undefined;
  const encodedTraceState = traceState(context);

  return {
    attributes: attributesFrom(span.attributes, redact),
    durationNano: durationNano(span.duration),
    endedAtUnixNano: unixNano(span.endTime),
    events: span.events.slice(0, MAX_EVENT_COUNT).map((event) => ({
      attributes: attributesFrom(event.attributes, redact),
      name: bounded(redact(event.name), MAX_NAME_LENGTH),
      timeUnixNano: unixNano(event.time),
    })),
    kind: span.kind,
    links: span.links.slice(0, MAX_LINK_COUNT).flatMap((link) => {
      if (
        !validTraceId(link.context.traceId) ||
        !validSpanId(link.context.spanId)
      )
        return [];
      const encodedLinkTraceState = traceState(link.context);
      return [
        {
          attributes: attributesFrom(link.attributes, redact),
          spanId: link.context.spanId.toLowerCase(),
          traceId: link.context.traceId.toLowerCase(),
          ...(encodedLinkTraceState
            ? { traceState: encodedLinkTraceState }
            : {}),
        },
      ];
    }),
    name: bounded(redact(span.name), MAX_NAME_LENGTH),
    ...(parent ? { parentSpanId: parent.spanId.toLowerCase() } : {}),
    resourceAttributes,
    scopeName: bounded(
      span.instrumentationScope?.name ?? "unknown-scope",
      MAX_NAME_LENGTH,
    ),
    ...(span.instrumentationScope?.version
      ? {
          scopeVersion: bounded(
            span.instrumentationScope.version,
            MAX_NAME_LENGTH,
          ),
        }
      : {}),
    serviceName,
    spanId: context.spanId.toLowerCase(),
    startedAtUnixNano: unixNano(span.startTime),
    statusCode: span.status.code,
    ...(statusMessage ? { statusMessage } : {}),
    traceFlags: context.traceFlags,
    traceId: context.traceId.toLowerCase(),
    ...(encodedTraceState ? { traceState: encodedTraceState } : {}),
  };
};

export const createTraceStoreSpanExporter = (options: {
  onError?: (error: unknown, batchSize: number) => void;
  projection?: StoredSpanProjectionOptions;
  store: TraceStore;
}): TraceStoreSpanExporter => {
  let closed = false;
  return {
    export: (spans, callback) => {
      if (closed) {
        callback({
          code: 1,
          error: new Error("Trace store exporter is closed"),
        });
        return;
      }
      void Promise.resolve()
        .then(() =>
          options.store.write(
            spans.map((span) => projectStoredSpan(span, options.projection)),
          ),
        )
        .then(
          () => callback({ code: 0 }),
          (error: unknown) => {
            options.onError?.(error, spans.length);
            callback({
              code: 1,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          },
        );
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => {
      closed = true;
      return Promise.resolve();
    },
  };
};

export const createMemoryTraceStore = (options: { maxSpans?: number } = {}) => {
  const maximum = Math.max(1, Math.floor(options.maxSpans ?? 10_000));
  const spans = new Map<string, StoredSpan>();
  const keyOf = (span: StoredSpan) => `${span.traceId}:${span.spanId}`;
  const ordered = () =>
    [...spans.values()].sort((left, right) =>
      BigInt(left.startedAtUnixNano) < BigInt(right.startedAtUnixNano) ? -1 : 1,
    );
  const store: TraceStore = {
    getTrace: async (traceId) =>
      ordered().filter((span) => span.traceId === traceId.toLowerCase()),
    listTraces: async (filter = {}) => {
      const grouped = new Map<string, StoredSpan[]>();
      for (const span of ordered()) {
        if (filter.serviceName && span.serviceName !== filter.serviceName)
          continue;
        if (
          filter.statusCode !== undefined &&
          span.statusCode !== filter.statusCode
        )
          continue;
        if (
          filter.sinceUnixNano &&
          BigInt(span.startedAtUnixNano) < BigInt(filter.sinceUnixNano)
        )
          continue;
        if (
          filter.untilUnixNano &&
          BigInt(span.startedAtUnixNano) > BigInt(filter.untilUnixNano)
        )
          continue;
        const trace = grouped.get(span.traceId) ?? [];
        trace.push(span);
        grouped.set(span.traceId, trace);
      }
      return [...grouped.entries()]
        .map(([traceId, trace]) => {
          const startedAt = trace.reduce(
            (value, span) =>
              BigInt(span.startedAtUnixNano) < BigInt(value)
                ? span.startedAtUnixNano
                : value,
            trace[0]!.startedAtUnixNano,
          );
          const endedAt = trace.reduce(
            (value, span) =>
              BigInt(span.endedAtUnixNano) > BigInt(value)
                ? span.endedAtUnixNano
                : value,
            trace[0]!.endedAtUnixNano,
          );
          return {
            durationNano: (BigInt(endedAt) - BigInt(startedAt)).toString(),
            endedAtUnixNano: endedAt,
            errorSpanCount: trace.filter((span) => span.statusCode === 2)
              .length,
            rootName:
              trace.find((span) => span.parentSpanId === undefined)?.name ??
              trace[0]!.name,
            serviceNames: [...new Set(trace.map((span) => span.serviceName))],
            spanCount: trace.length,
            startedAtUnixNano: startedAt,
            traceId,
          };
        })
        .sort((left, right) =>
          BigInt(left.startedAtUnixNano) > BigInt(right.startedAtUnixNano)
            ? -1
            : 1,
        )
        .slice(0, Math.max(1, Math.min(filter.limit ?? 100, 1_000)));
    },
    prune: async (beforeUnixNano) => {
      let deleted = 0;
      for (const [key, span] of spans) {
        if (BigInt(span.startedAtUnixNano) >= BigInt(beforeUnixNano)) continue;
        spans.delete(key);
        deleted++;
      }
      return deleted;
    },
    write: async (batch) => {
      for (const span of batch) spans.set(keyOf(span), span);
      while (spans.size > maximum) {
        const oldest = ordered()[0];
        if (!oldest) break;
        spans.delete(keyOf(oldest));
      }
    },
  };
  return store;
};
