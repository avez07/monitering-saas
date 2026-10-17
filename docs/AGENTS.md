# Agents, collectors, and instrumentation

The bundled Node agent provides a small cross-platform host heartbeat and OTLP gauges. For richer host, container, log, process, and exporter coverage, use OpenTelemetry Collector Contrib and appropriate receiver permissions. All remote communication should use HTTPS outside local development.

## Enrollment lifecycle

1. Register/sign in and select a project.
2. Generate a short-lived token in Agents → Connect agent.
3. Inspect the supplied agent script and run the generated command.
4. The backend atomically consumes the one-time token, creates the agent, records config version 1, and returns a long-lived credential.
5. The local script writes it to `AGENT_TOKEN` in root `.env`. Do not commit `.env`.
6. Watch inventory and last heartbeat. Offline detection is three minutes.
7. Rotate/revoke through Agent management. A rotated token must replace `.env` and the agent must restart.

The API stores token hashes. Generated credentials are not recoverable from the database. If a credential is lost, rotate it. The Node agent does not open a listening port, does not install packages, and does not request elevated permissions. It reports OS/architecture at startup. Failed requests back off; authentication failure stops the agent. Its heartbeat is custom **inventory control-plane metadata**; telemetry itself is standard OTLP.

## Full OpenTelemetry collector

Download an agent's YAML config from Agent management. Put the agent credential in a local `.env` on that host:

```dotenv
PULSE_AGENT_TOKEN=<credential-from-AGENT_TOKEN>
```

The downloaded YAML references `${env:PULSE_AGENT_TOKEN}` and contains no secret. A Linux host Docker example, after inspecting the configuration:

```text
docker run --rm --name pulse-collector --env-file .env -v ./collector.yaml:/etc/otelcol-contrib/config.yaml:ro -v ./otel-queue:/var/lib/otelcol/queue otel/opentelemetry-collector-contrib:0.123.0
```

The queue directory must be writable by the collector user. Hostmetrics in a container sees its container environment unless the host filesystems/root path and receiver paths are explicitly configured. Prefer a Linux system service for complete host metrics; do not claim host visibility from the example container alone. The supplied collector keeps OTLP listeners on loopback; use a private container network address if SDKs run in other containers and avoid publishing unnecessary ports.

The collector has a persistent file queue, exponential retry, batching, a memory limit, and attribute deletion. Validate the generated configuration with the exact pinned collector version before a managed rollout. No script is fetched and piped into an elevated shell.

For host installation, download the release matching OS/architecture from the official [Collector releases](https://github.com/open-telemetry/opentelemetry-collector-releases), check its published checksum, inspect package contents, and explicitly approve package/service installation. Native package installation, container-runtime detection, and automated port-conflict remediation are not implemented by the bundled Node agent.

## Existing Docker and Compose applications

Run a collector beside existing workloads and point app OTLP exporters at its private endpoint. Add `docker_stats` receiver for container measurements; access to the Docker socket is privileged and should be reviewed. Add `filelog` for explicit application log paths and a matching receiver pipeline. Neither Docker nor Kubernetes migration is required. No blanket Docker socket mount or filesystem log scrape is enabled by default.

## Application SDKs

Install the official OpenTelemetry SDK/instrumentation for your runtime, configure service name and deployment environment, and use the project's collector endpoint. Direct OTLP/HTTP producers can use the Pulse gateway with an ingestion API key from Settings. Keep it in that application's `.env`:

```dotenv
OTEL_SERVICE_NAME=checkout-service
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-api.example/otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20<project-ingestion-api-key>
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

The standard base endpoint appends `/v1/traces`, `/v1/metrics`, and `/v1/logs`. Header escaping support differs by SDK; verify the resulting Authorization header in that SDK's docs. Use individual signal endpoints if the SDK does not append paths. Node, Python, PHP, Java, and .NET require their language SDK and compatible auto/manual instrumentation; Pulse does not ship replacement language SDKs.

For Node.js, preload your instrumentation before application imports; for Python use its instrumentation launcher; for Java attach the official javaagent; for .NET use the supported SDK or automatic instrumentation; for PHP install its supported extension and Composer instrumentation. Restricted shared hosting can send outbound OTLP/HTTP where runtime instrumentation and outbound networking are permitted. Shared hosting cannot provide host-level metrics when it does not grant host access.

Pulse accepts protobuf and JSON OTLP/HTTP, not native OTLP/gRPC. A local collector can receive gRPC and export HTTP to Pulse. JSON OTLP resources can discover service metadata automatically; protobuf currently needs manual application/database resource registration for inventory.

Official protocol configuration: [OpenTelemetry OTLP exporter settings](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/).

## Databases

Use PostgreSQL/MySQL/SQL Server exporters or Collector Contrib receivers with read-only monitoring users. Scrape exporter metrics in a collector and export OTLP/HTTP. Configure exporter credentials in the collector host's `.env`; do not expose database credentials to Pulse's frontend. Select the metric sets and grants required by the database version. Slow-query collection is opt-in and must redact values and query text. The default config deletes `db.statement`, `db.query.text`, and `db.query.parameters`.

Exporter dashboards and snapshot synchronization for application/database alert metrics require additional integration; this repository provides the ingestion/query framework and inventory views, not a completed exporter package for every engine.

## Updates and uninstall

Stop the agent, review the new script/config, verify its release checksum, retain `.env`, replace files, and restart. Revoke access in Pulse before uninstalling. For systemd, the template is `infra/agent/pulse-agent.service`; create a dedicated normal user and adjust paths before enabling. Windows setup is in `infra/agent/windows-service.md`. Kubernetes/Helm charts, signed auto-updates, and a native Windows Service installer remain future work.

Installer integrity is recorded in `infra/agent/checksums.sha256`; regenerate release checksums after changing scripts and distribute them through a trusted release channel. A checksum delivered alongside a tampered script is not a signature.
