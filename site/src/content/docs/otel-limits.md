---
title: OpenTelemetry limits
description: "Monthly telemetry volume in GB and how long traces and logs are kept, per plan."
group: OpenTelemetry
order: 25
---

## Monthly volume and retention

| Plan | Free | Starter | Pro | Business |
|---|---|---|---|---|
| Telemetry per month | 1 GB | 10 GB | 50 GB | 250 GB |
| Traces and logs kept for | 3 days | 7 days | 15 days | 30 days |

- The month is a calendar month in UTC.
- Volume is counted as the uncompressed size of what you send, for traces, logs and metrics together.
- Metrics are accepted and counted but not stored yet.
- Data that is sampled out on our side still counts, because it was received.
- You can see usage under **Settings**, then **Telemetry**.

## When you reach the limit

The organization owner gets an email at 80% and at 100% (once each per month). At 100%, new data is refused with `429` until the month rolls over or you change plan. Exporters treat 429 as retryable.

## Retention

Each record is kept for the retention of your plan at the moment it was stored. Changing plan later does not rewrite old data. Dashboard queries are limited to your current plan's retention.

## Request limits

- Largest request: 4 MiB after decompression (`413` above that).
- Request rate: 1200 requests per minute per key (`429` above that).
- Up to 20 active telemetry keys per organization.
