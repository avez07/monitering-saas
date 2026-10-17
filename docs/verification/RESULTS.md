# Verification results — 17 October 2026

Verified in this Windows workspace with Node.js 24.15.0, npm 12, installed Google Chrome, and Docker Desktop 29.4.2 using Linux containers.

| Check | Result |
| --- | --- |
| Backend integration/security tests | 12 tests passed, including running the real Node agent, saving its credential to an isolated .env, receiving a heartbeat, and preventing restricted administrators from widening project access |
| Browser end-to-end tests | 4 tests passed; all 14 areas, search, trace details, enrollment, registration, project persistence, mobile navigation |
| Production frontend build | Passed; vendor/chart chunks split |
| Prisma schema | Valid; client generated |
| PostgreSQL migrations | Both committed migrations applied successfully to the isolated integration database |
| Connected metadata | Registration, project access, ingestion API key creation, agent enrollment and heartbeat passed against PostgreSQL |
| Connected metrics | OTLP JSON accepted by Mimir; project query returned the ingested gauge |
| Connected logs | OTLP JSON accepted by Loki; authorized log query returned the ingested event |
| Connected traces | OTLP JSON accepted by Tempo; search and trace detail returned the ingested trace |
| Live tenant isolation | Second organization saw no first-organization telemetry; forged organization header returned 403 |
| Compose configuration | Valid; PostgreSQL, Redis, RustFS, Mimir, Loki, Tempo, and Mailpit started |
| Linux app image | Built successfully; container applied migrations, served the built dashboard with HTTP 200, and reported healthy connected mode with demo login disabled |
| Dependency audit | Installation reported zero known vulnerabilities after dependency updates |
| Ten-tenant local API check | 100 requests, concurrency 5, zero errors; measurements saved in load-result.json |

Machine-readable connected results: [connected-result.json](connected-result.json). Desktop/mobile screenshots: [dashboard.png](dashboard.png), [mobile.png](mobile.png).

The connected verification creates fixtures in `pulse_integration`, a separate database. It does not use the main demo JSON store or delete the main PostgreSQL database. Startup tests found and fixed a writable-directory issue in Mimir and an OTLP metric-name suffix mismatch.

These checks do not establish production load capacity, availability, or a security certification. Native installer matrices, application/database exporter coverage, sustained telemetry load, full SMTP delivery, actual payment settlement, backup/restore drills, Kubernetes, hybrid/offline licensing, and upgrade/rollback automation remain unverified or unimplemented as listed in STATUS.md.

Containers and preview processes used for verification are stopped at handoff; their persisted test volumes remain available for a subsequent local start.
