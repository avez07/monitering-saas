-- Premium plan switches (advanced dashboard, Prometheus remote_write). See docs/api/advanced-telemetry.md.
ALTER TABLE "SubscriptionPlan" ADD COLUMN "features" JSONB NOT NULL DEFAULT '{}';
UPDATE "SubscriptionPlan" SET "features" = '{"advancedDashboard": true, "promMetrics": true}' WHERE "id" IN ('pro', 'business');
