# Changelog

All notable changes to CrowdSieve will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.4] - 2025-01-15

### Fixed

#### Helm Chart

- **Machine registration script**: Fix grep pattern to use exact match (`^name `) instead of substring match, preventing false positives when machine names are prefixes of other machine names (e.g., "crowdsieve" matching "crowdsieve-lapi-xxx")

## [0.1.3] - 2025-01-15

### Added

#### Helm Chart

- **Dashboard LAPI integration**: Configure connections to CrowdSec LAPI servers for dashboard features:
  - View active decisions from LAPI
  - Create manual IP bans from the dashboard
  - Auto-configure local LAPI connection using first bouncer and machine credentials (`lapiServers.autoConfigureLocal`)

## [0.1.2] - 2025-01-15

### Added

#### Helm Chart

- **Pre-registered machines**: Configure machines (agents/watchers) with credentials that are automatically registered when CrowdSec LAPI starts via a postStart lifecycle hook

## [0.1.1] - 2025-01-15

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

## [0.1.0] - 2025-01-14

- Initial release of CrowdSieve
