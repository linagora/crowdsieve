import pino from 'pino';
import { dirname, join } from 'path';
import { loadConfig, loadConfigFromEnv, loadFiltersFromDirectory, Config } from './config/index.js';
import { initializeDatabase, closeDatabase } from './db/index.js';
import { FilterEngine } from './filters/index.js';
import { createStorage } from './storage/index.js';
import { createProxyServer } from './proxy/server.js';
import { initGeoIP, lookupIP, closeGeoIP } from './geoip/index.js';
import { ClientValidator } from './validation/index.js';

const CONFIG_PATH = process.env.CONFIG_PATH || './config/filters.yaml';
const GEOIP_DB_PATH = process.env.GEOIP_DB_PATH || './data/GeoLite2-City.mmdb';

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
  };

  // Initialize logger
  const usePrettyLogs = config.logging.format === 'pretty' && process.env.NODE_ENV !== 'production';
  const logger = pino({
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

  // Initialize database
  logger.info({ dbPath: config.storage.path }, 'Initializing database');
  initializeDatabase(config.storage.path);

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
  storage.storeAlerts = async (alerts, filterDetails) => {
    return originalStoreAlerts(alerts, filterDetails, geoipAvailable ? lookupIP : undefined);
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

  // Create and start proxy server
  const server = await createProxyServer({
    config,
    filterEngine,
    storage,
    logger,
    clientValidator,
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');

    await server.close();
    logger.info('HTTP server closed');

    closeGeoIP();
    closeDatabase();
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
