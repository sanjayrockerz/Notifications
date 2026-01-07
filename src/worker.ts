/**
 * Worker Entry Point
 * 
 * Dedicated process for parallel notification delivery.
 * Runs independently from API servers.
 * 
 * Features:
 * - Distributed locking (no duplicate processing)
 * - Batch processing (50 notifications at a time)
 * - Resource monitoring (CPU, memory, queue depth)
 * - Graceful shutdown (releases locks)
 * - Health check endpoint
 * - Metrics endpoint
 */

import express from 'express';
import { connectionPool } from './config/connectionPool';
import { connectMessageQueue } from './config/messageQueue';
import { connectRedis, disconnectRedis } from './config/redis';
import { DeliveryWorkerService } from './services/DeliveryWorkerService.v2';
import { resourceMonitor } from './services/ResourceMonitoringService';
import { logger } from './utils/logger';

const app = express();
const port = parseInt(process.env.PORT || '9091', 10);

let worker: DeliveryWorkerService;
let isShuttingDown = false;

/**
 * Initialize worker
 */
async function initialize(): Promise<void> {
  try {
    logger.info('🚀 Starting notification delivery worker...');

    // Connect to database
    await connectionPool.connect();

    // Connect to Redis
    await connectRedis();

    // Connect to message queue
    await connectMessageQueue();

    // Initialize worker
    worker = new DeliveryWorkerService();
    await worker.start();

    // Start resource monitoring
    await resourceMonitor.start();

    logger.info('✅ Worker initialized successfully');

  } catch (error) {
    logger.error('❌ Failed to initialize worker:', error);
    process.exit(1);
  }
}

/**
 * Graceful shutdown
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  logger.info(`🛑 Received ${signal}, shutting down gracefully...`);

  try {
    // Stop accepting new work
    if (worker) {
      await worker.stop();
    }

    // Stop monitoring
    resourceMonitor.stop();

    // Close database connection
    await connectionPool.disconnect();

    // Close Redis connection
    await disconnectRedis();

    logger.info('✅ Worker shut down gracefully');
    process.exit(0);

  } catch (error) {
    logger.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════
// HTTP ENDPOINTS (for health checks and metrics)
// ═══════════════════════════════════════════════════════════

// Health check
app.get('/health', async (req, res) => {
  try {
    const dbHealthy = await connectionPool.healthCheck();
    const workerStats = worker ? worker.getStats() : null;

    const healthy = dbHealthy && workerStats?.isRunning;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'healthy' : 'unhealthy',
      worker: workerStats,
      database: { connected: dbHealthy },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
  }
});

// Metrics (Prometheus format)
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(await resourceMonitor.getMetrics());
});

// Resource snapshot (JSON)
app.get('/resources', async (req, res) => {
  try {
    const snapshot = await resourceMonitor.getSnapshot();
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Worker statistics
app.get('/stats', (req, res) => {
  try {
    if (!worker) {
      return res.status(503).json({ error: 'Worker not initialized' });
    }

    const stats = worker.getStats();
    const poolStats = connectionPool.getPoolStats();

    return res.json({
      worker: stats,
      database: poolStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// ═══════════════════════════════════════════════════════════
// SIGNAL HANDLERS
// ═══════════════════════════════════════════════════════════

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('❌ Uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ Unhandled rejection:', { reason, promise });
  shutdown('unhandledRejection');
});

// ═══════════════════════════════════════════════════════════
// START WORKER
// ═══════════════════════════════════════════════════════════

// Start HTTP server
app.listen(port, () => {
  logger.info(`📡 Worker HTTP server listening on port ${port}`);
});

// Initialize worker
initialize().catch((error) => {
  logger.error('❌ Failed to start worker:', error);
  process.exit(1);
});
