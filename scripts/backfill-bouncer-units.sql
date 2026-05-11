-- One-shot backfill for the dropped_items / processed_items unit-mixing bug.
--
-- Background: prior to the fix in src/metrics/parse.ts, sumItemsByName summed
-- every item named 'dropped' (or 'processed') regardless of its `unit`, so the
-- column accumulated bytes + packets + requests together. Bytes dwarfed
-- everything by ~5 orders of magnitude on firewall bouncers.
--
-- This script re-derives both columns from `metrics_json`, applying the same
-- filter as the runtime parser: `unit === 'byte'` is excluded for these
-- countable counters; missing/other units are kept.
--
-- Idempotent — rows where both columns already hold the correct values are
-- skipped, so running twice yields zero updates the second time. Wrapped in
-- a transaction so a partial failure leaves the DB untouched.
--
-- Run inside the prod container:
--   sqlite3 /app/data/crowdsieve.db < /path/to/backfill-bouncer-units.sql
--
-- Or via a throwaway container mounted on the same volume — see README.

BEGIN IMMEDIATE;

UPDATE bouncer_metrics
SET dropped_items = COALESCE((
        SELECT SUM(CAST(json_extract(value, '$.value') AS INTEGER))
        FROM json_each(metrics_json)
        WHERE json_extract(value, '$.name') = 'dropped'
          AND IFNULL(json_extract(value, '$.unit'), '') != 'byte'
      ), 0),
    processed_items = COALESCE((
        SELECT SUM(CAST(json_extract(value, '$.value') AS INTEGER))
        FROM json_each(metrics_json)
        WHERE json_extract(value, '$.name') = 'processed'
          AND IFNULL(json_extract(value, '$.unit'), '') != 'byte'
      ), 0)
WHERE metrics_json != '[]'
  AND (
    dropped_items IS NOT COALESCE((
        SELECT SUM(CAST(json_extract(value, '$.value') AS INTEGER))
        FROM json_each(metrics_json)
        WHERE json_extract(value, '$.name') = 'dropped'
          AND IFNULL(json_extract(value, '$.unit'), '') != 'byte'
      ), 0)
    OR
    processed_items IS NOT COALESCE((
        SELECT SUM(CAST(json_extract(value, '$.value') AS INTEGER))
        FROM json_each(metrics_json)
        WHERE json_extract(value, '$.name') = 'processed'
          AND IFNULL(json_extract(value, '$.unit'), '') != 'byte'
      ), 0)
  );

COMMIT;

SELECT 'remediation totals after backfill:' AS label,
       SUM(dropped_items)   AS dropped_items_total,
       SUM(processed_items) AS processed_items_total
FROM bouncer_metrics
WHERE component_kind = 'remediation'
  AND metrics_json != '[]';
