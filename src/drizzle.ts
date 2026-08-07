import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import {
  bigint,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  type PgAsyncDatabase,
} from "drizzle-orm/pg-core";
import type {
  StoredSpan,
  StoredSpanEvent,
  StoredSpanLink,
  TelemetryAttributes,
  TraceFilter,
  TraceStore,
  TraceSummary,
} from "./store";

const attributesJsonb = customType<{
  data: TelemetryAttributes;
  driverData: unknown;
}>({
  dataType: () => "jsonb",
  fromDriver: (value) =>
    (typeof value === "string"
      ? JSON.parse(value)
      : value) as TelemetryAttributes,
  toDriver: (value) => JSON.stringify(value),
});
const eventsJsonb = customType<{
  data: StoredSpanEvent[];
  driverData: unknown;
}>({
  dataType: () => "jsonb",
  fromDriver: (value) =>
    (typeof value === "string"
      ? JSON.parse(value)
      : value) as StoredSpanEvent[],
  toDriver: (value) => JSON.stringify(value),
});
const linksJsonb = customType<{
  data: StoredSpanLink[];
  driverData: unknown;
}>({
  dataType: () => "jsonb",
  fromDriver: (value) =>
    (typeof value === "string" ? JSON.parse(value) : value) as StoredSpanLink[],
  toDriver: (value) => JSON.stringify(value),
});

export const telemetrySpans = pgTable(
  "telemetry_spans",
  {
    attributes: attributesJsonb().notNull(),
    durationNano: bigint("duration_nano", { mode: "bigint" }).notNull(),
    endedAt: timestamp("ended_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    endedAtUnixNano: bigint("ended_at_unix_nano", {
      mode: "bigint",
    }).notNull(),
    events: eventsJsonb().notNull(),
    ingestedAt: timestamp("ingested_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    kind: integer().notNull(),
    links: linksJsonb().notNull(),
    name: text().notNull(),
    parentSpanId: text("parent_span_id"),
    resourceAttributes: attributesJsonb("resource_attributes").notNull(),
    scopeName: text("scope_name").notNull(),
    scopeVersion: text("scope_version"),
    serviceName: text("service_name").notNull(),
    spanId: text("span_id").notNull(),
    startedAt: timestamp("started_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    startedAtUnixNano: bigint("started_at_unix_nano", {
      mode: "bigint",
    }).notNull(),
    statusCode: integer("status_code").notNull(),
    statusMessage: text("status_message"),
    traceFlags: integer("trace_flags").notNull(),
    traceId: text("trace_id").notNull(),
    traceState: text("trace_state"),
  },
  (table) => [
    primaryKey({ columns: [table.traceId, table.spanId] }),
    index("telemetry_spans_started_idx").on(table.startedAt.desc()),
    index("telemetry_spans_service_started_idx").on(
      table.serviceName,
      table.startedAt.desc(),
    ),
    index("telemetry_spans_status_started_idx").on(
      table.statusCode,
      table.startedAt.desc(),
    ),
    index("telemetry_spans_ingested_idx").on(table.ingestedAt),
  ],
);

export const telemetryDrizzleSchema = { telemetrySpans };

type AnyPgDatabase = PgAsyncDatabase<any, any>;

export type CreateDrizzleTraceStoreOptions<DB extends AnyPgDatabase> = {
  db: DB;
};

const dateFromUnixNano = (value: string) =>
  new Date(Number(BigInt(value) / 1_000_000n));

const insertValue = (span: StoredSpan) => ({
  attributes: span.attributes,
  durationNano: BigInt(span.durationNano),
  endedAt: dateFromUnixNano(span.endedAtUnixNano),
  endedAtUnixNano: BigInt(span.endedAtUnixNano),
  events: span.events,
  kind: span.kind,
  links: span.links,
  name: span.name,
  parentSpanId: span.parentSpanId,
  resourceAttributes: span.resourceAttributes,
  scopeName: span.scopeName,
  scopeVersion: span.scopeVersion,
  serviceName: span.serviceName,
  spanId: span.spanId,
  startedAt: dateFromUnixNano(span.startedAtUnixNano),
  startedAtUnixNano: BigInt(span.startedAtUnixNano),
  statusCode: span.statusCode,
  statusMessage: span.statusMessage,
  traceFlags: span.traceFlags,
  traceId: span.traceId,
  traceState: span.traceState,
});

const storedSpanFrom = (
  row: typeof telemetrySpans.$inferSelect,
): StoredSpan => ({
  attributes: row.attributes,
  durationNano: row.durationNano.toString(),
  endedAtUnixNano: row.endedAtUnixNano.toString(),
  events: row.events,
  kind: row.kind,
  links: row.links,
  name: row.name,
  ...(row.parentSpanId === null ? {} : { parentSpanId: row.parentSpanId }),
  resourceAttributes: row.resourceAttributes,
  scopeName: row.scopeName,
  ...(row.scopeVersion === null ? {} : { scopeVersion: row.scopeVersion }),
  serviceName: row.serviceName,
  spanId: row.spanId,
  startedAtUnixNano: row.startedAtUnixNano.toString(),
  statusCode: row.statusCode,
  ...(row.statusMessage === null ? {} : { statusMessage: row.statusMessage }),
  traceFlags: row.traceFlags,
  traceId: row.traceId,
  ...(row.traceState === null ? {} : { traceState: row.traceState }),
});

const conditionsFor = (filter: TraceFilter): Array<SQL | undefined> => [
  filter.serviceName
    ? eq(telemetrySpans.serviceName, filter.serviceName)
    : undefined,
  filter.statusCode === undefined
    ? undefined
    : eq(telemetrySpans.statusCode, filter.statusCode),
  filter.sinceUnixNano
    ? gte(telemetrySpans.startedAtUnixNano, BigInt(filter.sinceUnixNano))
    : undefined,
  filter.untilUnixNano
    ? lte(telemetrySpans.startedAtUnixNano, BigInt(filter.untilUnixNano))
    : undefined,
];

export const createDrizzleTraceStore = <DB extends AnyPgDatabase>({
  db,
}: CreateDrizzleTraceStoreOptions<DB>): TraceStore => ({
  getTrace: async (traceId) => {
    const rows = await db
      .select()
      .from(telemetrySpans)
      .where(eq(telemetrySpans.traceId, traceId.toLowerCase()))
      .orderBy(
        asc(telemetrySpans.startedAtUnixNano),
        asc(telemetrySpans.spanId),
      );
    return rows.map(storedSpanFrom);
  },
  listTraces: async (filter = {}) => {
    const rows = await db
      .select({
        durationNano: sql<bigint>`max(${telemetrySpans.endedAtUnixNano}) - min(${telemetrySpans.startedAtUnixNano})`,
        endedAtUnixNano: sql<bigint>`max(${telemetrySpans.endedAtUnixNano})`,
        errorSpanCount: sql<number>`count(*) filter (where ${telemetrySpans.statusCode} = 2)::integer`,
        rootName: sql<string>`coalesce(max(${telemetrySpans.name}) filter (where ${telemetrySpans.parentSpanId} is null), min(${telemetrySpans.name}))`,
        serviceNames: sql<
          string[]
        >`array_agg(distinct ${telemetrySpans.serviceName} order by ${telemetrySpans.serviceName})`,
        spanCount: sql<number>`count(*)::integer`,
        startedAtUnixNano: sql<bigint>`min(${telemetrySpans.startedAtUnixNano})`,
        traceId: telemetrySpans.traceId,
      })
      .from(telemetrySpans)
      .where(and(...conditionsFor(filter)))
      .groupBy(telemetrySpans.traceId)
      .orderBy(desc(sql`min(${telemetrySpans.startedAtUnixNano})`))
      .limit(Math.max(1, Math.min(filter.limit ?? 100, 1_000)));
    return rows.map(
      (row): TraceSummary => ({
        durationNano: row.durationNano.toString(),
        endedAtUnixNano: row.endedAtUnixNano.toString(),
        errorSpanCount: row.errorSpanCount,
        rootName: row.rootName,
        serviceNames: row.serviceNames,
        spanCount: row.spanCount,
        startedAtUnixNano: row.startedAtUnixNano.toString(),
        traceId: row.traceId,
      }),
    );
  },
  prune: async (beforeUnixNano) => {
    const deleted = await db
      .delete(telemetrySpans)
      .where(lte(telemetrySpans.startedAtUnixNano, BigInt(beforeUnixNano) - 1n))
      .returning({ spanId: telemetrySpans.spanId });
    return deleted.length;
  },
  write: async (spans) => {
    if (spans.length === 0) return;
    await db
      .insert(telemetrySpans)
      .values(spans.map(insertValue))
      .onConflictDoNothing({
        target: [telemetrySpans.traceId, telemetrySpans.spanId],
      });
  },
});
