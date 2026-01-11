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
let isFullyInitialized = false;
let initializationError: Error | null = null;

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
    
    // Mark initialization complete
    isFullyInitialized = true;

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

// Health check (basic - for backward compatibility)
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

// Kubernetes-style liveness probe
// ONLY checks if process is alive - never checks external dependencies
app.get('/health/live', (req, res) => {
  try {
    const memUsage = process.memoryUsage();
    const heapUsedPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    
    // Only fail liveness if we're in a truly broken state
    const isAlive = heapUsedPercent < 95 && !isShuttingDown;
    
    if (isAlive) {
      res.status(200).json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        memory: {
          heapUsedPercent: `${heapUsedPercent.toFixed(1)}%`,
        },
      });
    } else {
      res.status(503).json({
        status: 'not alive',
        reason: isShuttingDown ? 'shutting_down' : 'memory_exhaustion',
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    res.status(503).json({
      status: 'not alive',
      reason: 'internal_error',
      timestamp: new Date().toISOString(),
    });
  }
});

// Kubernetes-style readiness probe
// Checks if worker can process notifications
app.get('/health/ready', async (req, res) => {
  try {
    const dbHealthy = await connectionPool.healthCheck();
    const workerStats = worker ? worker.getStats() : null;
    
    const isReady = 
      isFullyInitialized &&
      dbHealthy && 
      workerStats?.isRunning === true &&
      !isShuttingDown;
    
    if (isReady) {
      res.status(200).json({
        status: 'ready',
        timestamp: new Date().toISOString(),
        checks: {
          initialized: true,
          database: 'healthy',
          worker: 'running',
        },
      });
    } else {
      res.status(503).json({
        status: 'not ready',
        timestamp: new Date().toISOString(),
        checks: {
          initialized: isFullyInitialized,
          database: dbHealthy ? 'healthy' : 'unhealthy',
          worker: workerStats?.isRunning ? 'running' : 'stopped',
          shuttingDown: isShuttingDown,
        },
      });
    }
  } catch (error) {
    res.status(503).json({
      status: 'not ready',
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
  }
});

// Kubernetes-style startup probe
// Checks if worker initialization is complete
app.get('/health/startup', async (req, res) => {
  try {
    if (initializationError) {
      res.status(503).json({
        status: 'not started',
        reason: 'initialization_failed',
        error: initializationError.message,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    
    if (!isFullyInitialized) {
      res.status(503).json({
        status: 'starting',
        reason: 'initialization_in_progress',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
      return;
    }
    
    res.status(200).json({
      status: 'started',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    });
  } catch (error) {
    res.status(503).json({
      status: 'not started',
      reason: 'startup_check_error',
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
  initializationError = error instanceof Error ? error : new Error(String(error));
  logger.error('❌ Failed to start worker:', error);
  process.exit(1);
});
