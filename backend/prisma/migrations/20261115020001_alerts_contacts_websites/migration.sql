-- Phase 8 (plain-language alerts, contacts) and Phase 10 (websites and APIs).
-- AlterTable
ALTER TABLE "AlertRule" ADD COLUMN "scopeType" TEXT NOT NULL DEFAULT 'all',
ADD COLUMN "scopeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "contactIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "templateKey" TEXT,
ADD COLUMN "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AlertIncident" ADD COLUMN "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN "clearSince" TIMESTAMP(3),
ADD COLUMN "notified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "NotificationChannel" ADD COLUMN "secret" TEXT,
ADD COLUMN "meta" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "linkCodeHash" TEXT,
ADD COLUMN "linkExpiresAt" TIMESTAMP(3),
ADD COLUMN "lastTestAt" TIMESTAMP(3),
ADD COLUMN "lastTestOk" BOOLEAN,
ADD COLUMN "lastTestError" TEXT;

-- AlterTable
ALTER TABLE "NotificationDelivery" ADD COLUMN "payload" JSONB;

-- AlterTable
ALTER TABLE "UptimeMonitor" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'http',
ADD COLUMN "method" TEXT NOT NULL DEFAULT 'GET',
ADD COLUMN "headers" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "body" TEXT,
ADD COLUMN "expectedStatus" INTEGER,
ADD COLUMN "keyword" TEXT,
ADD COLUMN "keywordMode" TEXT NOT NULL DEFAULT 'present',
ADD COLUMN "jsonContains" TEXT,
ADD COLUMN "timeoutSeconds" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN "lastError" TEXT,
ADD COLUMN "downSince" TIMESTAMP(3),
ADD COLUMN "domain" TEXT,
ADD COLUMN "domainExpiresAt" TIMESTAMP(3),
ADD COLUMN "domainCheckedAt" TIMESTAMP(3),
ADD COLUMN "domainStatus" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "NotificationChannel_linkCodeHash_key" ON "NotificationChannel"("linkCodeHash");

-- CreateIndex
CREATE INDEX "AlertIncident_ruleId_resourceId_state_idx" ON "AlertIncident"("ruleId", "resourceId", "state");

-- Rules created with the old metric names (restarts, errorRate, p95, availability, certificateDays) are retired.
UPDATE "AlertRule" SET "deletedAt" = now(), "enabled" = false
WHERE "metric" NOT IN ('cpu', 'memory', 'disk');
