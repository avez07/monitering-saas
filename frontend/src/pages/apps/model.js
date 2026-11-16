// Pure helpers for the Apps pages: snippet generators, filter parsing and waterfall maths.
// No React and no browser APIs, so node:test can run them.

export const KEY_PLACEHOLDER = 'yk_otel_PASTE_YOUR_KEY';
export const DEFAULT_ENDPOINT = 'https://otlp.yuktiops.com';
export const HEADER = 'x-yuktiops-key';

export const LANGUAGES = [
  { id: 'node', label: 'Node.js' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'go', label: 'Go' },
  { id: 'dotnet', label: '.NET' },
  { id: 'php', label: 'PHP' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'collector', label: 'Collector' },
];

const clean = (s, fallback) => (String(s ?? '').trim() || fallback);
/** Service names go into env vars and shell commands: keep letters, digits, dot, dash, underscore. */
export const safeName = (s) => clean(s, 'my-app').replace(/[^A-Za-z0-9._-]/g, '-');
const trimSlash = (s) => String(s).replace(/\/+$/, '');

/** The four standard env vars, as KEY=value lines. */
export function envVars({ service, endpoint, key, environment } = {}) {
  return [
    `OTEL_SERVICE_NAME=${safeName(service)}`,
    `OTEL_EXPORTER_OTLP_ENDPOINT=${trimSlash(clean(endpoint, DEFAULT_ENDPOINT))}`,
    `OTEL_EXPORTER_OTLP_HEADERS=${HEADER}=${clean(key, KEY_PLACEHOLDER)}`,
    `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=${safeName(environment || 'production')}`,
  ].join('\n');
}

/** Same variables as `export` lines for a shell. */
export function envExports(opts) {
  return envVars(opts)
    .split('\n')
    .map((line) => {
      const i = line.indexOf('=');
      return `export ${line.slice(0, i)}="${line.slice(i + 1)}"`;
    })
    .join('\n');
}

/** Install and start commands per language (zero code: the SDK or agent patches common libraries). */
export function installSteps(lang, { service } = {}) {
  const name = safeName(service);
  switch (lang) {
    case 'node':
      return {
        install: 'npm install @opentelemetry/api @opentelemetry/auto-instrumentations-node',
        run: 'node --require @opentelemetry/auto-instrumentations-node/register app.js',
        note: 'Works with Express, Fastify, Nest, pg, redis and most popular libraries. Add the variables above first.',
      };
    case 'python':
      return {
        install:
          'pip install opentelemetry-distro opentelemetry-exporter-otlp\nopentelemetry-bootstrap -a install',
        run: 'opentelemetry-instrument python app.py',
        note: 'Works with Flask, Django, FastAPI, requests and database drivers. For gunicorn use: opentelemetry-instrument gunicorn app:app',
      };
    case 'java':
      return {
        install:
          'curl -L -o opentelemetry-javaagent.jar https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar',
        run: 'java -javaagent:./opentelemetry-javaagent.jar -jar app.jar',
        note: 'Works with Spring Boot, JDBC, Kafka and more. No code changes.',
      };
    case 'go':
      return {
        install:
          'go get go.opentelemetry.io/otel go.opentelemetry.io/otel/sdk go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp',
        run: `OTEL_SERVICE_NAME=${name} go run .`,
        note: 'Go has no zero-code agent, so add the few lines of setup below once. The env vars still choose the endpoint and key.',
        code: GO_SETUP,
      };
    case 'dotnet':
      return {
        install:
          'curl -L -O https://github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases/latest/download/otel-dotnet-auto-install.sh\nchmod +x otel-dotnet-auto-install.sh && ./otel-dotnet-auto-install.sh',
        run: '. $HOME/.otel-dotnet-auto/instrument.sh\ndotnet App.dll',
        note: 'On Windows use the PowerShell module from the same release page. Works with ASP.NET Core, HttpClient and SQL clients.',
      };
    case 'php':
      return {
        install:
          'pecl install opentelemetry\ncomposer require open-telemetry/sdk open-telemetry/exporter-otlp open-telemetry/opentelemetry-auto-laravel',
        run: 'php artisan serve',
        note: 'Add extension=opentelemetry to php.ini and set OTEL_PHP_AUTOLOAD_ENABLED=true. Swap the auto-laravel package for your framework (slim, symfony, psr15).',
      };
    case 'ruby':
      return {
        install:
          'bundle add opentelemetry-sdk opentelemetry-exporter-otlp opentelemetry-instrumentation-all',
        run: 'bundle exec rails server',
        note: 'Add OpenTelemetry::SDK.configure { |c| c.use_all } in config/initializers/opentelemetry.rb (one line). Works with Rails, Sinatra, Rack and Sidekiq.',
        code: "require 'opentelemetry/sdk'\nrequire 'opentelemetry/exporter/otlp'\nrequire 'opentelemetry/instrumentation/all'\n\nOpenTelemetry::SDK.configure do |c|\n  c.use_all\nend",
      };
    default:
      return null;
  }
}

const GO_SETUP = `package main

import (
	"context"
	"net/http"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/trace"
)

func main() {
	ctx := context.Background()
	// Reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS.
	exporter, _ := otlptracehttp.New(ctx)
	provider := trace.NewTracerProvider(trace.WithBatcher(exporter))
	defer provider.Shutdown(ctx)
	otel.SetTracerProvider(provider)

	mux := http.NewServeMux()
	// ... your routes
	http.ListenAndServe(":8080", otelhttp.NewHandler(mux, "server"))
}`;

/** Customise examples: list of { id, title, text, code } for one language. */
export function customiseExamples(lang) {
  const set = CUSTOM[lang];
  if (!set) return [];
  return TOPICS.map(({ id, title, text }) => ({ id, title, text, code: set[id] })).filter((x) => x.code);
}

const TOPICS = [
  { id: 'span', title: 'Add your own span with attributes', text: 'Wrap a piece of work so it shows up as its own bar in the trace.' },
  { id: 'ids', title: 'Attach a user or order id', text: 'Then search traces with attribute = value, for example order.id = 42.' },
  { id: 'exception', title: 'Record an exception', text: 'The error is grouped by type on the service page and marks the trace as failed.' },
  { id: 'logs', title: 'Put the trace id in your logs', text: 'Logs written inside a request are linked to its trace automatically when you use the OpenTelemetry log bridge. This adds the id to plain text logs too.' },
  { id: 'sampling', title: 'Keep only some traces (sampling)', text: 'Keeps 10% of traces to save volume. Set it as env vars, no code needed.' },
  { id: 'ignore', title: 'Ignore health-check routes', text: 'Stops /health and /ready from filling your quota.' },
];

const CUSTOM = {
  node: {
    span: `const { trace } = require('@opentelemetry/api');
const tracer = trace.getTracer('checkout');

async function chargeCard(order) {
  return tracer.startActiveSpan('charge-card', async (span) => {
    span.setAttribute('payment.provider', 'razorpay');
    try {
      return await doCharge(order);
    } finally {
      span.end();
    }
  });
}`,
    ids: `const { trace } = require('@opentelemetry/api');

app.use((req, res, next) => {
  const span = trace.getActiveSpan();
  span?.setAttribute('user.id', req.user?.id ?? 'anonymous');
  span?.setAttribute('order.id', req.params.orderId ?? '');
  next();
});`,
    exception: `const { trace, SpanStatusCode } = require('@opentelemetry/api');

try {
  await chargeCard(order);
} catch (err) {
  const span = trace.getActiveSpan();
  span?.recordException(err);
  span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  throw err;
}`,
    logs: `const { trace } = require('@opentelemetry/api');

function log(message) {
  const ctx = trace.getActiveSpan()?.spanContext();
  console.log(JSON.stringify({ message, trace_id: ctx?.traceId, span_id: ctx?.spanId }));
}`,
    sampling: `OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1`,
    ignore: `OTEL_NODE_ENABLED_INSTRUMENTATIONS=http,express,pg
# Skip health checks on incoming requests:
OTEL_INSTRUMENTATION_HTTP_IGNORE_INCOMING_PATHS=/health,/ready`,
  },
  python: {
    span: `from opentelemetry import trace
tracer = trace.get_tracer("checkout")

def charge_card(order):
    with tracer.start_as_current_span("charge-card") as span:
        span.set_attribute("payment.provider", "razorpay")
        return do_charge(order)`,
    ids: `from opentelemetry import trace

span = trace.get_current_span()
span.set_attribute("user.id", user.id)
span.set_attribute("order.id", order.id)`,
    exception: `from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

try:
    charge_card(order)
except Exception as err:
    span = trace.get_current_span()
    span.record_exception(err)
    span.set_status(Status(StatusCode.ERROR, str(err)))
    raise`,
    logs: `# Adds trace ids to standard logging records:
OTEL_PYTHON_LOG_CORRELATION=true
# Then use a format such as:
# logging.basicConfig(format="%(asctime)s %(message)s trace_id=%(otelTraceID)s span_id=%(otelSpanID)s")`,
    sampling: `OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1`,
    ignore: `OTEL_PYTHON_EXCLUDED_URLS=health,ready,metrics`,
  },
  java: {
    span: `import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;

Tracer tracer = GlobalOpenTelemetry.getTracer("checkout");

void chargeCard(Order order) {
    Span span = tracer.spanBuilder("charge-card").startSpan();
    try (var scope = span.makeCurrent()) {
        span.setAttribute("payment.provider", "razorpay");
        doCharge(order);
    } finally {
        span.end();
    }
}`,
    ids: `Span span = Span.current();
span.setAttribute("user.id", user.getId());
span.setAttribute("order.id", order.getId());`,
    exception: `try {
    chargeCard(order);
} catch (Exception err) {
    Span span = Span.current();
    span.recordException(err);
    span.setStatus(io.opentelemetry.api.trace.StatusCode.ERROR, err.getMessage());
    throw err;
}`,
    logs: `# The Java agent adds trace_id and span_id to the logging context (MDC) by itself.
# Use them in logback: %X{trace_id} %X{span_id}
OTEL_INSTRUMENTATION_LOGBACK_MDC_ENABLED=true`,
    sampling: `OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1`,
    ignore: `OTEL_INSTRUMENTATION_HTTP_SERVER_EXCLUDE_URLS=/health,/ready`,
  },
  go: {
    span: `tracer := otel.Tracer("checkout")

func chargeCard(ctx context.Context, order Order) error {
	ctx, span := tracer.Start(ctx, "charge-card")
	defer span.End()
	span.SetAttributes(attribute.String("payment.provider", "razorpay"))
	return doCharge(ctx, order)
}`,
    ids: `span := trace.SpanFromContext(ctx)
span.SetAttributes(
	attribute.String("user.id", user.ID),
	attribute.String("order.id", order.ID),
)`,
    exception: `if err := chargeCard(ctx, order); err != nil {
	span := trace.SpanFromContext(ctx)
	span.RecordError(err)
	span.SetStatus(codes.Error, err.Error())
	return err
}`,
    logs: `sc := trace.SpanContextFromContext(ctx)
slog.InfoContext(ctx, "charging card",
	"trace_id", sc.TraceID().String(),
	"span_id", sc.SpanID().String(),
)`,
    sampling: `OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1`,
    ignore: `handler := otelhttp.NewHandler(mux, "server",
	otelhttp.WithFilter(func(r *http.Request) bool {
		return r.URL.Path != "/health" && r.URL.Path != "/ready"
	}),
)`,
  },
  dotnet: {
    span: `using System.Diagnostics;

static readonly ActivitySource Source = new("Checkout");

void ChargeCard(Order order)
{
    using var activity = Source.StartActivity("charge-card");
    activity?.SetTag("payment.provider", "razorpay");
    DoCharge(order);
}
// Also set: OTEL_DOTNET_AUTO_TRACES_ADDITIONAL_SOURCES=Checkout`,
    ids: `var activity = Activity.Current;
activity?.SetTag("user.id", user.Id);
activity?.SetTag("order.id", order.Id);`,
    exception: `try { ChargeCard(order); }
catch (Exception err)
{
    Activity.Current?.AddException(err);
    Activity.Current?.SetStatus(ActivityStatusCode.Error, err.Message);
    throw;
}`,
    logs: `// ILogger writes are linked to the current trace by the auto-instrumentation.
// For plain text logs, add the ids yourself:
logger.LogInformation("charging card trace_id={TraceId}", Activity.Current?.TraceId);`,
    sampling: `OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1`,
    ignore: `OTEL_DOTNET_AUTO_TRACES_ASPNETCORE_INSTRUMENTATION_EXCLUDE_PATHS=/health,/ready`,
  },
  php: {
    span: `use OpenTelemetry\\API\\Globals;

$tracer = Globals::tracerProvider()->getTracer('checkout');
$span = $tracer->spanBuilder('charge-card')->startSpan();
$scope = $span->activate();
try {
    $span->setAttribute('payment.provider', 'razorpay');
    chargeCard($order);
} finally {
    $scope->detach();
    $span->end();
}`,
    ids: `use OpenTelemetry\\API\\Trace\\Span;

$span = Span::getCurrent();
$span->setAttribute('user.id', $user->id);
$span->setAttribute('order.id', $order->id);`,
    exception: `use OpenTelemetry\\API\\Trace\\Span;
use OpenTelemetry\\API\\Trace\\StatusCode;

try {
    chargeCard($order);
} catch (\\Throwable $err) {
    $span = Span::getCurrent();
    $span->recordException($err);
    $span->setStatus(StatusCode::STATUS_ERROR, $err->getMessage());
    throw $err;
}`,
    logs: `use OpenTelemetry\\API\\Trace\\Span;

$ctx = Span::getCurrent()->getContext();
error_log(json_encode(['message' => 'charging card', 'trace_id' => $ctx->getTraceId(), 'span_id' => $ctx->getSpanId()]));`,
    sampling: `OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1`,
    ignore: `OTEL_PHP_EXCLUDED_URLS=health,ready`,
  },
  ruby: {
    span: `tracer = OpenTelemetry.tracer_provider.tracer('checkout')

def charge_card(order)
  tracer.in_span('charge-card', attributes: { 'payment.provider' => 'razorpay' }) do
    do_charge(order)
  end
end`,
    ids: `span = OpenTelemetry::Trace.current_span
span.set_attribute('user.id', current_user.id.to_s)
span.set_attribute('order.id', order.id.to_s)`,
    exception: `begin
  charge_card(order)
rescue => err
  span = OpenTelemetry::Trace.current_span
  span.record_exception(err)
  span.status = OpenTelemetry::Trace::Status.error(err.message)
  raise
end`,
    logs: `ctx = OpenTelemetry::Trace.current_span.context
Rails.logger.info({ message: 'charging card', trace_id: ctx.hex_trace_id, span_id: ctx.hex_span_id }.to_json)`,
    sampling: `OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1`,
    ignore: `# config/initializers/opentelemetry.rb
OpenTelemetry::SDK.configure do |c|
  c.use 'OpenTelemetry::Instrumentation::Rack', untraced_endpoints: ['/health', '/ready']
end`,
  },
};

/** OpenTelemetry Collector config: send to YuktiOps, optionally ship log files and receive from apps. */
export function collectorConfig({ endpoint, key, logPath } = {}) {
  const path = clean(logPath, '/var/log/myapp/*.log');
  return `receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318
  filelog:
    include: [ ${path} ]
    start_at: end

processors:
  batch: {}

exporters:
  otlphttp:
    endpoint: ${trimSlash(clean(endpoint, DEFAULT_ENDPOINT))}
    headers:
      ${HEADER}: ${clean(key, KEY_PLACEHOLDER)}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp]
    logs:
      receivers: [otlp, filelog]
      processors: [batch]
      exporters: [otlphttp]`;
}

export const COLLECTOR_RUN =
  'docker run -d --name otelcol --network host -v "$PWD/otel-config.yaml:/etc/otelcol-contrib/config.yaml:ro" -v /var/log/myapp:/var/log/myapp:ro otel/opentelemetry-collector-contrib:latest';

/**
 * What to tell a person who is still waiting. `connection` is GET /api/apps/connection.
 * Returns { state, title, hints[] } where state is none | waiting | logs-only | connected.
 */
export function connectionHints(connection) {
  const keys = connection?.keys ?? [];
  if (connection?.anyTraceSeen)
    return { state: 'connected', title: 'Your first trace arrived.', hints: [] };
  if (keys.length === 0)
    return {
      state: 'no-key',
      title: 'Create a key first',
      hints: ['Create a telemetry key below. It is the password your app uses to send data.'],
    };
  const reached = keys.some((k) => k.lastSeenAt);
  if (!reached)
    return {
      state: 'waiting',
      title: 'Waiting for your first trace…',
      hints: [
        'Wrong key: copy the whole key, including yk_otel_. Install keys (yk_live_) do not work here.',
        'Wrong endpoint: use the address above with no /v1/traces on the end for SDK env vars (the SDK adds it).',
        'Firewall: the machine running your app must be allowed to reach the endpoint on port 443.',
        'TLS: if you use a proxy that re-signs HTTPS, trust its certificate in your runtime. Do not switch to http.',
        'Send a few requests to your app. Traces are sent in batches every few seconds.',
      ],
    };
  return {
    state: 'logs-only',
    title: 'Data is arriving, but no traces yet',
    hints: [
      'We received something (for example logs or metrics) but no traces.',
      'Check that tracing is enabled (OTEL_TRACES_EXPORTER is not "none") and send a few requests to your app.',
      'If you set a sampling ratio, a very low value can hide traces. Try 1 while testing.',
    ],
  };
}

// ---- filters ----

/** "key=value" text to a pair, or null when it is not valid. */
export function parseAttribute(text) {
  const s = String(text ?? '').trim();
  const i = s.indexOf('=');
  if (i < 1 || i === s.length - 1) return null;
  return { key: s.slice(0, i).trim(), value: s.slice(i + 1).trim() };
}

/** Query params for the traces or logs list. Empty values are dropped. attribute may repeat (max 5). */
export function listParams(f = {}) {
  const out = {};
  for (const k of ['service', 'endpoint', 'status', 'severity', 'traceId', 'q', 'range']) {
    if (f[k]) out[k] = f[k];
  }
  const ms = Number(f.minDurationMs);
  if (f.minDurationMs !== '' && f.minDurationMs != null && Number.isFinite(ms) && ms > 0)
    out.minDurationMs = String(ms);
  return out;
}

/** Search string for the fetch helper: params plus repeated attribute=key=value. */
export function listQuery(f = {}, extra = {}) {
  const p = new URLSearchParams({ ...listParams(f), ...extra });
  for (const a of (f.attributes ?? []).slice(0, 5)) p.append('attribute', `${a.key}=${a.value}`);
  return p.toString();
}

// ---- waterfall ----

/** Position of each span as percentages of the whole trace, plus depth for indentation. */
export function waterfallRows(trace) {
  const spans = trace?.spans ?? [];
  const total = Math.max(
    Number(trace?.durationMs) || 0,
    ...spans.map((s) => (s.startOffsetMs || 0) + (s.durationMs || 0)),
    0.001,
  );
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const children = new Map();
  const roots = [];
  for (const s of spans) {
    if (s.parentSpanId && byId.has(s.parentSpanId)) {
      if (!children.has(s.parentSpanId)) children.set(s.parentSpanId, []);
      children.get(s.parentSpanId).push(s);
    } else roots.push(s);
  }
  const byStart = (a, b) => (a.startOffsetMs || 0) - (b.startOffsetMs || 0);
  const rows = [];
  const walk = (span, depth) => {
    rows.push({
      span,
      depth,
      left: Math.min(100, ((span.startOffsetMs || 0) / total) * 100),
      // Always at least 0.5% wide so very short spans stay visible.
      width: Math.max(0.5, Math.min(100, ((span.durationMs || 0) / total) * 100)),
    });
    (children.get(span.spanId) ?? []).sort(byStart).forEach((c) => walk(c, depth + 1));
  };
  roots.sort(byStart).forEach((r) => walk(r, 0));
  return rows;
}

export const SEVERITY_ORDER = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

/** Words for the service status. Colour + word, never colour alone. */
export const APP_STATUS = {
  healthy: { label: 'Healthy', key: 'healthy' },
  degraded: { label: 'Some errors', key: 'warning' },
  failing: { label: 'Failing', key: 'unhealthy' },
  idle: { label: 'No recent traffic', key: 'unknown' },
};
export const appStatus = (s) => APP_STATUS[s] ?? APP_STATUS.idle;

export function formatBytesGb(bytes) {
  const gb = (Number(bytes) || 0) / 1024 ** 3;
  return gb >= 10 ? `${gb.toFixed(0)} GB` : gb >= 0.1 ? `${gb.toFixed(1)} GB` : `${(gb * 1024).toFixed(0)} MB`;
}

/** Settings payload for sampling: percent text to ratio, clamped. */
export function percentToRatio(text) {
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n / 100));
}
