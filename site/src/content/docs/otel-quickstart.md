---
title: OpenTelemetry quickstart
description: "Send traces and logs from your app to YuktiOps with the standard OpenTelemetry SDK, using a key and a few environment variables."
group: OpenTelemetry
order: 20
---

OpenTelemetry (OTel) is the open standard for sending traces and logs from your own application. YuktiOps accepts it directly, so you do not install anything proprietary in your app. You set a few environment variables, restart the app, and it appears under **Apps** in the dashboard.

- **Traces** show each request and the steps inside it.
- **Logs** are your application log lines, linked to the trace they belong to when your logging is set up for it.
- **Metrics** are accepted but not stored yet.

## 1. Get a telemetry key

1. Open **Settings**, then **API keys**, in the dashboard.
2. Create a telemetry key. Name it after the environment, for example `production` or `staging`. Only an owner or admin can do this.
3. Copy the key now. It starts with `yk_otel_` and is shown only once.

A telemetry key can only send data. It is not the same as the install key (`yk_live_...`) that the server agent uses, and the two are not interchangeable. Each organization can have up to 20 active telemetry keys. If a key leaks, revoke it and create a new one.

## 2. Set the environment variables

```
OTEL_SERVICE_NAME=checkout-api
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.yuktiops.com
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=x-yuktiops-key=yk_otel_your_key_here
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production
```

- The endpoint is `https://otlp.yuktiops.com`. The SDK adds `/v1/traces` and `/v1/logs` by itself.
- The key goes in the `x-yuktiops-key` header.
- `OTEL_SERVICE_NAME` is the name you will see in the Services list.
- Both protobuf and JSON are accepted over HTTP, and gzip is supported.

Then add the language-specific install lines from [Set up by language](/docs/otel-languages).

## 3. Check that it works

Open **Apps** in the dashboard. The page shows **Waiting for your first trace** and updates every few seconds. Send a few requests to your app. Data normally appears within a minute. If it does not, see [OpenTelemetry troubleshooting](/docs/otel-troubleshooting).

## Next

- [Set up by language](/docs/otel-languages)
- [Customise: spans, attributes, sampling, redaction](/docs/otel-customise)
- [Collector setup](/docs/otel-collector)
- [Limits and retention](/docs/otel-limits)
