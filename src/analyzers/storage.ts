import { eq, desc } from 'drizzle-orm';
import { getDatabaseContext } from '../db/index.js';
import type { AnalyzerRunResult } from './index.js';

export interface AnalyzerStorage {
  storeAnalyzerRun(run: AnalyzerRunResult): Promise<number>;
  getAnalyzerRuns(analyzerId: string, limit?: number): Promise<AnalyzerRunResult[]>;
  getLatestRun(analyzerId: string): Promise<AnalyzerRunResult | null>;
}

export function createAnalyzerStorage(): AnalyzerStorage {
  return {
    async storeAnalyzerRun(run) {
      const { db, schema, isPostgres } = getDatabaseContext();

      const insertQuery = db
        .insert(schema.analyzerRuns)
        .values({
          analyzerId: run.analyzerId,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          status: run.status,
          logsFetched: run.logsFetched,
          alertsGenerated: run.alertsGenerated,
          decisionsPushed: run.decisionsPushed,
          errorMessage: run.errorMessage,
          resultsJson: JSON.stringify(run.results),
          pushResultsJson: JSON.stringify(run.pushResults),
        } as typeof schema.analyzerRuns.$inferInsert)
        .returning({ id: schema.analyzerRuns.id });

      let result: { id: number } | undefined;
      if (isPostgres) {
        const rows = await insertQuery;
        result = rows[0];
      } else {
        result = (insertQuery as unknown as { get(): { id: number } | undefined }).get();
      }

      if (!result || typeof result.id !== 'number') {
        throw new Error('Failed to insert analyzer run: no run ID returned from database');
      }
      const runId = result.id;

      // Store individual results
      // Note: decisionPushed is set to true if at least one LAPI server successfully received the decisions
      const anyPushSucceeded = run.pushResults.some((pr) => pr.success);

      for (const detection of run.results) {
        const resultInsert = db.insert(schema.analyzerResults).values({
          runId,
          sourceIp: detection.groupValue,
          distinctCount: detection.distinctCount,
          totalCount: detection.totalCount,
          firstSeen: detection.firstSeen,
          lastSeen: detection.lastSeen,
          decisionPushed: anyPushSucceeded,
        } as typeof schema.analyzerResults.$inferInsert);

        if (isPostgres) {
          await resultInsert;
        } else {
          (resultInsert as unknown as { run(): void }).run();
        }
      }

      return runId;
    },

    async getAnalyzerRuns(analyzerId, limit = 10) {
      const { db, schema, isPostgres } = getDatabaseContext();

      const query = db
        .select()
        .from(schema.analyzerRuns)
        .where(eq(schema.analyzerRuns.analyzerId, analyzerId))
        .orderBy(desc(schema.analyzerRuns.startedAt))
        .limit(limit);

      let rows: (typeof schema.analyzerRuns.$inferSelect)[];
      if (isPostgres) {
        rows = await query;
      } else {
        rows = (query as unknown as { all(): typeof rows }).all();
      }

      return rows.map((row) => {
        let results = [];
        let pushResults = [];

        try {
          results = row.resultsJson ? JSON.parse(row.resultsJson) : [];
        } catch {
          // Corrupted JSON, return empty array
        }

        try {
          pushResults = row.pushResultsJson ? JSON.parse(row.pushResultsJson) : [];
        } catch {
          // Corrupted JSON, return empty array
        }

        return {
          analyzerId: row.analyzerId,
          startedAt: row.startedAt,
          completedAt: row.completedAt || '',
          status: row.status as 'success' | 'error',
          logsFetched: row.logsFetched || 0,
          alertsGenerated: row.alertsGenerated || 0,
          decisionsPushed: row.decisionsPushed || 0,
          errorMessage: row.errorMessage || undefined,
          results,
          pushResults,
        };
      });
    },

    async getLatestRun(analyzerId) {
      const runs = await this.getAnalyzerRuns(analyzerId, 1);
      return runs[0] || null;
    },
  };
}
