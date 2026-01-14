# PostgreSQL Setup for CrowdSieve

CrowdSieve supports PostgreSQL as an alternative to the default SQLite database. This guide explains how to configure and migrate to PostgreSQL.

## Prerequisites

- PostgreSQL 12 or later
- A PostgreSQL user with CREATE permissions (for automatic table creation) or a pre-configured database

## Quick Start

### 1. Install the PostgreSQL driver

The `pg` package is an optional dependency. Install it explicitly:

```bash
npm install pg
```

### 2. Configure environment variables

```bash
export STORAGE_TYPE=postgres
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_DATABASE=crowdsieve
export POSTGRES_USER=crowdsieve
export POSTGRES_PASSWORD=your-secure-password
```

### 3. Start CrowdSieve

CrowdSieve will automatically create the required tables if they don't exist.

## Configuration Options

| Variable | Description | Default |
|----------|-------------|---------|
| `STORAGE_TYPE` | Database backend (`sqlite` or `postgres`) | `sqlite` |
| `POSTGRES_HOST` | PostgreSQL server hostname | `localhost` |
| `POSTGRES_PORT` | PostgreSQL server port | `5432` |
| `POSTGRES_DATABASE` | Database name | - |
| `POSTGRES_USER` | Database user | - |
| `POSTGRES_PASSWORD` | Database password | - |
| `POSTGRES_SSL` | Enable SSL connection | `false` |
| `POSTGRES_SSL_REJECT_UNAUTHORIZED` | Reject self-signed certificates | `true` |
| `POSTGRES_POOL_SIZE` | Connection pool size | `10` |

> **Security note**: Set `POSTGRES_SSL_REJECT_UNAUTHORIZED=false` only when connecting to servers with self-signed certificates. This disables certificate validation and should not be used in production with untrusted networks.

## Manual Database Setup

If your PostgreSQL user doesn't have CREATE permissions, create the tables manually.

The following example uses the `psql` command-line client. If you're using a GUI tool (pgAdmin, DBeaver, etc.), create the database and then connect to it using your tool's interface before running the CREATE TABLE statements.

```sql
-- Create database
CREATE DATABASE crowdsieve;

-- Connect to the database (psql command - in GUI tools, use their connection dialog)
\c crowdsieve

-- Create alerts table
CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  uuid TEXT,
  machine_id TEXT,
  scenario TEXT NOT NULL,
  scenario_hash TEXT,
  scenario_version TEXT,
  message TEXT,
  events_count INTEGER,
  capacity INTEGER,
  leakspeed TEXT,
  start_at TEXT,
  stop_at TEXT,
  created_at TEXT,
  received_at TEXT NOT NULL,
  simulated BOOLEAN DEFAULT FALSE,
  remediation BOOLEAN DEFAULT FALSE,
  has_decisions BOOLEAN DEFAULT FALSE,
  source_scope TEXT,
  source_value TEXT,
  source_ip TEXT,
  source_range TEXT,
  source_as_number TEXT,
  source_as_name TEXT,
  source_cn TEXT,
  geo_country_code TEXT,
  geo_country_name TEXT,
  geo_city TEXT,
  geo_region TEXT,
  geo_latitude DOUBLE PRECISION,
  geo_longitude DOUBLE PRECISION,
  geo_timezone TEXT,
  geo_isp TEXT,
  geo_org TEXT,
  filtered BOOLEAN DEFAULT FALSE,
  filter_reasons TEXT,
  forwarded_to_capi BOOLEAN DEFAULT FALSE,
  forwarded_at TEXT,
  raw_json TEXT
);

CREATE INDEX idx_scenario ON alerts(scenario);
CREATE INDEX idx_source_ip ON alerts(source_ip);
CREATE INDEX idx_received_at ON alerts(received_at);
CREATE INDEX idx_country_code ON alerts(geo_country_code);
CREATE INDEX idx_filtered ON alerts(filtered);
CREATE INDEX idx_machine_id ON alerts(machine_id);

-- Create decisions table
CREATE TABLE IF NOT EXISTS decisions (
  id SERIAL PRIMARY KEY,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
  uuid TEXT,
  origin TEXT,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  value TEXT NOT NULL,
  duration TEXT,
  scenario TEXT,
  simulated BOOLEAN DEFAULT FALSE,
  until TEXT,
  created_at TEXT
);

CREATE INDEX idx_decision_alert ON decisions(alert_id);
CREATE INDEX idx_decision_value ON decisions(value);
CREATE INDEX idx_decision_type ON decisions(type);

-- Create events table
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
  timestamp TEXT,
  meta TEXT
);

CREATE INDEX idx_event_alert ON events(alert_id);

-- Create validated_clients table (for client validation feature)
CREATE TABLE IF NOT EXISTS validated_clients (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  machine_id TEXT,
  validated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  access_count INTEGER DEFAULT 1
);

CREATE INDEX idx_vc_expires_at ON validated_clients(expires_at);
```

## Migrating from SQLite to PostgreSQL

Use the included migration script to transfer data from SQLite to PostgreSQL:

```bash
# Set PostgreSQL environment variables first
export STORAGE_TYPE=postgres
export POSTGRES_HOST=localhost
export POSTGRES_DATABASE=crowdsieve
export POSTGRES_USER=crowdsieve
export POSTGRES_PASSWORD=your-secure-password

# Run migration
node scripts/migrate-sqlite-to-postgres.js ./data/crowdsieve.db
```

The script will:
1. Read all data from the SQLite database
2. Create tables in PostgreSQL if they don't exist
3. Transfer all alerts, decisions, and events
4. Preserve all timestamps and relationships

## Troubleshooting

### Error: "Permission denied to create table"

Your PostgreSQL user doesn't have CREATE permissions. Either:
1. Grant CREATE permission to the user
2. Create tables manually using the SQL above

### Error: "Cannot find module 'pg'"

Install the PostgreSQL driver:
```bash
npm install pg
```

### Connection refused

Check that:
- PostgreSQL is running
- The host and port are correct
- Firewall allows the connection
- `pg_hba.conf` allows connections from your host

### SSL connection required

Set `POSTGRES_SSL=true` in your environment.

## Performance Considerations

- PostgreSQL performs better than SQLite for concurrent writes
- Use connection pooling (`POSTGRES_POOL_SIZE`) for high-traffic deployments
- Consider adding additional indexes based on your query patterns
- Regular VACUUM ANALYZE helps maintain query performance
