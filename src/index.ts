import { randomBytes } from 'crypto';
import { dirname, join } from 'path';
import { createLogger } from './logging.js';
import { loadConfig, loadConfigFromEnv, loadFiltersFromDirectory, Config } from './config/index.js';
import { initializeDatabase, closeDatabase } from './db/index.js';
import { FilterEngine } from './filters/index.js';
import { createStorage } from './storage/index.js';
import { createProxyServer } from './proxy/server.js';
import { initGeoIP, lookupIP, closeGeoIP } from './geoip/index.js';
import { ClientValidator } from './validation/index.js';
import { initializeAnalyzerEngine, getAnalyzerEngine } from './analyzers/index.js';
import { createAnalyzerStorage } from './analyzers/storage.js';
import { createReplicationService, ReplicationService } from './replication/index.js';
import { createMetricsCollector, MetricsCollector } from './metrics/collector.js';

const CONFIG_PATH = process.env.CONFIG_PATH || './config/filters.yaml';
const GEOIP_DB_PATH = process.env.GEOIP_DB_PATH || './data/geoip-city.mmdb';

/**
 * Generate a secure random API key if not provided.
 * This ensures the dashboard API is always protected.
 */
function ensureDashboardApiKey(): { key: string; generated: boolean } {
  const existingKey = process.env.DASHBOARD_API_KEY;
  if (existingKey) {
    return { key: existingKey, generated: false };
  }

  // Generate a secure 32-byte random key (64 hex characters)
  const generatedKey = randomBytes(32).toString('hex');
  process.env.DASHBOARD_API_KEY = generatedKey;
  return { key: generatedKey, generated: true };
}

async function main() {
  // Load configuration from file, then override with environment variables
  const fileConfig = loadConfig(CONFIG_PATH);
  const envConfig = loadConfigFromEnv();

  // Merge configs (env overrides file)
  const config: Config = {
    proxy: { ...fileConfig.proxy, ...envConfig.proxy },
    lapi_servers: fileConfig.lapi_servers, // LAPI servers only from file
    storage: { ...fileConfig.storage, ...envConfig.storage },
    logging: { ...fileConfig.logging, ...envConfig.logging },
    filters: fileConfig.filters, // Filters only from file
    client_validation: { ...fileConfig.client_validation, ...envConfig.client_validation },
    analyzers: fileConfig.analyzers, // Analyzers only from file
    bouncer_metrics: fileConfig.bouncer_metrics, // Bouncer metrics polling settings
  };

  // Initialize logger (with custom `notice` level wired in for audit-friendly
  // logging of human-actor actions like manual ban / unban).
  const usePrettyLogs = config.logging.format === 'pretty' && process.env.NODE_ENV !== 'production';
  const logger = createLogger({
    level: config.logging.level,
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    transport: usePrettyLogs ? { target: 'pino-pretty' } : undefined,
  });

  if (config.logging.format === 'pretty' && process.env.NODE_ENV === 'production') {
    logger.warn('Pretty logging is not available in production, using JSON format instead');
  }

  logger.info('Starting CrowdSieve...');
  logger.info({ configPath: CONFIG_PATH }, 'Configuration loaded');

  // Ensure dashboard API key is set (generate if not provided)
  const apiKeyInfo = ensureDashboardApiKey();
  if (apiKeyInfo.generated) {
    logger.warn(
      'DASHBOARD_API_KEY was not set. A random key has been generated for this session. ' +
        'The dashboard API will not be accessible without this key. ' +
        'Set the DASHBOARD_API_KEY environment variable to use a persistent key.'
    );
  }

  // Initialize database
  const dbType = config.storage.type;
  if (dbType === 'postgres') {
    logger.info('Initializing database: PostgreSQL');
  } else {
    logger.info({ dbPath: config.storage.path }, 'Initializing database: SQLite');
  }
  await initializeDatabase(config, logger);

  // Initialize GeoIP
  logger.info({ geoipPath: GEOIP_DB_PATH }, 'Initializing GeoIP');
  const geoipAvailable = await initGeoIP(GEOIP_DB_PATH);
  if (!geoipAvailable) {
    logger.warn('GeoIP database not available, IP enrichment will be disabled');
  }

  // Load filters from filters.d/ directory
  const configDir = (() => {
    const dir = dirname(CONFIG_PATH);
    return !dir || dir === '.' ? process.cwd() : dir;
  })();
  const filtersDir = process.env.FILTERS_DIR || join(configDir, 'filters.d');
  const { filters: dirFilters, errors: filterErrors } = loadFiltersFromDirectory(filtersDir);

  // Log filter loading errors
  for (const { file, error } of filterErrors) {
    logger.warn({ file, error }, 'Failed to load filter file');
  }

  // Merge filters: config rules first, then directory filters
  const allFilters = [...config.filters.rules, ...dirFilters];

  // Initialize filter engine
  const filterEngine = new FilterEngine(config.filters.mode, allFilters);
  const loadedFilters = filterEngine.getFilters();
  logger.info(
    {
      mode: config.filters.mode,
      fromConfig: config.filters.rules.length,
      fromDir: dirFilters.length,
      total: loadedFilters.length,
      filtersDir,
      filters: loadedFilters.map((f) => ({ name: f.name, enabled: f.enabled })),
    },
    'Filter engine initialized'
  );

  // Log each filter in debug mode
  for (const filter of loadedFilters) {
    logger.debug({ name: filter.name, enabled: filter.enabled }, 'Filter loaded');
  }

  // Initialize storage
  const storage = createStorage();

  // Inject GeoIP lookup into storage
  const originalStoreAlerts = storage.storeAlerts.bind(storage);
  storage.storeAlerts = async (alerts, filterDetails, options) => {
    return originalStoreAlerts(alerts, filterDetails, {
      ...options,
      geoipLookup: geoipAvailable ? lookupIP : undefined,
    });
  };

  // Inject GeoIP lookup into recordUnbanEvent (mirror storeAlerts pattern)
  const originalRecordUnbanEvent = storage.recordUnbanEvent.bind(storage);
  storage.recordUnbanEvent = async (input) => {
    return originalRecordUnbanEvent({
      ...input,
      geoipLookup: input.geoipLookup ?? (geoipAvailable ? lookupIP : undefined),
    });
  };

  // Same injection for recordManualBanAuditEvent so manual-ban audit rows get
  // the same geo enrichment as unban rows and round-tripped alerts.
  const originalRecordManualBanAuditEvent = storage.recordManualBanAuditEvent.bind(storage);
  storage.recordManualBanAuditEvent = async (input) => {
    return originalRecordManualBanAuditEvent({
      ...input,
      geoipLookup: input.geoipLookup ?? (geoipAvailable ? lookupIP : undefined),
    });
  };

  // Initialize client validator (if enabled)
  let clientValidator: ClientValidator | undefined;
  if (config.client_validation.enabled) {
    clientValidator = new ClientValidator(
      {
        enabled: config.client_validation.enabled,
        cacheTtlSeconds: config.client_validation.cache_ttl_seconds,
        cacheTtlErrorSeconds: config.client_validation.cache_ttl_error_seconds,
        validationTimeoutMs: config.client_validation.validation_timeout_ms,
        maxMemoryEntries: config.client_validation.max_memory_entries,
        failClosed: config.client_validation.fail_closed,
      },
      config.proxy.capi_url,
      logger
    );
    logger.info({ failClosed: config.client_validation.fail_closed }, 'Client validation enabled');
  }

  // Initialize analyzer engine (if enabled)
  if (config.analyzers?.enabled) {
    const analyzerStorage = createAnalyzerStorage();
    const analyzerEngine = initializeAnalyzerEngine(config, logger, analyzerStorage);
    await analyzerEngine.initialize();
    logger.info('Analyzer engine initialized');
  }

  // Initialize replication service (if any servers have replicate_decisions enabled)
  let replicationService: ReplicationService | undefined;
  const replicationServers = (config.lapi_servers || []).filter((s) => s.replicate_decisions);
  const hasReplicationTargets = replicationServers.some((s) => s.machine_id && s.password);

  // Warn about servers with replicate_decisions but missing credentials or source_machine_ids
  for (const server of replicationServers) {
    if (!server.machine_id || !server.password) {
      logger.warn(
        { server: server.name },
        'Server has replicate_decisions enabled but missing machine_id or password - replication disabled for this target'
      );
    }
    if (!server.source_machine_ids || server.source_machine_ids.length === 0) {
      logger.warn(
        { server: server.name },
        'Server has replicate_decisions enabled but missing source_machine_ids - loop prevention may not work correctly'
      );
    }
  }

  if (hasReplicationTargets) {
    replicationService = createReplicationService(config, logger);
    logger.info(
      {
        targets: replicationServers.filter((s) => s.machine_id && s.password).map((s) => s.name),
      },
      'Replication service initialized'
    );
  }

  // Initialize bouncer metrics collector (if enabled)
  let metricsCollector: MetricsCollector | undefined;
  if (config.bouncer_metrics.enabled) {
    metricsCollector = createMetricsCollector({
      config,
      storage,
      logger,
      lapiServers: config.lapi_servers || [],
    });
    metricsCollector.start();
    logger.info(
      {
        intervalSeconds: config.bouncer_metrics.interval_seconds,
        retentionDays: config.bouncer_metrics.retention_days,
        servers: (config.lapi_servers || []).map((s) => s.name),
      },
      'Bouncer metrics collector started'
    );
  }

  // Create and start proxy server
  const server = await createProxyServer({
    config,
    filterEngine,
    storage,
    logger,
    clientValidator,
    replicationService,
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');

    await server.close();
    logger.info('HTTP server closed');

    // Stop analyzer engine
    const analyzerEngine = getAnalyzerEngine();
    if (analyzerEngine) {
      analyzerEngine.stop();
      logger.info('Analyzer engine stopped');
    }

    // Stop bouncer metrics collector
    if (metricsCollector) {
      metricsCollector.stop();
      logger.info('Bouncer metrics collector stopped');
    }

    closeGeoIP();
    await closeDatabase();
    logger.info('Resources cleaned up');

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start server
  const port = config.proxy.listen_port;
  await server.listen({ port, host: '0.0.0.0' });

  logger.info({ port, capiUrl: config.proxy.capi_url }, 'Proxy server started');

  // Schedule cleanup job
  const cleanupInterval = 24 * 60 * 60 * 1000; // Daily
  setInterval(async () => {
    try {
      const deleted = await storage.cleanup(config.storage.retention_days);
      if (deleted > 0) {
        logger.info({ deleted }, 'Cleaned up old alerts');
      }
    } catch (err) {
      logger.error({ err }, 'Cleanup failed');
    }

    // Cleanup validation cache
    if (clientValidator) {
      try {
        await clientValidator.cleanupExpired();
      } catch (err) {
        logger.error({ err }, 'Validation cache cleanup failed');
      }
    }
  }, cleanupInterval);
}

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  // Don't exit - let the app continue
});

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
