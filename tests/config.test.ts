import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { loadFiltersFromDirectory } from '../src/config/index.js';

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
type: no-decision
enabled: true
description: "Block alerts without decisions"
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(1);
    expect(result.filters[0]).toEqual({
      name: 'no-decision',
      type: 'no-decision',
      enabled: true,
      description: 'Block alerts without decisions',
    });
    expect(result.errors).toEqual([]);
  });

  it('should load multiple filter files in alphabetical order', () => {
    writeFileSync(
      join(TEST_DIR, '20-scenario.yaml'),
      `name: scenario-filter
type: scenario
enabled: true
patterns:
  - "crowdsecurity/*"
match_mode: glob
`
    );

    writeFileSync(
      join(TEST_DIR, '10-simulated.yaml'),
      `name: simulated
type: simulated
enabled: true
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
type: no-decision
enabled: true
`
    );

    writeFileSync(
      join(TEST_DIR, 'active.yaml'),
      `name: active
type: simulated
enabled: true
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
type: no-decision
enabled: true
`
    );

    writeFileSync(
      join(TEST_DIR, 'visible.yaml'),
      `name: visible
type: simulated
enabled: true
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
type: no-decision
enabled: true
`
    );

    writeFileSync(
      join(TEST_DIR, 'filter2.yml'),
      `name: filter2
type: simulated
enabled: true
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(2);
  });

  it('should report errors for invalid YAML files', () => {
    writeFileSync(
      join(TEST_DIR, 'invalid.yaml'),
      `name: invalid
type: unknown-type
enabled: true
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe('invalid.yaml');
    expect(result.errors[0].error).toContain('Invalid discriminator');
  });

  it('should report errors for malformed YAML', () => {
    writeFileSync(join(TEST_DIR, 'malformed.yaml'), `this is not: valid: yaml: content`);

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe('malformed.yaml');
  });

  it('should load source-ip filter correctly', () => {
    writeFileSync(
      join(TEST_DIR, 'ip-filter.yaml'),
      `name: internal-ips
type: source-ip
enabled: true
mode: blocklist
cidrs:
  - "10.0.0.0/8"
  - "192.168.0.0/16"
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(1);
    expect(result.filters[0]).toMatchObject({
      name: 'internal-ips',
      type: 'source-ip',
      mode: 'blocklist',
      cidrs: ['10.0.0.0/8', '192.168.0.0/16'],
    });
  });

  it('should load source-country filter correctly', () => {
    writeFileSync(
      join(TEST_DIR, 'country-filter.yaml'),
      `name: block-countries
type: source-country
enabled: true
mode: blocklist
countries:
  - "CN"
  - "RU"
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(1);
    expect(result.filters[0]).toMatchObject({
      name: 'block-countries',
      type: 'source-country',
      mode: 'blocklist',
      countries: ['CN', 'RU'],
    });
  });

  it('should continue loading after encountering errors', () => {
    writeFileSync(
      join(TEST_DIR, '01-valid.yaml'),
      `name: valid
type: no-decision
enabled: true
`
    );

    writeFileSync(
      join(TEST_DIR, '02-invalid.yaml'),
      `name: invalid
type: unknown
`
    );

    writeFileSync(
      join(TEST_DIR, '03-also-valid.yaml'),
      `name: also-valid
type: simulated
enabled: true
`
    );

    const result = loadFiltersFromDirectory(TEST_DIR);

    expect(result.filters).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.filters[0].name).toBe('valid');
    expect(result.filters[1].name).toBe('also-valid');
  });
});
