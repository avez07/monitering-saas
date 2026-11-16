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
