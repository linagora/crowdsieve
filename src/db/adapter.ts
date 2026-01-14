/**
 * Database adapter interface to normalize differences between SQLite and PostgreSQL.
 *
 * SQLite (better-sqlite3) uses synchronous methods:
 * - .get() returns single row or undefined
 * - .all() returns array of rows
 * - .run() returns { changes: number }
 *
 * PostgreSQL (node-postgres) uses async methods:
 * - Always returns array, take [0] for single row
 * - Returns { rowCount: number } for mutations
 */

export type DatabaseType = 'sqlite' | 'postgres';

export interface MutationResult {
  changes: number;
}

export interface DatabaseAdapter {
  readonly type: DatabaseType;

  /**
   * Close the database connection
   */
  close(): Promise<void>;
}

// Global adapter instance
let currentAdapter: DatabaseAdapter | null = null;

export function setAdapter(adapter: DatabaseAdapter): void {
  currentAdapter = adapter;
}

export function getAdapter(): DatabaseAdapter {
  if (!currentAdapter) {
    throw new Error('Database adapter not initialized. Call initializeDatabase() first.');
  }
  return currentAdapter;
}

export function getDatabaseType(): DatabaseType {
  return getAdapter().type;
}
