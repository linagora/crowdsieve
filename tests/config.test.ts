import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { loadFiltersFromDirectory, loadConfig } from '../src/config/index.js';

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
