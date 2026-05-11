/**
 * One-shot backfill script: recomputes `dropped_items` and `processed_items`
 * in the `bouncer_metrics` table using the corrected unit filter introduced to
 * fix the byte-inflation bug.
 *
 * Background
 * ----------
 * CrowdSec firewall bouncers emit `dropped` and `processed` metrics in three
 * units under the same name:
 *   - "byte"    – bandwidth (huge numbers, e.g. 24 million for 2 days)
 *   - "packet"  – packets dropped/processed
 *   - "request" – HTTP requests (for HTTP bouncers)
 *
 * The original parser summed all three, so `dropped_items` was dominated by
 * the byte value. This script reparses the stored `metrics_json` for every row,
 * excludes byte-unit items, and writes the corrected counters back.
 *
 * Usage
 * -----
 *   npx tsx scripts/backfillBouncerMetricsUnits.ts [--db <path>] [--dry-run]
 *
 * Flags
 * -----
 *   --db <path>   Path to the SQLite database file.
 *                 Defaults to ./data/crowdsieve.db
 *   --dry-run     Print what would change without writing to the DB.
 *
 * Idempotency
 * -----------
 * The script compares the recomputed values to the stored ones and only issues
 * UPDATE statements for rows where the values actually differ. Re-running it
 * after a successful first pass is a no-op (0 rows updated).
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const dryRun = args.includes('--dry-run');
const dbPath = path.resolve(getFlag('--db') ?? './data/crowdsieve.db');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MetricsItem {
  name?: string;
  value?: number | string;
  unit?: string;
  labels?: Record<string, unknown>;
  timestamp?: number | string;
}

interface DbRow {
  id: number;
  dropped_items: number | null;
  processed_items: number | null;
  metrics_json: string;
}

// ---------------------------------------------------------------------------
// Core logic (mirrors sumItemsByName in src/metrics/parse.ts)
// ---------------------------------------------------------------------------

function recomputeFromItems(items: MetricsItem[]): {
  droppedItems: number;
  processedItems: number;
} {
  let droppedItems = 0;
  let processedItems = 0;

  for (const item of items) {
    if (!item || typeof item.name !== 'string') continue;
    const value = typeof item.value === 'number' ? item.value : Number(item.value);
    if (!Number.isFinite(value)) continue;

    if (item.name === 'dropped') {
      // Skip byte-unit items — they represent bandwidth, not countable events.
      if (item.unit === 'byte') continue;
      droppedItems += value;
    } else if (item.name === 'processed') {
      if (item.unit === 'byte') continue;
      processedItems += value;
    }
  }

  return { droppedItems, processedItems };
}

function parseMetricsJson(raw: string): MetricsItem[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as MetricsItem[];
  } catch {
    // malformed JSON — treat as empty
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

console.log(`Opening database: ${dbPath}`);
if (dryRun) console.log('DRY RUN — no changes will be written.');

const db = new Database(dbPath, { readonly: dryRun });
db.pragma('journal_mode = WAL');

const rows = db
  .prepare(
    `SELECT id, dropped_items, processed_items, metrics_json
     FROM bouncer_metrics
     WHERE metrics_json != '[]'`
  )
  .all() as DbRow[];

console.log(`Rows to examine: ${rows.length}`);

let updated = 0;
let skipped = 0;
let beforeDropped = 0;
let afterDropped = 0;
let beforeProcessed = 0;
let afterProcessed = 0;

const updateStmt = dryRun
  ? null
  : db.prepare('UPDATE bouncer_metrics SET dropped_items = ?, processed_items = ? WHERE id = ?');

const doUpdate = db.transaction((rows: DbRow[]) => {
  for (const row of rows) {
    const items = parseMetricsJson(row.metrics_json);
    const { droppedItems, processedItems } = recomputeFromItems(items);

    const storedDropped = row.dropped_items ?? 0;
    const storedProcessed = row.processed_items ?? 0;

    const needsUpdate = storedDropped !== droppedItems || storedProcessed !== processedItems;

    beforeDropped += storedDropped;
    beforeProcessed += storedProcessed;
    afterDropped += droppedItems;
    afterProcessed += processedItems;

    if (!needsUpdate) {
      skipped++;
      continue;
    }

    if (!dryRun && updateStmt) {
      updateStmt.run(droppedItems, processedItems, row.id);
    } else {
      console.log(
        `  [DRY RUN] id=${row.id}: dropped ${storedDropped} → ${droppedItems}, processed ${storedProcessed} → ${processedItems}`
      );
    }
    updated++;
  }
});

doUpdate(rows);

console.log('\n--- Summary ---');
console.log(`Total rows examined : ${rows.length}`);
console.log(`Rows updated        : ${updated}`);
console.log(`Rows unchanged      : ${skipped}`);
console.log(`dropped_items  before: ${beforeDropped.toLocaleString()}`);
console.log(`dropped_items  after : ${afterDropped.toLocaleString()}`);
console.log(`processed_items before: ${beforeProcessed.toLocaleString()}`);
console.log(`processed_items after : ${afterProcessed.toLocaleString()}`);

if (!dryRun) {
  db.close();
  console.log('\nDone.');
} else {
  db.close();
  console.log('\nDry run complete — database unchanged.');
}
