---
title: OpenTelemetry troubleshooting
description: "Fix OpenTelemetry problems: 401 wrong key, 429 over quota, 413 too large, firewall or TLS errors, and no data showing."
group: OpenTelemetry
order: 24
---

Open **Apps** in the dashboard first. It lists each telemetry key and when it last sent data, which narrows the problem.

## 401: wrong or missing key

- The key must be a telemetry key starting with `yk_otel_`. An install key (`yk_live_...`) is rejected here.
- The header name is `x-yuktiops-key`. Check there is no extra space or quote in `OTEL_EXPORTER_OTLP_HEADERS`.
- A revoked key stops working within seconds. Create a new one in **Settings**, then **API keys**.
- Many wrong keys in a row from one IP address are slowed down with `429`.

## 429: over quota or too many requests

The response body says `quota_exceeded` or `rate_limited`.

- `quota_exceeded`: your organization used its monthly telemetry volume. New data is refused until the month rolls over (UTC) or you change plan. `Retry-After` gives the seconds left. See [Limits](/docs/otel-limits).
- `rate_limited`: one key sent more than 1200 requests in a minute. Add batching in the SDK or Collector so you send fewer, larger requests.

Exporters retry on 429, so data may arrive later.

## 413: request too large

The limit is 4 MiB per request after decompression. Lower the batch size in your SDK or Collector.

## 402 or 403: no active subscription

The organization has no active subscription. Check the plan in the dashboard.

## 400 or 415

`400` means the body could not be decoded. `415` means an unsupported content type. Use `application/x-protobuf` or `application/json`, and set `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`.

## 503: temporarily busy

The intake queue is backed up. Exporters retry after a few seconds. Nothing to fix unless it lasts.

## Firewall, proxy or TLS errors

If **Apps** shows a key that has never been seen, the request never got an accepted answer. Check:

- The endpoint is exactly `https://otlp.yuktiops.com` (HTTPS, no extra path).
- The machine can reach it. Any HTTP answer from `curl -i https://otlp.yuktiops.com/v1/traces` (even an error such as 401 or 415) shows the connection and TLS work.
- Outbound HTTPS is allowed, and a proxy is configured for your app if you need one.
- The machine's clock and CA certificates are correct, which matters for TLS.

## No data in the dashboard

- A key that has sent logs but no traces: check that auto-instrumentation is actually loaded and that the app handled a request.
- A different `OTEL_SERVICE_NAME` than you expect: look in the Services list for another name.
- Sampling is set very low in the SDK or in **Settings**, then **Telemetry**.
- The time range at the top of the page is too short, or older than your retention.
- A service with no spans for 10 minutes shows as idle.
- If telemetry storage is down, read pages show a short "unavailable" message. Try again shortly.

Accepted data is written within seconds, and within a minute at most under heavy load.
