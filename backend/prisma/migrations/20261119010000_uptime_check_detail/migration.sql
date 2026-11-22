-- The response a failed website check received (redacted, truncated), shown in the check log.
ALTER TABLE "UptimeCheck" ADD COLUMN "detail" TEXT;
