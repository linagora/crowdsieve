import type { Logger } from 'pino';
import type { Config, LapiServer } from '../config/index.js';
import {
  loadAnalyzersFromDirectory,
  parseDuration,
  resolveSource,
  type AnalyzerConfig,
  type AnalyzersGlobalConfig,
  type Source,
} from './config.js';
import { fetchLogs } from './sources/loki.js';
import { analyze, type DetectionResult } from './detection.js';
import { pushDecisions, type PushResult } from './pusher.js';

export interface AnalyzerRunResult {
  analyzerId: string;
  startedAt: string;
  completedAt: string;
  status: 'success' | 'error';
  logsFetched: number;
  alertsGenerated: number;
  decisionsPushed: number;
  results: DetectionResult[];
  pushResults: PushResult[];
  errorMessage?: string;
}

export interface AnalyzerStatus {
  id: string;
  name: string;
  enabled: boolean;
  lastRun?: AnalyzerRunResult;
  nextRun?: string;
  intervalMs: number;
}

type AnalyzerStorage = {
  storeAnalyzerRun: (run: AnalyzerRunResult) => Promise<number>;
  getAnalyzerRuns: (analyzerId: string, limit?: number) => Promise<AnalyzerRunResult[]>;
};

export class AnalyzerEngine {
  private analyzers: AnalyzerConfig[] = [];
  private sources: Record<string, Source> = {};
  private globalConfig: AnalyzersGlobalConfig;
  private lapiServers: LapiServer[];
  private timeoutMs: number;
  private logger: Logger;
  private storage?: AnalyzerStorage;
  private schedulers: Map<string, NodeJS.Timeout> = new Map();
  private lastRuns: Map<string, AnalyzerRunResult> = new Map();
  private nextRuns: Map<string, Date> = new Map();

  constructor(
    config: Config,
    logger: Logger,
    storage?: AnalyzerStorage
  ) {
    this.globalConfig = config.analyzers as AnalyzersGlobalConfig;
    this.sources = this.globalConfig.sources || {};
    this.lapiServers = config.lapi_servers || [];
    this.timeoutMs = config.proxy.timeout_ms;
    this.logger = logger;
    this.storage = storage;
  }

  /**
   * Initialize the analyzer engine
   * Loads analyzer configs and starts schedulers
   */
  async initialize(): Promise<void> {
    if (!this.globalConfig.enabled) {
      this.logger.info('Analyzer engine is disabled');
      return;
    }

    // Load analyzer configurations
    const configDir = this.globalConfig.config_dir;
    const { analyzers, errors } = loadAnalyzersFromDirectory(configDir);

    for (const { file, error } of errors) {
      this.logger.warn({ file, error }, 'Failed to load analyzer config');
    }

    this.analyzers = analyzers.filter((a) => a.enabled);
    this.logger.info(
      {
        total: analyzers.length,
        enabled: this.analyzers.length,
        configDir,
      },
      'Analyzer engine initialized'
    );

    // Start schedulers for each analyzer
    for (const analyzer of this.analyzers) {
      this.startScheduler(analyzer);
    }
  }

  /**
   * Start a scheduler for an analyzer
   */
  private startScheduler(analyzer: AnalyzerConfig): void {
    const intervalMs = parseDuration(analyzer.schedule.interval);

    // Schedule first run immediately, then at intervals
    const runAnalyzer = async () => {
      await this.runAnalyzer(analyzer);
      // Update next run time
      this.nextRuns.set(analyzer.id, new Date(Date.now() + intervalMs));
    };

    // Run immediately on startup
    runAnalyzer().catch((err) => {
      this.logger.error({ analyzer: analyzer.id, err }, 'Analyzer run failed');
    });

    // Then schedule recurring runs
    const timer = setInterval(() => {
      runAnalyzer().catch((err) => {
        this.logger.error({ analyzer: analyzer.id, err }, 'Analyzer run failed');
      });
    }, intervalMs);

    // Set initial next run time
    this.nextRuns.set(analyzer.id, new Date(Date.now() + intervalMs));

    // Unref to not block process exit
    if (timer.unref) {
      timer.unref();
    }

    this.schedulers.set(analyzer.id, timer);
    this.logger.info(
      { analyzer: analyzer.id, intervalMs },
      'Analyzer scheduler started'
    );
  }

  /**
   * Run a single analyzer
   */
  async runAnalyzer(analyzer: AnalyzerConfig): Promise<AnalyzerRunResult> {
    const startedAt = new Date().toISOString();
    this.logger.info({ analyzer: analyzer.id }, 'Starting analyzer run');

    try {
      // Resolve source
      const source = resolveSource(analyzer.source.ref, this.sources);
      if (!source) {
        throw new Error(`Source not found: ${analyzer.source.ref}`);
      }

      // Fetch logs
      const lookback = analyzer.schedule.lookback;
      const fetchResult = await fetchLogs(
        source,
        analyzer.source,
        analyzer.extraction,
        lookback,
        this.timeoutMs
      );

      if (fetchResult.error) {
        throw new Error(`Failed to fetch logs: ${fetchResult.error}`);
      }

      this.logger.info(
        { analyzer: analyzer.id, logs: fetchResult.logs.length },
        'Logs fetched'
      );

      // Analyze logs (with global whitelist)
      const whitelist = this.globalConfig.whitelist || [];
      const analysisResult = analyze(fetchResult.logs, analyzer.detection, whitelist);
      this.logger.info(
        {
          analyzer: analyzer.id,
          totalLogs: analysisResult.totalLogsAnalyzed,
          totalGroups: analysisResult.totalGroups,
          alerts: analysisResult.alertCount,
          whitelisted: analysisResult.whitelistedCount,
        },
        'Analysis completed'
      );

      // Push decisions if there are alerts
      let pushResults: PushResult[] = [];
      if (analysisResult.alerts.length > 0) {
        pushResults = await pushDecisions(
          analysisResult.alerts,
          analyzer.decision,
          analyzer.id,
          analyzer.version,
          analyzer.targets,
          this.lapiServers,
          this.timeoutMs,
          this.logger
        );

        const successCount = pushResults.filter((r) => r.success).length;
        this.logger.info(
          {
            analyzer: analyzer.id,
            alerts: analysisResult.alertCount,
            servers: pushResults.length,
            successful: successCount,
          },
          'Decisions pushed'
        );
      }

      const completedAt = new Date().toISOString();
      const totalPushed = pushResults.reduce(
        (sum, r) => sum + (r.success ? r.decisionsPushed : 0),
        0
      );

      const result: AnalyzerRunResult = {
        analyzerId: analyzer.id,
        startedAt,
        completedAt,
        status: 'success',
        logsFetched: fetchResult.logs.length,
        alertsGenerated: analysisResult.alertCount,
        decisionsPushed: totalPushed,
        results: analysisResult.alerts,
        pushResults,
      };

      // Store result
      this.lastRuns.set(analyzer.id, result);
      if (this.storage) {
        await this.storage.storeAnalyzerRun(result);
      }

      this.logger.info(
        {
          analyzer: analyzer.id,
          duration: Date.parse(completedAt) - Date.parse(startedAt),
          alerts: analysisResult.alertCount,
          pushed: totalPushed,
        },
        'Analyzer run completed'
      );

      return result;
    } catch (err) {
      const completedAt = new Date().toISOString();
      const errorMessage = err instanceof Error ? err.message : String(err);

      const result: AnalyzerRunResult = {
        analyzerId: analyzer.id,
        startedAt,
        completedAt,
        status: 'error',
        logsFetched: 0,
        alertsGenerated: 0,
        decisionsPushed: 0,
        results: [],
        pushResults: [],
        errorMessage,
      };

      // Store result
      this.lastRuns.set(analyzer.id, result);
      if (this.storage) {
        await this.storage.storeAnalyzerRun(result);
      }

      this.logger.error(
        { analyzer: analyzer.id, error: errorMessage },
        'Analyzer run failed'
      );

      return result;
    }
  }

  /**
   * Manually trigger an analyzer run
   */
  async triggerRun(analyzerId: string): Promise<AnalyzerRunResult | null> {
    const analyzer = this.analyzers.find((a) => a.id === analyzerId);
    if (!analyzer) {
      return null;
    }
    return this.runAnalyzer(analyzer);
  }

  /**
   * Get the status of all analyzers
   */
  getStatus(): AnalyzerStatus[] {
    return this.analyzers.map((analyzer) => ({
      id: analyzer.id,
      name: analyzer.name,
      enabled: analyzer.enabled,
      lastRun: this.lastRuns.get(analyzer.id),
      nextRun: this.nextRuns.get(analyzer.id)?.toISOString(),
      intervalMs: parseDuration(analyzer.schedule.interval),
    }));
  }

  /**
   * Get an analyzer by ID
   */
  getAnalyzer(id: string): AnalyzerConfig | undefined {
    return this.analyzers.find((a) => a.id === id);
  }

  /**
   * Get run history for an analyzer
   */
  async getRunHistory(analyzerId: string, limit: number = 10): Promise<AnalyzerRunResult[]> {
    if (this.storage) {
      return this.storage.getAnalyzerRuns(analyzerId, limit);
    }
    // Fallback to in-memory last run
    const lastRun = this.lastRuns.get(analyzerId);
    return lastRun ? [lastRun] : [];
  }

  /**
   * Stop all schedulers
   */
  stop(): void {
    for (const [id, timer] of this.schedulers) {
      clearInterval(timer);
      this.logger.debug({ analyzer: id }, 'Analyzer scheduler stopped');
    }
    this.schedulers.clear();
  }
}

// Singleton instance
let analyzerEngine: AnalyzerEngine | null = null;

/**
 * Initialize the global analyzer engine
 */
export function initializeAnalyzerEngine(
  config: Config,
  logger: Logger,
  storage?: AnalyzerStorage
): AnalyzerEngine {
  if (analyzerEngine) {
    analyzerEngine.stop();
  }
  analyzerEngine = new AnalyzerEngine(config, logger, storage);
  return analyzerEngine;
}

/**
 * Get the global analyzer engine instance
 */
export function getAnalyzerEngine(): AnalyzerEngine | null {
  return analyzerEngine;
}
