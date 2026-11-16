---
title: Customise your telemetry
description: "Custom spans and attributes, exceptions, log correlation, sampling, ignoring health checks and redaction rules."
group: OpenTelemetry
order: 22
---

Automatic instrumentation covers common frameworks. Everything else is normal OpenTelemetry, so any OTel tutorial for your language applies. The examples below use Node.js.

## Custom spans and attributes

```js
const { trace } = require('@opentelemetry/api');
const tracer = trace.getTracer('checkout');

tracer.startActiveSpan('charge-card', (span) => {
  span.setAttribute('order.id', orderId);
  span.setAttribute('user.id', userId);
  // ... your work ...
  span.end();
});
```

Attributes can be searched later in the Traces explorer with an `attribute = value` filter. Do not put secrets or personal data in attributes. If you might, add a redaction rule below.

## Record exceptions

```js
try {
  await charge();
} catch (err) {
  span.recordException(err);
  span.setStatus({ code: 2, message: err.message }); // 2 = error
  throw err;
}
```

Recorded exceptions are grouped by type in the service's error list.

## Correlate logs with traces

Logs are linked to a trace when each log record carries the trace id and span id. Most OTel log integrations (for example the logging instrumentation of your language) add them automatically. In the trace view, related logs then appear next to the spans. You can also search logs by trace id.

## Sampling

To keep fewer traces, set a ratio in the SDK:

```
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.25
```

This keeps about 25% of traces. Sampling in the SDK also reduces what you send, which helps with your monthly volume.

You can also set sampling in the dashboard under **Settings**, then **Telemetry**:

- a trace ratio from 0 to 1 (default 1);
- keep traces that contain an error regardless of the ratio (on by default);
- keep traces with a span slower than a number of milliseconds;
- a minimum log severity; lower severities are dropped.

Data that is sampled out on our side still counts toward your monthly volume, because it was received. To save volume, sample in the SDK.

## Ignore health checks

Health-check requests add noise and volume. Most auto-instrumentation lets you exclude URLs. For example, in Python:

```
OTEL_PYTHON_EXCLUDED_URLS=/health,/ready
```

For Node.js, configure the HTTP instrumentation's `ignoreIncomingRequestHook` to skip paths such as `/health`. For Java and other languages, see your language's OpenTelemetry documentation for the exact option.

## Redaction rules

Under **Settings**, then **Telemetry**, owners and admins can add up to 50 rules. They run on our side before anything is stored, and apply to attributes (resource, span, event, link and log), log bodies, span names and status messages.

- **Attribute rule.** Match an attribute name, case-insensitive. A trailing `*` matches a prefix, for example `http.request.header.*`. The action is `drop` (remove it) or `hash` (replace the value with `sha256:` and 16 hex characters, so the same value can still be matched across records).
- **Pattern rule.** Choose a preset: `email`, `credit_card`, `ipv4`, `jwt` or `bearer`. Matches inside text are replaced with `[REDACTED:<preset>]` (mask) or a hash. Custom patterns are not available.

New rules apply to data processed after you save, usually within seconds. Data already stored is not changed. For the strongest protection, also avoid sending sensitive values from your app.
