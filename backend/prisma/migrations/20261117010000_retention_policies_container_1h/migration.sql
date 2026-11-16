-- Phase 17d: retention by dropping chunks (no hourly DELETE), compression policies guaranteed, and a
-- 1-hour continuous aggregate for container metrics. Every statement is idempotent.
--
-- Raw samples: 8 days. Raw rows only serve ranges up to 7 days; the 7-day plan is clamped at read time
-- (and the 8th day is the safety margin for clock skew and late backfill). Plans with longer history
-- (30/90/365 days) read the 5-minute (95 days) and 1-hour (400 days >= longest plan, 365) aggregates.

-- Retention + compression on both raw hypertables.
SELECT remove_retention_policy('server_metrics', if_exists => true);
SELECT add_retention_policy('server_metrics', INTERVAL '8 days', if_not_exists => true);
SELECT add_compression_policy('server_metrics', INTERVAL '2 days', if_not_exists => true);

SELECT remove_retention_policy('container_metrics', if_exists => true);
SELECT add_retention_policy('container_metrics', INTERVAL '8 days', if_not_exists => true);
SELECT add_compression_policy('container_metrics', INTERVAL '2 days', if_not_exists => true);

-- Server aggregates: make sure the retention policies are there (idempotent re-assertion).
SELECT add_retention_policy('server_metrics_5m', INTERVAL '95 days', if_not_exists => true);
SELECT add_retention_policy('server_metrics_1h', INTERVAL '400 days', if_not_exists => true);

-- Container 1-hour rollup, mirroring server_metrics_1h.
CREATE MATERIALIZED VIEW IF NOT EXISTS container_metrics_1h WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 hour', "time") AS bucket, container_id, agent_id, org_id,
  avg(cpu_percent) AS cpu_avg, max(cpu_percent) AS cpu_max,
  avg(memory_bytes) AS mem_avg, max(memory_bytes) AS mem_max,
  max(memory_limit_bytes) AS mem_limit,
  max(restart_count) AS restarts,
  count(*) AS samples
FROM container_metrics
GROUP BY bucket, container_id, agent_id, org_id
WITH NO DATA;

ALTER MATERIALIZED VIEW container_metrics_1h SET (timescaledb.materialized_only = false);

SELECT add_continuous_aggregate_policy('container_metrics_1h',
  start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '30 minutes',
  if_not_exists => true);
SELECT add_retention_policy('container_metrics_1h', INTERVAL '400 days', if_not_exists => true);
