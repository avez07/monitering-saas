---
title: OpenTelemetry Collector
description: "Send telemetry through an OpenTelemetry Collector with the otlphttp exporter, and ship existing log files with the filelog receiver."
group: OpenTelemetry
order: 23
---

If you already run an OpenTelemetry Collector, or want one to batch and forward data for several apps, add YuktiOps as an `otlphttp` exporter.

```yaml
receivers:
  otlp:
    protocols:
      http:
  filelog:
    include: [ /var/log/myapp/*.log ]
    start_at: end

processors:
  batch:

exporters:
  otlphttp/yuktiops:
    endpoint: https://otlp.yuktiops.com
    headers:
      x-yuktiops-key: ${env:YUKTIOPS_OTEL_KEY}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/yuktiops]
    logs:
      receivers: [otlp, filelog]
      processors: [batch]
      exporters: [otlphttp/yuktiops]
```

Set `YUKTIOPS_OTEL_KEY` to your telemetry key (`yk_otel_...`) in the Collector's environment so the key is not written into the file.

- The `otlphttp` exporter appends `/v1/traces` and `/v1/logs` to the endpoint.
- The `filelog` receiver reads lines from existing log files, so apps that only write to files can still send logs. Log lines read this way carry no trace id unless you parse one out of the line.
- Your apps then send to the Collector (for example `http://localhost:4318`) and need no YuktiOps key themselves.
- Metrics are accepted but not stored yet, so there is no need to add a metrics pipeline.

YuktiOps answers `429` or `503` with a `Retry-After`, and exporters treat those as retryable. See [Limits](/docs/otel-limits).

## Try it locally

1. In the dashboard open Apps (OpenTelemetry) and create a **telemetry key** (name it `local`). Copy the `yk_otel_...` value; it is shown once. Telemetry keys are different from the server install key (`yk_live_...`), which the OTLP endpoint rejects.
2. Save this as `otel-collector.yaml`. For a local YuktiOps API the endpoint is `http://localhost:4000` (the SDK/exporter appends `/v1/traces`, `/v1/logs`); the header is `x-yuktiops-key`.

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
      grpc:
        endpoint: 0.0.0.0:4317
processors:
  batch:
exporters:
  otlphttp/yuktiops:
    endpoint: http://localhost:4000
    headers:
      x-yuktiops-key: ${env:YUKTIOPS_OTEL_KEY}
service:
  pipelines:
    traces: { receivers: [otlp], processors: [batch], exporters: [otlphttp/yuktiops] }
    logs:   { receivers: [otlp], processors: [batch], exporters: [otlphttp/yuktiops] }
```

3. Run the Collector (bash; in PowerShell use `$env:YUKTIOPS_OTEL_KEY='yk_otel_...'` and `${PWD}`). On Docker Desktop use `host.docker.internal` instead of `localhost` in `endpoint`:

```
docker run --rm -p 4317:4317 -p 4318:4318 -e YUKTIOPS_OTEL_KEY=yk_otel_... \
  -v "$PWD/otel-collector.yaml:/etc/otelcol-contrib/config.yaml" \
  otel/opentelemetry-collector-contrib:0.111.0
```

4. Point your app at the Collector: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`. Or skip the Collector and send straight to the API: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4000` with `OTEL_EXPORTER_OTLP_HEADERS=x-yuktiops-key=yk_otel_...`.
5. Check the key works: `curl -i -X POST http://localhost:4000/v1/traces -H "x-yuktiops-key: yk_otel_..." -H "Content-Type: application/json" -d '{"resourceSpans":[]}'` should answer `200`; `401` means a wrong or install key.
