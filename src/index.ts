import pino from 'pino';
import { loadConfig } from './config/index.js';
import { initializeDatabase, closeDatabase } from './db/index.js';
import { FilterEngine } from './filters/index.js';
import { createStorage } from './storage/index.js';
import { createProxyServer } from './proxy/server.js';
import { initGeoIP, lookupIP, closeGeoIP } from './geoip/index.js';

const CONFIG_PATH = process.env.CONFIG_PATH || './config/filters.yaml';
const GEOIP_DB_PATH = process.env.GEOIP_DB_PATH || './data/GeoLite2-City.mmdb';

async function main() {
  // Load configuration
  const config = loadConfig(CONFIG_PATH);

  // Initialize logger
  const logger = pino({
    level: config.logging.level,
    transport: config.logging.format === 'pretty' ? { target: 'pino-pretty' } : undefined,
  });

  logger.info('Starting CrowdSec Proxy...');
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

  // Initialize filter engine
  const filterEngine = new FilterEngine(config.filters.mode, config.filters.rules);
  logger.info(
    {
      mode: config.filters.mode,
      filterCount: filterEngine.getFilters().length,
    },
    'Filter engine initialized'
  );

  // Initialize storage
  const storage = createStorage();

  // Inject GeoIP lookup into storage
  const originalStoreAlerts = storage.storeAlerts.bind(storage);
  storage.storeAlerts = async (alerts, filterDetails) => {
    return originalStoreAlerts(alerts, filterDetails, geoipAvailable ? lookupIP : undefined);
  };

  // Create and start proxy server
  const server = await createProxyServer({
    config,
    filterEngine,
    storage,
    logger,
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
  }, cleanupInterval);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
