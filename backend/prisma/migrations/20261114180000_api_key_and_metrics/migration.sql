-- Phase 1: account API key, setup profiles, agent events and time-series metric storage.
-- Requires the TimescaleDB extension (the compose image provides it; managed Postgres must offer it).

-- DropForeignKey
ALTER TABLE "AgentEnrollmentToken" DROP CONSTRAINT "AgentEnrollmentToken_orgId_projectId_fkey";

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "arch" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "configId" TEXT,
ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "os" TEXT NOT NULL DEFAULT '';

-- DropTable
DROP TABLE "AgentEnrollmentToken";

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Account key',
    "prefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentConfig" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "settings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT,
    "fingerprint" TEXT,
    "source" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_metrics" (
    "time" TIMESTAMPTZ(6) NOT NULL,
    "agent_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "cpu_percent" DOUBLE PRECISION,
    "mem_percent" DOUBLE PRECISION,
    "swap_percent" DOUBLE PRECISION,
    "disk_percent" DOUBLE PRECISION,
    "load1" DOUBLE PRECISION,
    "load5" DOUBLE PRECISION,
    "load15" DOUBLE PRECISION,
    "net_rx_bps" DOUBLE PRECISION,
    "net_tx_bps" DOUBLE PRECISION,
    "disk_read_bps" DOUBLE PRECISION,
    "disk_write_bps" DOUBLE PRECISION,
    "uptime_seconds" DOUBLE PRECISION,
    "details" JSONB,

    CONSTRAINT "server_metrics_pkey" PRIMARY KEY ("agent_id","time")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_tokenHash_key" ON "ApiKey"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiKey_orgId_revokedAt_idx" ON "ApiKey"("orgId", "revokedAt");

-- CreateIndex
CREATE INDEX "AgentConfig_orgId_idx" ON "AgentConfig"("orgId");

-- CreateIndex
CREATE INDEX "AgentEvent_agentId_createdAt_idx" ON "AgentEvent"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentEvent_orgId_fingerprint_createdAt_idx" ON "AgentEvent"("orgId", "fingerprint", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_orgId_fingerprint_key" ON "Agent"("orgId", "fingerprint");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConfig" ADD CONSTRAINT "AgentConfig_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One active API key and one default setup profile per organization (cannot be expressed in Prisma).
CREATE UNIQUE INDEX "ApiKey_one_active_per_org" ON "ApiKey"("orgId") WHERE "revokedAt" IS NULL;
CREATE UNIQUE INDEX "AgentConfig_one_default_per_org" ON "AgentConfig"("orgId") WHERE "isDefault";

-- Every existing organization gets a default setup profile.
INSERT INTO "AgentConfig" ("id", "orgId", "name", "isDefault", "version", "settings", "updatedAt")
SELECT 'st_' || substr(md5(random()::text || o."id"), 1, 24), o."id", 'Default', true, 1,
  '{"sendIntervalSeconds":30,"sampleIntervalSeconds":10,"collectors":{"cpu":true,"memory":true,"swap":true,"disk":true,"diskIo":true,"network":true,"load":true,"processes":true}}'::jsonb,
  CURRENT_TIMESTAMP
FROM "Organization" o;

-- ---------------------------------------------------------------------------
-- Time-series storage: raw samples in a hypertable, 5-minute and 1-hour rollups.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable('server_metrics', 'time', chunk_time_interval => INTERVAL '1 day');

ALTER TABLE server_metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'agent_id',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('server_metrics', INTERVAL '2 days');
-- Raw samples serve the 1-hour and 24-hour charts and the last week; older ranges use the rollups.
-- Each plan's own history limit (7 days to 1 year) is applied when reading and by worker housekeeping.
SELECT add_retention_policy('server_metrics', INTERVAL '8 days');

CREATE MATERIALIZED VIEW server_metrics_5m WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '5 minutes', "time") AS bucket, agent_id, org_id,
  avg(cpu_percent) AS cpu_avg, max(cpu_percent) AS cpu_max,
  avg(mem_percent) AS mem_avg, max(mem_percent) AS mem_max,
  avg(swap_percent) AS swap_avg,
  avg(disk_percent) AS disk_avg, max(disk_percent) AS disk_max,
  avg(load1) AS load1_avg, max(load1) AS load1_max,
  avg(net_rx_bps) AS net_rx_avg, max(net_rx_bps) AS net_rx_max,
  avg(net_tx_bps) AS net_tx_avg, max(net_tx_bps) AS net_tx_max,
  avg(disk_read_bps) AS disk_read_avg, avg(disk_write_bps) AS disk_write_avg,
  count(*) AS samples
FROM server_metrics
GROUP BY bucket, agent_id, org_id
WITH NO DATA;

CREATE MATERIALIZED VIEW server_metrics_1h WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 hour', "time") AS bucket, agent_id, org_id,
  avg(cpu_percent) AS cpu_avg, max(cpu_percent) AS cpu_max,
  avg(mem_percent) AS mem_avg, max(mem_percent) AS mem_max,
  avg(swap_percent) AS swap_avg,
  avg(disk_percent) AS disk_avg, max(disk_percent) AS disk_max,
  avg(load1) AS load1_avg, max(load1) AS load1_max,
  avg(net_rx_bps) AS net_rx_avg, max(net_rx_bps) AS net_rx_max,
  avg(net_tx_bps) AS net_tx_avg, max(net_tx_bps) AS net_tx_max,
  avg(disk_read_bps) AS disk_read_avg, avg(disk_write_bps) AS disk_write_avg,
  count(*) AS samples
FROM server_metrics
GROUP BY bucket, agent_id, org_id
WITH NO DATA;

-- Include the newest, not-yet-materialized samples so charts are never a few minutes behind.
ALTER MATERIALIZED VIEW server_metrics_5m SET (timescaledb.materialized_only = false);
ALTER MATERIALIZED VIEW server_metrics_1h SET (timescaledb.materialized_only = false);

SELECT add_continuous_aggregate_policy('server_metrics_5m',
  start_offset => INTERVAL '1 day', end_offset => INTERVAL '5 minutes', schedule_interval => INTERVAL '5 minutes');
SELECT add_continuous_aggregate_policy('server_metrics_1h',
  start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '30 minutes');

SELECT add_retention_policy('server_metrics_5m', INTERVAL '95 days');
SELECT add_retention_policy('server_metrics_1h', INTERVAL '400 days');
