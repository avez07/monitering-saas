---
title: OpenTelemetry by language
description: "Zero-code OpenTelemetry setup for Node.js, Python, Java, Go, .NET, PHP and Ruby, using standard OTEL_* environment variables."
group: OpenTelemetry
order: 21
---

Every language below uses the same environment variables from the [quickstart](/docs/otel-quickstart). Set them first:

```
OTEL_SERVICE_NAME=checkout-api
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.yuktiops.com
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=x-yuktiops-key=yk_otel_your_key_here
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production
```

The install lines come from each language's official OpenTelemetry project and may change between versions. If a command fails, check that project's current documentation. The environment variables stay the same.

To send logs as well as traces, also turn on the log exporter for your language where it is not on by default (for example `OTEL_LOGS_EXPORTER=otlp`). Support differs by language and version.

## Node.js

```bash
npm install @opentelemetry/api @opentelemetry/auto-instrumentations-node
node --require @opentelemetry/auto-instrumentations-node/register app.js
```

## Python

```bash
pip install opentelemetry-distro opentelemetry-exporter-otlp
opentelemetry-bootstrap -a install
opentelemetry-instrument python app.py
```

For a server such as gunicorn or uvicorn, put `opentelemetry-instrument` in front of the command.

## Java

Download the OpenTelemetry Java agent (`opentelemetry-javaagent.jar`) from the project's releases page, then start your app with it:

```bash
java -javaagent:/path/to/opentelemetry-javaagent.jar -jar app.jar
```

## Go

Go does not have an in-process zero-code agent. Add the OpenTelemetry Go SDK and the instrumentation library for your framework (for example `net/http`), and create the exporter from the standard environment variables, which the SDK reads. Your code needs a small one-time setup; the variables above need no change.

## .NET

Use the OpenTelemetry .NET automatic instrumentation. After installing it following the project's instructions, load it into your shell and start the app:

```bash
. $HOME/.otel-dotnet-auto/instrument.sh
dotnet app.dll
```

## PHP

```bash
pecl install opentelemetry
composer require open-telemetry/sdk open-telemetry/exporter-otlp
```

Then add:

```
OTEL_PHP_AUTOLOAD_ENABLED=true
OTEL_TRACES_EXPORTER=otlp
```

## Ruby

```bash
gem install opentelemetry-sdk opentelemetry-exporter-otlp opentelemetry-instrumentation-all
```

Add this once when your app starts (for Rails, an initializer):

```ruby
require 'opentelemetry/sdk'
require 'opentelemetry/exporter/otlp'
require 'opentelemetry/instrumentation/all'

OpenTelemetry::SDK.configure do |c|
  c.use_all
end
```

The endpoint, header and service name still come from the environment variables.

## Not sure it worked?

See [OpenTelemetry troubleshooting](/docs/otel-troubleshooting).
