# Capacity and cost model

Server count alone is not an ingestion estimate. Measure each tenant's active series, scrape interval, samples/second, log bytes/day, sampled spans/second, average span bytes, retention, query concurrency, and active users.

## Worksheet

Let:

- `H` = hosts; `C` = containers; `SH` = series/host; `SC` = series/container; `SA` = application/exporter series.
- `I` = metric collection interval in seconds.
- `L` = uncompressed logs GB/day.
- `T` = generated spans/sec; `F` = sampling fraction; `B` = average bytes/span.
- `D` = retention days; `R` = replication/availability overhead.

```
activeSeries = H * SH + C * SC + SA
metricSamplesPerSecond = activeSeries / I
metricSamplesPerDay = metricSamplesPerSecond * 86400
traceBytesPerDay = T * F * B * 86400
metricStoredBytesPerDay = metricSamplesPerDay * measuredBytesPerSample
storageBytes = D * R * (metricStoredBytesPerDay + measuredCompressedLogBytesPerDay + measuredCompressedTraceBytesPerDay)
requiredQuerySlots = dashboardRefreshesPerSecond * queriesPerDashboard * measuredQuerySeconds
```

Mimir active series quotas apply per storage tenant (project). Organization byte/rate limits apply at the gateway. Cardinality expansion comes from every distinct label set; never label by request IDs, user IDs, freeform URLs, SQL, or container-generated random identifiers without review.

## Illustrative upper-pilot workload — assumptions, not benchmarks

| Input                       | Assumption                         |
| --------------------------- | ---------------------------------- |
| Hosts / containers          | 150 / 550                          |
| Series per host / container | 300 / 80                           |
| Application/exporter series | 20,000                             |
| Collection interval         | 30 seconds                         |
| Active series               | 109,000                            |
| Metrics rate                | ~3,633 samples/sec                 |
| Metrics samples/day         | ~313.9 million                     |
| Uncompressed logs           | 20 GB/day total                    |
| Generated spans             | 500/sec                            |
| Sampling                    | 10%                                |
| Average span                | 1 KB                               |
| Sampled trace volume        | ~4.32 GB/day before compression    |
| Retention                   | 7 days in this worksheet           |
| Concurrent dashboard users  | 10; measure synchronized refreshes |

At an assumed measured metric compression of 2 bytes/sample, metrics alone would use ~0.63 GB/day before index/cache/WAL overhead. This value must be replaced by storage measurements. With log compression 5:1 and trace compression 3:1, this worksheet gives roughly 42.5 GB for seven days before replication, indexes, WALs, buffers, backups, and free-space headroom. These are explicitly modeling assumptions, not sizing promises. The supplied backends use a shared 30-day physical retention configuration; do not apply the seven-day worksheet to that stack without adjusting it.

## Cost worksheet

No cloud prices are baked in. Fill current quotes from your chosen region/provider:

| Cost component   | Formula                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| Compute          | API/worker hours × price + telemetry backend hours × price                   |
| Object storage   | Average GB-month × storage rate                                              |
| Object requests  | PUT/GET/LIST operations × corresponding rate                                 |
| Network          | Ingress, cross-zone traffic, egress, customer query bytes × applicable rates |
| Metadata / Redis | Managed service monthly quote or actual VM allocation                        |
| Backups          | Retained backup GB-month + restore/test compute                              |
| Email            | Notification count × provider price                                          |
| Payment fees     | Settled revenue × provider fee + fixed components                            |
| Support          | Operational hours × internal cost                                            |

Target plan prices must exceed measured storage/query costs plus support and margin. The UI's INR prices are illustrative fixtures, not validated commercial pricing. Razorpay and global provider selection require current eligibility, settlement, currency, tax, and webhook research before integration.

## Load validation

`npm run load-test` sends 100 requests with concurrency 5 across ten seeded demo organizations and writes percentiles to `verification/load-result.json`. This measures a warm local control plane with JSON metadata. It does **not** prove sustained ingestion capacity, PostgreSQL performance, recovery, or a production SLA.

Before a pilot launch, run OTel `telemetrygen` workloads against the authenticated gateway for each project credential and signal. Ramp 1×, 2×, 5× expected volume, then test cardinality churn, 24-hour log queries, trace fanout, simultaneous dashboard refreshes, and backend outages. Record accepted/rejected bytes, samples, spans, dropped batches, queue depth, CPU, RSS, disk throughput, object requests, p50/p95/p99, and recovery time. Repeat with ten noisy/quiet tenant mixes and confirm one tenant's pressure does not reveal another's data.

Choose minimum hardware only after those measurements. A single-host Compose setup has no redundancy; capacity and availability are separate concerns.
