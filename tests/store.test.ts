import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import { createDrizzleTraceStore } from "../src/drizzle";
import {
  createMemoryTraceStore,
  createTraceStoreSpanExporter,
  projectStoredSpan,
  type ReadableSpanLike,
  type StoredSpan,
} from "../src/store";

const traceId = "0123456789abcdef0123456789abcdef";
const childTraceId = "fedcba9876543210fedcba9876543210";

const readableSpan = (overrides: Partial<ReadableSpanLike> = {}) =>
  ({
    attributes: {
      "http.request.header.authorization": "Bearer private",
      "http.url": "https://absolutejs.ai/path?token=private#fragment",
      tenant: "tenant-1",
    },
    duration: [0, 25_000_000],
    endTime: [1_800_000_000, 125_000_000],
    events: [
      {
        attributes: { password: "private", result: "failed" },
        name: "exception",
        time: [1_800_000_000, 110_000_000],
      },
    ],
    instrumentationScope: { name: "@absolutejs/runtime", version: "1.0.0" },
    kind: 1,
    links: [
      {
        attributes: { relation: "retry" },
        context: {
          spanId: "1122334455667788",
          traceFlags: 1,
          traceId: childTraceId,
        },
      },
    ],
    name: "request",
    resource: {
      attributes: {
        "service.name": "absolutejs-saas",
        "service.version": "release-1",
      },
    },
    spanContext: () => ({
      spanId: "0011223344556677",
      traceFlags: 1,
      traceId,
    }),
    startTime: [1_800_000_000, 100_000_000],
    status: { code: 2, message: "provider token=private" },
    ...overrides,
  }) satisfies ReadableSpanLike;

const storedSpan = (overrides: Partial<StoredSpan> = {}): StoredSpan => ({
  attributes: { tenant: "tenant-1" },
  durationNano: "25000000",
  endedAtUnixNano: "1800000000125000000",
  events: [],
  kind: 1,
  links: [],
  name: "request",
  resourceAttributes: { "service.name": "absolutejs-saas" },
  scopeName: "@absolutejs/runtime",
  serviceName: "absolutejs-saas",
  spanId: "0011223344556677",
  startedAtUnixNano: "1800000000100000000",
  statusCode: 0,
  traceFlags: 1,
  traceId,
  ...overrides,
});

describe("trace storage", () => {
  test("projects bounded spans without secret attributes or URL values", () => {
    const span = projectStoredSpan(readableSpan(), {
      redact: (value) => value.replaceAll("private", "[REDACTED]"),
    });

    expect(span.attributes).toEqual({
      "http.url": "https://absolutejs.ai/path",
      tenant: "tenant-1",
    });
    expect(span.events[0]?.attributes).toEqual({ result: "failed" });
    expect(span.statusMessage).toBe("provider token=[REDACTED]");
    expect(span.serviceName).toBe("absolutejs-saas");
    expect(span.startedAtUnixNano).toBe("1800000000100000000");
  });

  test("exports SDK-shaped spans through the pluggable store contract", async () => {
    const store = createMemoryTraceStore();
    const exporter = createTraceStoreSpanExporter({ store });
    const result = await new Promise<{ code: number }>((resolve) =>
      exporter.export([readableSpan()], resolve),
    );

    expect(result.code).toBe(0);
    expect(await store.getTrace(traceId)).toHaveLength(1);
    await exporter.shutdown();
    const closed = await new Promise<{ code: number }>((resolve) =>
      exporter.export([readableSpan()], resolve),
    );
    expect(closed.code).toBe(1);
  });

  test("bounds memory storage and prunes by nanosecond timestamp", async () => {
    const store = createMemoryTraceStore({ maxSpans: 2 });
    await store.write([
      storedSpan({ spanId: "0000000000000001" }),
      storedSpan({
        spanId: "0000000000000002",
        startedAtUnixNano: "1800000000200000000",
      }),
      storedSpan({
        spanId: "0000000000000003",
        startedAtUnixNano: "1800000000300000000",
      }),
    ]);
    expect(await store.getTrace(traceId)).toHaveLength(2);
    expect(await store.prune("1800000000300000000")).toBe(1);
    expect(await store.getTrace(traceId)).toHaveLength(1);
  });
});

describe("createDrizzleTraceStore", () => {
  test("persists idempotent spans, summarizes traces, and prunes", async () => {
    const client = new PGlite();
    await client.exec(`
			CREATE TABLE telemetry_spans (
				attributes jsonb NOT NULL,
				duration_nano bigint NOT NULL,
				ended_at timestamptz NOT NULL,
				ended_at_unix_nano bigint NOT NULL,
				events jsonb NOT NULL,
				ingested_at timestamptz NOT NULL DEFAULT now(),
				kind integer NOT NULL,
				links jsonb NOT NULL,
				name text NOT NULL,
				parent_span_id text,
				resource_attributes jsonb NOT NULL,
				scope_name text NOT NULL,
				scope_version text,
				service_name text NOT NULL,
				span_id text NOT NULL,
				started_at timestamptz NOT NULL,
				started_at_unix_nano bigint NOT NULL,
				status_code integer NOT NULL,
				status_message text,
				trace_flags integer NOT NULL,
				trace_id text NOT NULL,
				trace_state text,
				PRIMARY KEY (trace_id, span_id)
			)
		`);
    const store = createDrizzleTraceStore({ db: drizzle({ client }) });
    const root = storedSpan();
    const child = storedSpan({
      endedAtUnixNano: "1800000000130000000",
      name: "database",
      parentSpanId: root.spanId,
      spanId: "1122334455667788",
      startedAtUnixNano: "1800000000110000000",
      statusCode: 2,
    });
    await store.write([root, child, root]);

    expect(await store.getTrace(traceId)).toHaveLength(2);
    const summaries = await store.listTraces();
    expect(summaries).toEqual([
      {
        durationNano: "30000000",
        endedAtUnixNano: "1800000000130000000",
        errorSpanCount: 1,
        rootName: "request",
        serviceNames: ["absolutejs-saas"],
        spanCount: 2,
        startedAtUnixNano: "1800000000100000000",
        traceId,
      },
    ]);
    expect(await store.prune("1800000000200000000")).toBe(2);
    expect(await store.getTrace(traceId)).toEqual([]);
    await client.close();
  });
});
