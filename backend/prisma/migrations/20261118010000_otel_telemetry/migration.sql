-- Phase 18: telemetry ingest keys (ApiKey.kind) and per-organization OpenTelemetry settings.
ALTER TABLE "ApiKey" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'install';
CREATE INDEX "ApiKey_orgId_kind_revokedAt_idx" ON "ApiKey"("orgId", "kind", "revokedAt");

CREATE TABLE "TelemetrySettings" (
    "orgId" TEXT NOT NULL,
    "redaction" JSONB NOT NULL DEFAULT '[]',
    "sampling" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelemetrySettings_pkey" PRIMARY KEY ("orgId")
);
ALTER TABLE "TelemetrySettings" ADD CONSTRAINT "TelemetrySettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One active install key per organization (as before); telemetry keys are not limited by it (the app caps them at 20).
DROP INDEX "ApiKey_one_active_per_org";
CREATE UNIQUE INDEX "ApiKey_one_active_install_per_org" ON "ApiKey"("orgId") WHERE "revokedAt" IS NULL AND "kind" = 'install';
