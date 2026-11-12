import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { loadFiltersFromDirectory, loadConfig, loadConfigFromEnv } from '../src/config/index.js';

const TEST_DIR = join(process.cwd(), 'tests', 'fixtures', 'filters.d');

describe('loadFiltersFromDirectory', () => {
  beforeEach(() => {
    // Clean up and create test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('should return empty array for non-existent directory', () => {
    const result = loadFiltersFromDirectory('/nonexistent/path');
    expect(result.filters).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('should load valid YAML filter files', () => {
    writeFileSync(
      join(TEST_DIR, '00-no-decision.yaml'),
      `name: no-decision
enabled: true
description: "Block alerts without decisions"
filter:
  field: decisions
  op: empty
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(1);
    expect(result.filters[0]).toMatchObject({
      name: 'no-decision',
      enabled: true,
      description: 'Block alerts without decisions',
      filter: { field: 'decisions', op: 'empty' },
    });
    expect(result.errors).toEqual([]);
  });

  it('should load multiple filter files in alphabetical order', () => {
    writeFileSync(
      join(TEST_DIR, '20-scenario.yaml'),
      `name: scenario-filter
enabled: true
filter:
  field: scenario
  op: glob
  value: "crowdsecurity/*"
`
    );

    writeFileSync(
      join(TEST_DIR, '10-simulated.yaml'),
      `name: simulated
enabled: true
filter:
  field: simulated
  op: eq
  value: true
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(2);
    expect(result.filters[0].name).toBe('simulated'); // 10- comes before 20-
    expect(result.filters[1].name).toBe('scenario-filter');
    expect(result.errors).toEqual([]);
  });

  it('should ignore files starting with underscore', () => {
    writeFileSync(
      join(TEST_DIR, '_disabled.yaml'),
      `name: disabled
enabled: true
filter:
  field: decisions
  op: empty
`
    );

    writeFileSync(
      join(TEST_DIR, 'active.yaml'),
      `name: active
enabled: true
filter:
  field: simulated
  op: eq
  value: true
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].name).toBe('active');
  });

  it('should ignore files starting with dot', () => {
    writeFileSync(
      join(TEST_DIR, '.hidden.yaml'),
      `name: hidden
enabled: true
filter:
  field: decisions
  op: empty
`
    );

    writeFileSync(
      join(TEST_DIR, 'visible.yaml'),
      `name: visible
enabled: true
filter:
  field: simulated
  op: eq
  value: true
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].name).toBe('visible');
  });

  it('should load both .yaml and .yml files', () => {
    writeFileSync(
      join(TEST_DIR, 'filter1.yaml'),
      `name: filter1
enabled: true
filter:
  field: decisions
  op: empty
`
    );

    writeFileSync(
      join(TEST_DIR, 'filter2.yml'),
      `name: filter2
enabled: true
filter:
  field: simulated
  op: eq
  value: true
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(2);
  });

  it('should report errors for invalid YAML files', () => {
    writeFileSync(
      join(TEST_DIR, 'invalid.yaml'),
      `name: invalid
enabled: true
filter:
  field: test
  op: unknown-operator
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe('invalid.yaml');
  });

  it('should report errors for malformed YAML', () => {
    writeFileSync(join(TEST_DIR, 'malformed.yaml'), `this is not: valid: yaml: content`);

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe('malformed.yaml');
  });

  it('should load cidr filter correctly', () => {
    writeFileSync(
      join(TEST_DIR, 'ip-filter.yaml'),
      `name: internal-ips
enabled: true
filter:
  field: source.ip
  op: cidr
  value:
    - "10.0.0.0/8"
    - "192.168.0.0/16"
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(1);
    expect(result.filters[0]).toMatchObject({
      name: 'internal-ips',
      filter: {
        field: 'source.ip',
        op: 'cidr',
        value: ['10.0.0.0/8', '192.168.0.0/16'],
      },
    });
  });

  it('should load country filter correctly', () => {
    writeFileSync(
      join(TEST_DIR, 'country-filter.yaml'),
      `name: block-countries
enabled: true
filter:
  field: source.cn
  op: in
  value:
    - "CN"
    - "RU"
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(1);
    expect(result.filters[0]).toMatchObject({
      name: 'block-countries',
      filter: {
        field: 'source.cn',
        op: 'in',
        value: ['CN', 'RU'],
      },
    });
  });

  it('should continue loading after encountering errors', () => {
    writeFileSync(
      join(TEST_DIR, '01-valid.yaml'),
      `name: valid
enabled: true
filter:
  field: decisions
  op: empty
`
    );

    writeFileSync(
      join(TEST_DIR, '02-invalid.yaml'),
      `name: invalid
filter:
  invalid: structure
`
    );

    writeFileSync(
      join(TEST_DIR, '03-also-valid.yaml'),
      `name: also-valid
enabled: true
filter:
  field: simulated
  op: eq
  value: true
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.filters[0].name).toBe('valid');
    expect(result.filters[1].name).toBe('also-valid');
  });

  it('should load complex filter with logical operators', () => {
    writeFileSync(
      join(TEST_DIR, 'complex.yaml'),
      `name: complex-filter
enabled: true
filter:
  op: and
  conditions:
    - field: simulated
      op: eq
      value: false
    - op: or
      conditions:
        - field: scenario
          op: contains
          value: "ssh"
        - field: source.ip
          op: cidr
          value:
            - "192.168.0.0/16"
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].name).toBe('complex-filter');
    expect(result.filters[0].filter).toHaveProperty('op', 'and');
  });
});

const CONFIG_DIR = join(process.cwd(), 'tests', 'fixtures', 'config');

describe('loadConfig with environment variable interpolation', () => {
  beforeEach(() => {
    if (existsSync(CONFIG_DIR)) {
      rmSync(CONFIG_DIR, { recursive: true });
    }
    mkdirSync(CONFIG_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(CONFIG_DIR)) {
      rmSync(CONFIG_DIR, { recursive: true });
    }
    // Clean up env vars
    delete process.env.TEST_LAPI_PASSWORD;
    delete process.env.TEST_LAPI_API_KEY;
    delete process.env.TEST_MACHINE_ID;
  });

  it('should interpolate environment variables in config', () => {
    process.env.TEST_LAPI_PASSWORD = 'secret-password-123';
    process.env.TEST_LAPI_API_KEY = 'api-key-456';

    const configPath = join(CONFIG_DIR, 'config.yaml');
    writeFileSync(
      configPath,
      `proxy:
  listen_port: 8080
  capi_url: https://api.crowdsec.net

storage:
  path: ./data/test.db

lapi_servers:
  - name: test-server
    url: http://localhost:8081
    api_key: "\${TEST_LAPI_API_KEY}"
    machine_id: test-machine
    password: "\${TEST_LAPI_PASSWORD}"
`
    );

    const config = loadConfig(configPath);

    expect(config.lapi_servers).toHaveLength(1);
    expect(config.lapi_servers[0].api_key).toBe('api-key-456');
    expect(config.lapi_servers[0].password).toBe('secret-password-123');
  });

  it('should use default value when env var is not set', () => {
    const configPath = join(CONFIG_DIR, 'config.yaml');
    writeFileSync(
      configPath,
      `proxy:
  listen_port: 8080
  capi_url: https://api.crowdsec.net

storage:
  path: ./data/test.db

lapi_servers:
  - name: test-server
    url: http://localhost:8081
    api_key: "\${MISSING_VAR:-default-api-key}"
    machine_id: "\${MISSING_ID:-default-machine}"
`
    );

    const config = loadConfig(configPath);

    expect(config.lapi_servers).toHaveLength(1);
    expect(config.lapi_servers[0].api_key).toBe('default-api-key');
    expect(config.lapi_servers[0].machine_id).toBe('default-machine');
  });

  it('should prefer env var over default value', () => {
    process.env.TEST_MACHINE_ID = 'from-env';

    const configPath = join(CONFIG_DIR, 'config.yaml');
    writeFileSync(
      configPath,
      `proxy:
  listen_port: 8080
  capi_url: https://api.crowdsec.net

storage:
  path: ./data/test.db

lapi_servers:
  - name: test-server
    url: http://localhost:8081
    api_key: test-key
    machine_id: "\${TEST_MACHINE_ID:-default-machine}"
`
    );

    const config = loadConfig(configPath);

    expect(config.lapi_servers[0].machine_id).toBe('from-env');
  });

  it('should return empty string for missing env var without default', () => {
    const configPath = join(CONFIG_DIR, 'config.yaml');
    writeFileSync(
      configPath,
      `proxy:
  listen_port: 8080
  capi_url: https://api.crowdsec.net

storage:
  path: "\${MISSING_PATH:-./data/fallback.db}"
`
    );

    const config = loadConfig(configPath);
    // With default syntax, should use fallback value
    expect(config.storage.path).toBe('./data/fallback.db');
  });
});

describe('loadConfigFromEnv numeric validation', () => {
  // POSTGRES_HOST enables the PostgreSQL block, which holds two of the nine variables.
  const ENV_VARS = [
    'PROXY_PORT',
    'PROXY_TIMEOUT_MS',
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'POSTGRES_POOL_SIZE',
    'RETENTION_DAYS',
    'CLIENT_VALIDATION_CACHE_TTL',
    'CLIENT_VALIDATION_CACHE_TTL_ERROR',
    'CLIENT_VALIDATION_TIMEOUT_MS',
    'CLIENT_VALIDATION_MAX_MEMORY_ENTRIES',
  ];
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of ENV_VARS) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    savedEnv.clear();
  });

  it('should keep the defaults when the variables are unset', () => {
    const config = loadConfigFromEnv();

    expect(config.proxy?.listen_port).toBe(8080);
    expect(config.proxy?.timeout_ms).toBe(30000);
    expect(config.storage?.retention_days).toBe(30);
    expect(config.storage?.postgres).toBeUndefined();
    expect(config.client_validation).toEqual({
      enabled: false,
      cache_ttl_seconds: 604800,
      cache_ttl_error_seconds: 3600,
      validation_timeout_ms: 5000,
      max_memory_entries: 1000,
      fail_closed: false,
    });
  });

  it('should parse valid numeric values', () => {
    process.env.PROXY_PORT = '9090';
    process.env.PROXY_TIMEOUT_MS = '1500';
    process.env.POSTGRES_HOST = 'localhost';
    process.env.POSTGRES_PORT = '6543';
    process.env.POSTGRES_POOL_SIZE = '20';
    process.env.RETENTION_DAYS = '0';
    process.env.CLIENT_VALIDATION_CACHE_TTL = '60';
    process.env.CLIENT_VALIDATION_CACHE_TTL_ERROR = '30';
    process.env.CLIENT_VALIDATION_TIMEOUT_MS = '250';
    process.env.CLIENT_VALIDATION_MAX_MEMORY_ENTRIES = '500';

    const config = loadConfigFromEnv();

    expect(config.proxy?.listen_port).toBe(9090);
    expect(config.proxy?.timeout_ms).toBe(1500);
    expect(config.storage?.postgres?.port).toBe(6543);
    expect(config.storage?.postgres?.pool_size).toBe(20);
    expect(config.storage?.retention_days).toBe(0);
    expect(config.client_validation?.cache_ttl_seconds).toBe(60);
    expect(config.client_validation?.cache_ttl_error_seconds).toBe(30);
    expect(config.client_validation?.validation_timeout_ms).toBe(250);
    expect(config.client_validation?.max_memory_entries).toBe(500);
  });

  it.each([
    ['PROXY_PORT', 'abc'],
    ['PROXY_PORT', '30s'],
    ['PROXY_PORT', ''],
    ['PROXY_PORT', '-1'],
    ['PROXY_PORT', '0'],
    ['PROXY_PORT', '65536'],
    ['PROXY_PORT', '1.5'],
    ['PROXY_TIMEOUT_MS', 'abc'],
    ['PROXY_TIMEOUT_MS', '0'],
    ['POSTGRES_PORT', 'abc'],
    ['POSTGRES_PORT', '65536'],
    ['POSTGRES_POOL_SIZE', '0'],
    ['RETENTION_DAYS', 'abc'],
    ['RETENTION_DAYS', '-1'],
    ['CLIENT_VALIDATION_CACHE_TTL', '30s'],
    ['CLIENT_VALIDATION_CACHE_TTL', '0'],
    ['CLIENT_VALIDATION_CACHE_TTL_ERROR', ''],
    ['CLIENT_VALIDATION_TIMEOUT_MS', 'abc'],
    ['CLIENT_VALIDATION_MAX_MEMORY_ENTRIES', '0'],
  ])('should reject %s=%j with an explicit error', (name, value) => {
    if (name.startsWith('POSTGRES_')) {
      process.env.POSTGRES_HOST = 'localhost';
    }
    process.env[name] = value;

    expect(() => loadConfigFromEnv()).toThrowError(new RegExp(`${name}.*"${value}"`));
  });
});
