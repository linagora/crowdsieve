import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { is, Table, getTableName, getTableColumns } from 'drizzle-orm';
import * as sqliteSchema from '../src/db/schema.js';
import * as pgSchema from '../src/db/schema.postgres.js';

/**
 * Drift guard for scripts/migrate-sqlite-to-postgres.js.
 *
 * The migration script hand-writes the target DDL and the column lists it
 * copies. It is easy to add a table or a column to the Drizzle schema and
 * forget to teach the migration about it (this exact thing happened: the
 * `analyzer_*` / `bouncer*` tables and the `replicated` / `local_audit` /
 * `actor` columns were all missing). These tests derive the expected set of
 * tables and columns straight from the schema definitions, so any future
 * addition to the schema fails here until the migration script is updated.
 */

const here = dirname(fileURLToPath(import.meta.url));
const scriptSrc = readFileSync(join(here, '../scripts/migrate-sqlite-to-postgres.js'), 'utf8');

/** Map of SQL table name -> { columns: SQL column names } for a drizzle schema module. */
function tablesOf(schema: Record<string, unknown>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const value of Object.values(schema)) {
    if (is(value, Table)) {
      const columns = Object.values(getTableColumns(value)).map((c) => c.name);
      out.set(getTableName(value), columns);
    }
  }
  return out;
}

const sqliteTables = tablesOf(sqliteSchema as Record<string, unknown>);
const pgTables = tablesOf(pgSchema as Record<string, unknown>);

/** Slice of the script from one CREATE TABLE up to the next (DDL + its indexes). */
function createBlock(table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table}`;
  const start = scriptSrc.indexOf(marker);
  if (start === -1) return '';
  const next = scriptSrc.indexOf('CREATE TABLE IF NOT EXISTS', start + marker.length);
  return scriptSrc.slice(start, next === -1 ? undefined : next);
}

/** Column names listed in the `INSERT INTO <table> (...)` statement of the script. */
function insertColumns(table: string): string[] {
  const m = scriptSrc.match(new RegExp(`INSERT INTO ${table} \\(([^)]+)\\)`));
  if (!m) return [];
  return m[1]
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

describe('migrate-sqlite-to-postgres script coverage', () => {
  it('discovers all tables from the schema (sanity)', () => {
    // If this drops to a tiny number the schema import broke and the rest of
    // the suite would pass vacuously.
    expect(pgTables.size).toBeGreaterThanOrEqual(8);
  });

  // Source of truth = the PostgreSQL schema, since that is what the script creates.
  for (const [table, columns] of pgTables) {
    describe(`table "${table}"`, () => {
      it('is created by the migration script', () => {
        expect(scriptSrc).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      });

      it('has every schema column in its CREATE TABLE statement', () => {
        const block = createBlock(table);
        const missing = columns.filter((col) => !new RegExp(`\\b${col}\\b`).test(block));
        expect(missing, `columns missing from CREATE TABLE ${table}`).toEqual([]);
      });

      it('copies every schema column (except the auto id) in its INSERT', () => {
        const inserted = new Set(insertColumns(table));
        expect(inserted.size, `no INSERT INTO ${table} found`).toBeGreaterThan(0);
        const missing = columns.filter((col) => col !== 'id' && !inserted.has(col));
        expect(missing, `columns not copied by INSERT INTO ${table}`).toEqual([]);
      });
    });
  }
});

describe('SQLite and PostgreSQL schemas stay in sync', () => {
  it('define the same set of tables', () => {
    expect([...pgTables.keys()].sort()).toEqual([...sqliteTables.keys()].sort());
  });

  for (const [table, columns] of sqliteTables) {
    it(`table "${table}" has the same columns in both schemas`, () => {
      const pgColumns = pgTables.get(table);
      expect(pgColumns, `table ${table} missing from PostgreSQL schema`).toBeDefined();
      expect([...(pgColumns ?? [])].sort()).toEqual([...columns].sort());
    });
  }
});
