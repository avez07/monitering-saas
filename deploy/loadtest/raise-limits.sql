-- LOCAL TEST DATABASES ONLY. Never run this against production.
-- Lifts the free plan's hard cap of 2 servers so one account can register a 500-agent fleet.
-- (The API re-seeds plans on start, so run this after the API is up.)
UPDATE "SubscriptionPlan" SET "includedServers" = 100000 WHERE id = 'free';
