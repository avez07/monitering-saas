-- OpenTelemetry storage. Table layout follows the official OTel Collector ClickHouse exporter, plus
-- OrgId (tenant), ExpireAt (per-row TTL set from the plan at insert time) and IngestSeq (live-tail cursor).
-- Statements are separated by a line holding only "-- split". {db} is replaced with the database name.
CREATE TABLE IF NOT EXISTS {db}.otel_traces
(
    OrgId LowCardinality(String) CODEC(ZSTD(1)),
    Timestamp DateTime64(9) CODEC(Delta, ZSTD(1)),
    TraceId String CODEC(ZSTD(1)),
    SpanId String CODEC(ZSTD(1)),
    ParentSpanId String CODEC(ZSTD(1)),
    TraceState String CODEC(ZSTD(1)),
    SpanName LowCardinality(String) CODEC(ZSTD(1)),
    SpanKind LowCardinality(String) CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),
    SpanAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    Duration UInt64 CODEC(ZSTD(1)),
    StatusCode LowCardinality(String) CODEC(ZSTD(1)),
    StatusMessage String CODEC(ZSTD(1)),
    `Events.Timestamp` Array(DateTime64(9)) CODEC(ZSTD(1)),
    `Events.Name` Array(LowCardinality(String)) CODEC(ZSTD(1)),
    `Events.Attributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Links.TraceId` Array(String) CODEC(ZSTD(1)),
    `Links.SpanId` Array(String) CODEC(ZSTD(1)),
    `Links.TraceState` Array(String) CODEC(ZSTD(1)),
    `Links.Attributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    ExpireAt DateTime CODEC(Delta, ZSTD(1)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_key mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_duration Duration TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, ServiceName, SpanName, toDateTime(Timestamp))
TTL ExpireAt DELETE
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
-- split
CREATE TABLE IF NOT EXISTS {db}.otel_logs
(
    OrgId LowCardinality(String) CODEC(ZSTD(1)),
    Timestamp DateTime64(9) CODEC(Delta, ZSTD(1)),
    TraceId String CODEC(ZSTD(1)),
    SpanId String CODEC(ZSTD(1)),
    TraceFlags UInt8,
    SeverityText LowCardinality(String) CODEC(ZSTD(1)),
    SeverityNumber UInt8,
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    Body String CODEC(ZSTD(1)),
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    LogAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ExpireAt DateTime CODEC(Delta, ZSTD(1)),
    IngestSeq UInt64 CODEC(ZSTD(1)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_body Body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8,
    INDEX idx_seq IngestSeq TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, ServiceName, SeverityNumber, toUnixTimestamp(Timestamp))
TTL ExpireAt DELETE
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
-- split
-- Per-service RED rollup per minute, fed from entry spans (server/consumer kinds or no parent).
-- Kept for the longest plan (30 days); reads clamp to the plan retention.
CREATE TABLE IF NOT EXISTS {db}.otel_red_1m
(
    OrgId LowCardinality(String),
    ServiceName LowCardinality(String),
    Minute DateTime,
    Requests SimpleAggregateFunction(sum, UInt64),
    Errors SimpleAggregateFunction(sum, UInt64),
    DurationSum SimpleAggregateFunction(sum, UInt64),
    DurationState AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Minute)
ORDER BY (OrgId, ServiceName, Minute)
TTL Minute + INTERVAL 30 DAY DELETE
-- split
CREATE MATERIALIZED VIEW IF NOT EXISTS {db}.otel_red_1m_mv TO {db}.otel_red_1m AS
SELECT
    OrgId,
    ServiceName,
    toStartOfMinute(toDateTime(Timestamp)) AS Minute,
    count() AS Requests,
    countIf(StatusCode = 'Error') AS Errors,
    sum(Duration) AS DurationSum,
    quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS DurationState
FROM {db}.otel_traces
WHERE ParentSpanId = '' OR SpanKind IN ('Server', 'Consumer')
GROUP BY OrgId, ServiceName, Minute
