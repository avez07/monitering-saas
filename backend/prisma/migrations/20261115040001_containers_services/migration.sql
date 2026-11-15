-- Phase 11 (containers) and Phase 12 (services): current state, history events and container metrics.

CREATE TABLE "ContainerItem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "dockerId" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "image" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL,
    "rawState" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT '',
    "restartCount" INTEGER NOT NULL DEFAULT 0,
    "cpuPercent" DOUBLE PRECISION,
    "memoryBytes" DOUBLE PRECISION,
    "memoryLimitBytes" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3),
    "wasRunning" BOOLEAN NOT NULL DEFAULT false,
    "stoppedStreak" INTEGER NOT NULL DEFAULT 0,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContainerItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ServiceItem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "responseMs" DOUBLE PRECISION,
    "port" INTEGER,
    "stoppedStreak" INTEGER NOT NULL DEFAULT 0,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StateEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StateEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "container_metrics" (
    "time" TIMESTAMPTZ(6) NOT NULL,
    "container_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "cpu_percent" DOUBLE PRECISION,
    "memory_bytes" DOUBLE PRECISION,
    "memory_limit_bytes" DOUBLE PRECISION,
    "restart_count" INTEGER,

    CONSTRAINT "container_metrics_pkey" PRIMARY KEY ("container_id","time")
);

CREATE UNIQUE INDEX "ContainerItem_agentId_name_key" ON "ContainerItem"("agentId", "name");
CREATE INDEX "ContainerItem_orgId_state_idx" ON "ContainerItem"("orgId", "state");
CREATE UNIQUE INDEX "ServiceItem_agentId_kind_name_key" ON "ServiceItem"("agentId", "kind", "name");
CREATE INDEX "ServiceItem_orgId_state_idx" ON "ServiceItem"("orgId", "state");
CREATE INDEX "StateEvent_subjectType_subjectId_createdAt_idx" ON "StateEvent"("subjectType", "subjectId", "createdAt");
CREATE INDEX "StateEvent_agentId_createdAt_idx" ON "StateEvent"("agentId", "createdAt");

-- Container samples: hypertable with the same retention as server_metrics (8 days raw; plans with
-- shorter history are trimmed by worker housekeeping). Chart ranges beyond 1 hour are bucketed on read.
SELECT create_hypertable('container_metrics', 'time', chunk_time_interval => INTERVAL '1 day');
ALTER TABLE container_metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'container_id',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('container_metrics', INTERVAL '2 days');
SELECT add_retention_policy('container_metrics', INTERVAL '8 days');
