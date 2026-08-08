# Changelog

All notable changes to CrowdSieve will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.6] - 2026-08-08

Security release: upgrade is recommended for anyone running 0.6.5 or earlier.

### Security

#### Dependencies

- **`@fastify/static` 9.0.0 → 10.1.2**: authorization bypass via non-canonical URL paths, and route-guard bypass via path traversal. Runtime dependency serving the dashboard assets, so every 0.6.5 deployment is affected. Major bump of the plugin, but the usage here (`root` / `prefix` / `decorateReply`) is unchanged.
- **`sharp` pinned to `^0.35.3` via `overrides`**: libvips CVE-2026-33327/33328/35590/35591, reached through Next.js image optimization. An override was needed because `npm audit fix --force` would have downgraded `next` to 14.2.35.
- **`next` → 16.2.12**; `tsx` → 4.23.1 and `vitest` → 4.1.10 on the development side.
- **`ip-cidr` removed**, clearing the last `npm audit` entries (GHSA-v2v4-37r5-5v8g, GHSA-mwp4-54f8-5fhr via its pinned `ip-address@^9`). Neither was reachable here, so this clears the audit rather than closing a live hole. `npm audit` now reports 0 vulnerabilities.

### Changed

#### Filters

- **The `cidr` operator no longer matches across address families.** `ip-cidr` compared raw integers with no family check, so `::1` matched `0.0.0.0/0`. As a consequence `::ffff:192.168.1.1` no longer matches `192.168.0.0/16` — **if you rely on an IPv4 range catching IPv4-mapped sources, add the matching `::ffff:…` range.** This aligns with `expandIPv6()` in `src/analyzers/detection.ts`.
- CIDR matching moved in-tree to `src/filters/cidr.ts`, parsing gated by Node's `net.isIPv4` / `net.isIPv6`. Validated against `ip-cidr@4.0.2` over ~100k generated pairs (IPv4, full-form IPv6, `::`-compressed IPv6) with zero divergences; the remaining edge-case differences are all cases where `ip-cidr` was wrong, arbitrated against Python's `ipaddress` and pinned as tests.

### Fixed

#### Filters

- Ranges with an embedded IPv4 tail were evaluated wrongly: `::ffff:0:0/96` did not contain `::ffff:8.8.8.8`. Both now match.
- Inputs that made the operator throw and never match are now accepted: bare address (implicit `/32`/`/128`), surrounding whitespace, and full-form embedded IPv4 bases. Invalid input keeps its previous behavior (warning logged, condition `false`).

### Added

- `tests/cidr.test.ts` covering containment, `::` compression, embedded IPv4, zone indices, non-aligned prefixes, family separation and malformed input.
- `tests/ipinfo.test.ts` now mocks DNS/WHOIS calls, fixing intermittent CI timeouts.
- Helm: `crowdsec.config."console.yaml"` documented in `values.yaml` (passthrough to the upstream subchart, no template change).

## [0.6.5] - 2026-06-30

### Fixed

#### PostgreSQL

- **Blocked-requests stat stuck at 0 on PostgreSQL**: `getStats()` read the result of `db.execute()` as a bare array (`[0]?.total`), but `drizzle-orm/node-postgres` resolves it to a pg `QueryResult` object (`{ rows: [...] }`), so the value was always `undefined` and `blockedRequests` was silently pinned to `0` regardless of the data. It now reads `result.rows` (staying tolerant of a driver that returns the array directly); SQLite is unchanged. Covered by a PostgreSQL integration regression test.

### Added

#### Helm

- **Configurable deployment update strategy**: the proxy `Deployment` hardcoded `strategy.type: Recreate` (required by the SQLite backend, whose single RWO volume cannot be shared by two pods). The new `crowdsieve.strategy` value (default `{type: Recreate}`, unchanged behavior) lets PostgreSQL users opt into a zero-downtime rolling update — e.g. `type: RollingUpdate` with `maxUnavailable: 0`. The app drains in-flight HTTP and closes the database on `SIGTERM`, and the readiness probe gates the new pod, so no requests are dropped.

## [0.6.4] - 2026-06-30

### Fixed

#### PostgreSQL

- **Bouncer usage-metrics lost on PostgreSQL**: the `bouncers` upsert used SQLite's scalar `MAX(a, b)` to widen `last_seen_at`, but in PostgreSQL `MAX()` is aggregate-only, so the second snapshot for a known bouncer raised `function max(bigint, bigint) does not exist` (SQLSTATE 42883) and the metrics were dropped. PostgreSQL now uses `GREATEST(a, b)`; SQLite is unchanged. Covered by a PostgreSQL integration regression test.

#### SQLite → PostgreSQL migration

- **`scripts/migrate-sqlite-to-postgres.js` was missing half the schema**: the `analyzer_runs`, `analyzer_results`, `bouncers`, and `bouncer_metrics` tables, plus the `replicated`, `local_audit`, and `actor` columns on `alerts`, were not created or copied, so migrating a populated SQLite database silently lost analyzer history and bouncer data. The script now covers every table and column, remapping `analyzer_results.run_id` to the new `analyzer_runs` ids and skipping rows from databases predating each table.

### Added

#### Tests

- **Migration drift guard**: a new test (`tests/migrate-sqlite-to-postgres.test.ts`) derives the expected tables and columns from the Drizzle schemas and fails if the migration script stops covering any of them, so future schema additions can't silently regress the migration again.

## [0.6.3] - 2026-06-30

### Added

#### Helm chart

- **`dashboard.publicUrl` for `NEXTAUTH_URL`**: the dashboard's public base URL (used to build the OIDC `redirect_uri` and the back-channel-logout URL) can now be set independently of the bundled ingress. When left empty it falls back to `https://<ingress.hosts[0].host>` if `ingress.enabled`. Required when routing the dashboard through a custom ingress (e.g. a Traefik `IngressRoute`).

## [0.6.2] - 2026-06-30

### Added

#### Helm chart

- **Source `lapiServers` credentials from an existing Secret**: each entry under `crowdsieve.lapiServers.servers` now accepts `existingSecret` together with `apiKeyKey` / `passwordKey`, so the bouncer API key and machine password can be pulled from a Kubernetes Secret (via `secretKeyRef`) instead of being inlined in `values.yaml`. Inline `apiKey` / `password` keep working unchanged.

## [0.6.1] - 2026-05-11

### Fixed

#### Bouncer metrics (broken version is 0.6.0 only)

- **Blocked Requests inflated by ~5 orders of magnitude**: the metrics parser was summing every `dropped` (and `processed`) item under the same name.
- **Backfill tooling for already-polluted history**: existing rows still hold the correct per-unit breakdown in `metrics_json`, so the columns can be re-derived without data loss. Two equivalent one-shot tools ship in this release:
  - `npm run backfill:bouncer-units` (Node/TypeScript, for dev hosts).
  - `scripts/backfill-bouncer-units.sql` for production containers — the runtime image carries neither `npm` nor `tsx`, so a `sqlite3 ... < fix.sql` from a throwaway alpine container mounted on the data volume is the simplest path. Both are idempotent (zero rows touched on a second run) and transactional.

## [0.6.0] - 2026-05-09

### Added

#### Bouncer metrics

- **CrowdSec bouncer usage-metrics collection**: CrowdSieve now intercepts `POST /v1/usage-metrics` and `POST /v3/usage-metrics`.
  - **CAPI chunked forwarding**: oversized usage-metrics payloads are now split across multiple CAPI POSTs, preventing CAPI rejections on large fleets.
  - **Bouncers dashboard page**
  - **Blocked Requests stat card**: new home-dashboard tile that computes blocked requests as a windowed sum with reset detection.

### Changed

#### Operations

- **Slimmer Docker runtime image**: ~43 MB smaller (now ~190 MB).

### Fixed

- **CAPI forward 415 on signals**: strip `content-encoding` on the CAPI forward path so the upstream no longer rejects re-encoded bodies.
- **Phantom delta inflation**: empty snapshot blocks are skipped, preventing inflated deltas on idle bouncers.

## [0.5.2] - 2026-05-07

### Changed

#### Dependencies

- **React 19**: bumped the dashboard React ecosystem (`react`, `react-dom`, `react-leaflet`, `lucide-react`) to React 19.
- **Tailwind CSS 4**: migrated to Tailwind CSS 4.

### Fixed

#### Dashboard

- **Actor on alert detail**: the human author (login) of a manual ban / unban audit row is now displayed on the alert detail page.

### Security

- Update dependencies.

## [0.5.1] - 2026-05-01

### Fixed

#### Dashboard

- **Scenario filter completeness**: the filter dropdown now lists every distinct scenario seen in the selected window (capped at 500), including locally-recorded audit scenarios such as `crowdsieve/unban`, `crowdsieve/manual-audit`, and `crowdsieve/manual`. Previously it was sourced from `topScenarios` (top 10, audit rows excluded), so users could not filter on manual events from the timeline.
- **Scenario names**: the filter renders fully-qualified scenario names (e.g. `crowdsecurity/http-bad-user-agent`) instead of just the last path segment, removing namespace ambiguity. Truncated selections expose the full value via a `title` tooltip on hover.
- **Filter popovers above the map**: scenario / server / time-range popovers now stack above the Leaflet zoom controls. The z-index is centralized in the base `PopoverContent` component to avoid future drift.

### Added

- **`allScenarios` on `/api/stats`**: new uncapped-by-default (hard cap 500) array of distinct scenarios with counts on the stats payload. `topScenarios` is unchanged (top 10, audit rows excluded) and remains the source for the dashboard summary panel.
- **OpenAPI**: published spec regenerated to include `allScenarios` on `StatsResponse`.

### Documentation

- **Back-channel logout endpoint**: expanded reference for the OIDC back-channel logout endpoint.

## [0.5.0] - 2026-04-30

### Added

#### Authentication

- **HTTP Headers authentication mode**: new `AUTH_MODE=headers` enables deployments behind a "handler"-style reverse proxy (LemonLDAP-NG, NGINX `auth_request`, Apache `mod_auth_*`)
- **Configurable actor claim**: `AUTH_ACTOR_CLAIM` (or legacy `OIDC_ACTOR_CLAIM`) selects which claim identifies the human actor recorded on every manual events. Defaults to `sub`

#### Audit & timeline

- **Decision unban events**: `DELETE /api/decisions/:id` now records a local unban event on the `alerts` table
- **Manual ban audit events**: `POST /api/decisions/ban` now records an immediate local audit row also
- **Audit-friendly logging for human-actor actions**: a new `notice` log level (syslog-equivalent, value 35) is emitted for manual bans (`event: manual_ban`) and unbans (`event: manual_unban`).

### Changed

- **Breaking: `DELETE /api/decisions/:id` requires a body**: the endpoint now expects a JSON body `{ reason: string, ip: string }`. A non-empty `reason` is mandatory (audit trail).
- **Schema**: new boolean column `local_audit` on the `alerts` table flags locally-recorded audit-only events (unban + manual-ban audit). New text column `actor` records the dashboard user that issued the action (sourced from the OIDC/headers session and forwarded via `X-Crowdsieve-Actor`). Migrations are idempotent.

### Fixed

- **Manual ban alert payload**: `POST /api/decisions/ban` now also sets `source.ip` (scope=ip) or `source.range` (scope=range) on the alert pushed to the LAPI, in addition to `source.value`.

## [0.4.0] - 2026-04-26

### Added

#### API

- **OpenAPI specification**: All proxy API routes (`/api/*`, `/v2/signals`, `/v3/signals`, `/health`) now declare TypeBox-based JSON Schema validation
- **OpenAPI documentation site**: Generated `openapi.json` published to https://linagora.github.io/crowdsieve/api/ on every `v*` tag, rendered with Redoc
- **`npm run openapi:generate`** script that introspects all routes and writes the spec to `openapi.json`

### Changed

- **Request validation**: Manual regex/length/enum/required-field checks in API handlers replaced by declarative `schema` blocks. Validation errors keep the same `{ error: string }` response envelope.
- **LAPI passthrough status codes**: `POST /api/decisions/ban` and `DELETE /api/decisions/:id` now map unexpected upstream LAPI status codes to `502 Bad Gateway`. Known codes (400, 401, 403, 404, 500) still pass through unchanged.
- **Dependencies update**: TypeBox and `@fastify/type-provider-typebox` added as runtime dependencies; `@fastify/swagger` added as a dev dependency for spec generation.

## [0.3.5] - 2026-03-12

### Fixed

- **OIDC**: fir redirect_uri given during token exchange

## [0.3.4] - 2026-03-12

### Fixed

- **Helm**: add missing NEXTAUTH_URL for OIDC

## [0.3.3] - 2026-03-12

### Fixed

#### Dashboard

- **OIDC**: force dynamic rendering on login page for runtime OIDC config
- **Decision replication**: prevent replication loop

### Changed

- **Dependencies update**: Update project dependencies

## [0.3.2] - 2026-03-02

### Added

#### Decision Replication

- **LAPI decision replication**: Automatically replicate CAPI decisions to connected LAPI servers, enabling local bouncers to enforce community blocklists without direct CAPI access
  - **UUID-based deduplication**: Prevent duplicate alerts using UUID-based deduplication
- **Replicated alerts tracking**: New `replicated` flag on alerts to track replication status and avoid duplicates

### Fixed

#### Dashboard

- **Local decision deletion**: Decisions with origin `crowdsec` (local agent detections) can now be deleted from the dashboard. Previously they were incorrectly classified as shared CAPI decisions
- **CIDR support in decision search**: Fix URL parameter handling for CIDR notation in the decisions page

#### Backend

- **ARIN WHOIS queries**: Fix WHOIS queries to ARIN returning summary format instead of detailed information
- **Alert forwarding headers**: Don't modify headers when forwarding alerts to CAPI

### Changed

- **Dependencies update**: Update project dependencies

## [0.3.1] - 2026-02-08

### Fixed

#### Dashboard

- **CIDR geolocation display**: Alerts for network ranges (CIDR notation like 185.226.196.0/24) now correctly display geolocation and network information instead of showing "Unknown"
- **Navigation polling leak**: Use Next.js Link component for dashboard navigation to prevent polling leaks

### Changed

- **Docker image**: Upgrade to Node.js 22
- **Dependencies update**: Update @isaacs/brace-expansion to 5.0.1

## [0.3.0] - 2026-02-04

### Added

#### OIDC Authentication

- **Optional OIDC authentication for dashboard**: Protect the dashboard with OpenID Connect authentication via any OIDC-compliant provider
- **JWE support**: Handle encrypted ID tokens from OIDC providers
- **`private_key_jwt` authentication**: Support `private_key_jwt` client authentication method for back-channel logout
- **Key rotation**: Automatic rotation of cryptographic keys used for OIDC

### Changed

- **Alert download optimization**: Skip downloading alerts when no changes detected
- **Dependencies update**: Update project dependencies

## [0.2.0] - 2026-02-01

### Added

#### Dashboard

- **Network/CIDR ban support**: Ban IP ranges using CIDR notation (e.g., 192.168.0.0/24) from the dashboard ban form
- **Decision scope display**: Decision cards now display scope (ip/range) and value

## [0.1.10] - 2026-01-19

### Fixed

#### Helm Chart

- **Filter rules schema**: Update default filter rules to use the new schema format (`filter` with `field`/`op` instead of `expression`)

## [0.1.9] - 2026-01-19

### Added

#### Helm Chart

- **Log analyzers support**: Configure analyzers directly in Helm values

## [0.1.8] - 2026-01-19

### Added

#### Log Analyzers

- **Integrated log analyzer system**: Periodically fetch logs from Grafana/Loki, apply detection rules, and push ban decisions to CrowdSec LAPI servers
- **YAML-based detection rules**: Configurable analyzers in `config/analyzers.d/` with:
  - Flexible scheduling (interval and lookback duration)
  - Field extraction from JSON logs
  - Grouping and distinct value counting
  - Threshold-based alerting with configurable operators
- **Global whitelist**: Define IPs and CIDR ranges to exclude from all analyzer detections
- **Environment variable interpolation**: Use `${VAR}` or `${VAR:-default}` syntax in analyzer configs
- **Multi-target support**: Push decisions to all LAPI servers or specific targets

#### Dashboard

- **Analyzers page**: New `/analyzers` page showing:
  - List of configured analyzers and their status
  - Last run results (logs fetched, alerts generated, decisions pushed)
  - Manual trigger button for immediate execution
  - Next scheduled run time

#### Backend

- **Don't verify Origin header when X-Api-Key exists**
- **Analyzer API endpoints**:
  - `GET /api/analyzers` - List all analyzers with status
  - `GET /api/analyzers/:id` - Get analyzer details
  - `GET /api/analyzers/:id/runs` - Get run history
  - `POST /api/analyzers/:id/run` - Trigger manual run
- **Database tables**: New `analyzer_runs` and `analyzer_results` tables for run history persistence
- **Staggered startup**: Analyzers start with progressive delays to avoid thundering herd on Grafana/Loki
- **GeoIP update script**: New `scripts/update-geoip.sh` for downloading DB-IP database

### Changed

- **GeoIP database**: Switch from MaxMind GeoLite2 to DB-IP Lite (CC BY 4.0)
  - No account or license key required
  - Rename default file from `GeoLite2-City.mmdb` to `geoip-city.mmdb`
  - Helm chart downloads DB-IP on first pod start (no `maxmindLicenseKey` needed)

## [0.1.7] - 2026-01-16

### Added

#### Dashboard

- **Decision statistics**: Added decision breakdown by duration, scenario, and country to the statistics page
- **Decision deletion**: Added ability to delete decisions from LAPI servers via the dashboard

#### Backend

- **Decision stats API**: New `/api/stats/decisions` endpoint for decision statistics
- **Delete decision API**: New `DELETE /api/decisions/:id` endpoint to remove decisions from LAPI

### Changed

- **Release workflow**: GitHub Releases are now created manually instead of automatically on each tag

## [0.1.6] - 2026-01-16

### Added

#### Dashboard

- **Statistics page**: New `/stats` page with interactive visualizations:
- **Responsive header**: Mobile-friendly navigation with hamburger menu

#### Backend

- **Time distribution API**: New `/api/stats/distribution` endpoint for statistics data
- **PostgreSQL integration tests**: Added tests for `getTimeDistributionStats` method

### Changed

- **Frontend optimizations**: Memoized data transformations and added request cancellation for period changes

### Fixed

#### Helm Chart

- **Dashboard API key persistence**: Reuse existing API key secret on upgrades instead of regenerating

## [0.1.5] - 2026-01-16

### Security

- **CSRF protection hardened**: Origin header is now required for ban requests (previously allowed requests without Origin header)
- **API key no longer logged**: Generated API key is no longer printed to console output to prevent accidental exposure in logs
- **Fail-secure API authentication**: API endpoints now reject all requests when `DASHBOARD_API_KEY` is not configured (previously allowed unauthenticated access)

### Fixed

- **Dashboard environment variables in Docker**: Environment variables (`DASHBOARD_API_KEY`, `API_URL`) are now properly read at runtime instead of build time, fixing configuration issues in Docker standalone mode
- **Dashboard error display**: Dashboard now shows clear error messages when API key is missing or rejected, instead of silently failing

### Changed

#### Helm Chart

- **Dashboard API key**: Auto-generate a random API key if `crowdsieve.dashboard.apiKey` is not set, ensuring the dashboard is always protected by authentication

## [0.1.4] - 2026-01-15

### Fixed

#### Helm Chart

- **Machine registration script**: Fix grep pattern to use exact match (`^name `) instead of substring match, preventing false positives when machine names are prefixes of other machine names (e.g., "crowdsieve" matching "crowdsieve-lapi-xxx")

## [0.1.3] - 2026-01-15

### Added

#### Helm Chart

- **Dashboard LAPI integration**: Configure connections to CrowdSec LAPI servers for dashboard features:
  - View active decisions from LAPI
  - Create manual IP bans from the dashboard
  - Auto-configure local LAPI connection using first bouncer and machine credentials (`lapiServers.autoConfigureLocal`)

## [0.1.2] - 2026-01-15

### Added

#### Helm Chart

- **Pre-registered machines**: Configure machines (agents/watchers) with credentials that are automatically registered when CrowdSec LAPI starts via a postStart lifecycle hook

## [0.1.1] - 2026-01-15

### Added

#### Helm Chart

- **PostgreSQL support for CrowdSec LAPI**: Enable High Availability deployments with multiple LAPI replicas using a shared PostgreSQL database

- **Pre-registered bouncers**: Configure bouncer API keys that are automatically registered when CrowdSec LAPI starts

- **Agent credentials**: Configure custom agent credentials for LAPI authentication

- **Ready-to-use PostgreSQL example**: New `values-postgres.yaml` file with complete configuration for both CrowdSieve and CrowdSec LAPI with PostgreSQL backend

- **Configuration validations**:
  - Prevent `replicaCount > 1` with SQLite for both CrowdSieve and CrowdSec LAPI
  - Require PostgreSQL connection fields (host, database, user, password/existingSecret) when `database.type=postgres`
  - Require `DB_PASSWORD` environment variable when using PostgreSQL
  - Require `extraVolumeMounts` with `db-config` when using PostgreSQL for CrowdSec LAPI

### Fixed

- Move Docker Hub README sync to separate job to avoid blocking releases

## [0.1.0] - 2026-01-14

- Initial release of CrowdSieve
