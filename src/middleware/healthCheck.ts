import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getRedisClient } from '../config/redis';
import { getChannel, isMessageQueueConnected } from '../config/messageQueue';
import { isFirebaseInitialized, getMessaging } from '../config/firebase';
import { isAPNsInitialized } from '../config/apns';
import { logger, logHealth } from '../utils/logger';
import { asyncHandler } from './errorHandler';

/**
 * Health Check Probes - Kubernetes-style separation
 * 
 * LIVENESS (/health/live):
 *   - Checks if process is alive and not deadlocked
 *   - NEVER checks external dependencies (Redis, Mongo, RabbitMQ)
 *   - Failure triggers pod restart
 *   - Should always pass unless process is stuck
 * 
 * READINESS (/health/ready):
 *   - Checks if service can handle traffic
 *   - Checks critical dependencies (DB, Redis, MessageQueue)
 *   - Failure removes pod from load balancer (no restart)
 *   - Transient dependency issues won't cause restarts
 * 
 * STARTUP (/health/startup):
 *   - Checks if initialization is complete
 *   - Has longer timeout for slow-starting services
 *   - Only checked during startup phase
 *   - Prevents liveness probe from killing slow starters
 */

// Track initialization state for startup probe
let isFullyInitialized = false;
let initializationError: Error | null = null;

export function markInitializationComplete(): void {
  isFullyInitialized = true;
  logger.info('✅ Service initialization marked as complete');
}

export function markInitializationFailed(error: Error): void {
  initializationError = error;
  logger.error('❌ Service initialization failed:', error);
}

interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version: string;
  environment: string;
}

interface DetailedHealthStatus extends HealthStatus {
  services: {
    database: ServiceHealth;
    redis: ServiceHealth;
    messageQueue: ServiceHealth;
    firebase: ServiceHealth;
    apns: ServiceHealth;
  };
  system: {
    memory: {
      used: number;
      free: number;
      total: number;
      usage: string;
    };
    cpu: {
      loadAverage: number[];
    };
    process: {
      pid: number;
      uptime: number;
      version: string;
    };
  };
  stats: {
    requestsTotal?: number;
    requestsActive?: number;
    notificationsSent24h?: number;
    devicesActive?: number;
  };
}

interface ServiceHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  message?: string;
  responseTime?: number;
  lastCheck: string;
  details?: any;
}

// Simple health check
export const healthCheckMiddleware = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/health') {
    return await simpleHealthCheck(req, res);
  } else if (req.path === '/health/detailed') {
    return await detailedHealthCheck(req, res);
  } else if (req.path === '/health/ready') {
    return await readinessCheck(req, res);
  } else if (req.path === '/health/live') {
    return await livenessCheck(req, res);
  } else if (req.path === '/health/startup') {
    return await startupCheck(req, res);
  }
  
  next();
});

// Simple health check endpoint
async function simpleHealthCheck(req: Request, res: Response): Promise<void> {
  const health: HealthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
  };
  
  logHealth.check('simple', 'healthy', health);
  
  res.status(200).json(health);
}

// Detailed health check with all service statuses
async function detailedHealthCheck(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  
  try {
    // Check all services
    const [database, redis, messageQueue, firebase, apns, stats] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkMessageQueue(),
      checkFirebase(),
      checkAPNs(),
      getSystemStats(),
    ]);
    
    const overallStatus = [
      database.status,
      redis.status,
      messageQueue.status,
      firebase.status,
      apns.status,
    ].includes('unhealthy') ? 'unhealthy' : 'healthy';
    
    const health: DetailedHealthStatus = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      services: {
        database,
        redis,
        messageQueue,
        firebase,
        apns,
      },
      system: getSystemInfo(),
      stats: await getApplicationStats(),
    };
    
    const responseTime = Date.now() - startTime;
    logger.info('Detailed health check completed', {
      status: overallStatus,
      responseTime: `${responseTime}ms`,
      services: Object.entries(health.services).map(([name, service]) => ({
        name,
        status: service.status,
      })),
    });
    
    const statusCode = overallStatus === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);
    
  } catch (error) {
    logger.error('Health check failed:', error);
    
    const errorHealth: HealthStatus = {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
    };
    
    res.status(503).json({
      ...errorHealth,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// Kubernetes readiness probe
// Checks if service can handle traffic - external dependency failures here
// won't trigger restarts, just remove from load balancer
async function readinessCheck(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  
  try {
    // Check critical services required for serving requests
    // These are the dependencies that MUST be available for traffic handling
    const [database, redis, messageQueue] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkMessageQueue(),
    ]);
    
    const isReady = 
      database.status === 'healthy' && 
      redis.status === 'healthy' &&
      messageQueue.status === 'healthy';
    
    const responseTime = Date.now() - startTime;
    
    if (isReady) {
      res.status(200).json({ 
        status: 'ready',
        responseTime: `${responseTime}ms`,
        timestamp: new Date().toISOString(),
        checks: {
          database: database.status,
          redis: redis.status,
          messageQueue: messageQueue.status,
        }
      });
    } else {
      // Log which service is unhealthy for debugging
      logger.warn('Readiness check failed', {
        database: database.status,
        redis: redis.status,
        messageQueue: messageQueue.status,
        responseTime,
      });
      
      res.status(503).json({
        status: 'not ready',
        responseTime: `${responseTime}ms`,
        timestamp: new Date().toISOString(),
        checks: {
          database: { status: database.status, message: database.message },
          redis: { status: redis.status, message: redis.message },
          messageQueue: { status: messageQueue.status, message: messageQueue.message },
        },
      });
    }
  } catch (error) {
    logger.error('Readiness check error:', error);
    res.status(503).json({ 
      status: 'not ready', 
      error: 'Health check failed',
      timestamp: new Date().toISOString(),
    });
  }
}

// Kubernetes liveness probe
// ONLY checks if the process is alive and responsive
// NEVER checks external dependencies - we don't want to restart
// just because Redis/Mongo/RabbitMQ has a transient issue
async function livenessCheck(req: Request, res: Response): Promise<void> {
  try {
    // Check 1: Event loop is responsive (we got here, so it is)
    // Check 2: Memory is not critically exhausted
    const memUsage = process.memoryUsage();
    const heapUsedPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    
    // Check 3: Process uptime indicates we're running
    const uptime = Math.floor(process.uptime());
    
    // Only fail liveness if we're in a truly broken state
    // High memory usage could indicate a leak
    const isAlive = heapUsedPercent < 95; // Allow some headroom
    
    if (isAlive) {
      res.status(200).json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime,
        memory: {
          heapUsedPercent: `${heapUsedPercent.toFixed(1)}%`,
          heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
        },
      });
    } else {
      // Critical: memory exhaustion indicates pod should restart
      logger.error('Liveness check failed: memory exhaustion', {
        heapUsedPercent,
        heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      });
      
      res.status(503).json({
        status: 'not alive',
        reason: 'memory_exhaustion',
        memory: {
          heapUsedPercent: `${heapUsedPercent.toFixed(1)}%`,
        },
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    // If we can't even check memory, something is very wrong
    logger.error('Liveness check error:', error);
    res.status(503).json({ 
      status: 'not alive', 
      reason: 'internal_error',
      timestamp: new Date().toISOString(),
    });
  }
}

// Kubernetes startup probe
// Checks if initialization is complete
// Has longer timeout, only checked during startup phase
async function startupCheck(req: Request, res: Response): Promise<void> {
  try {
    // Check if initialization completed successfully
    if (initializationError) {
      logger.error('Startup check failed: initialization error', {
        error: initializationError.message,
      });
      
      res.status(503).json({
        status: 'not started',
        reason: 'initialization_failed',
        error: initializationError.message,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    
    if (!isFullyInitialized) {
      // Still initializing - this is normal during startup
      res.status(503).json({
        status: 'starting',
        reason: 'initialization_in_progress',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
      return;
    }
    
    // Initialization complete - now do a basic connectivity check
    // This ensures we're actually ready to start serving
    const [database, redis] = await Promise.all([
      checkDatabase(),
      checkRedis(),
    ]);
    
    const isStarted = 
      database.status === 'healthy' && 
      redis.status === 'healthy';
    
    if (isStarted) {
      res.status(200).json({
        status: 'started',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        checks: {
          initialized: true,
          database: database.status,
          redis: redis.status,
        },
      });
    } else {
      res.status(503).json({
        status: 'not started',
        reason: 'dependencies_unavailable',
        checks: {
          initialized: true,
          database: { status: database.status, message: database.message },
          redis: { status: redis.status, message: redis.message },
        },
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    logger.error('Startup check error:', error);
    res.status(503).json({
      status: 'not started',
      reason: 'startup_check_error',
      timestamp: new Date().toISOString(),
    });
  }
}

// Individual service health checks
async function checkDatabase(): Promise<ServiceHealth> {
  const startTime = Date.now();
  
  try {
    if (mongoose.connection.readyState === 1) {
      // Test with a simple query
      await mongoose.connection.db?.admin().ping();
      
      return {
        status: 'healthy',
        message: 'Connected',
        responseTime: Date.now() - startTime,
        lastCheck: new Date().toISOString(),
        details: {
          readyState: mongoose.connection.readyState,
          host: mongoose.connection.host,
          port: mongoose.connection.port,
          name: mongoose.connection.name,
        },
      };
    } else {
      return {
        status: 'unhealthy',
        message: 'Not connected',
        lastCheck: new Date().toISOString(),
        details: {
          readyState: mongoose.connection.readyState,
        },
      };
    }
  } catch (error) {
    return {
      status: 'unhealthy',
      message: error instanceof Error ? error.message : 'Unknown error',
      responseTime: Date.now() - startTime,
      lastCheck: new Date().toISOString(),
    };
  }
}

async function checkRedis(): Promise<ServiceHealth> {
  const startTime = Date.now();
  
  try {
    const redisClient = getRedisClient();
    
    if (!redisClient || !redisClient.isOpen) {
      return {
        status: 'unhealthy',
        message: 'Not connected',
        lastCheck: new Date().toISOString(),
      };
    }
    
    // Test with ping
    await redisClient.ping();
    
    return {
      status: 'healthy',
      message: 'Connected',
      responseTime: Date.now() - startTime,
      lastCheck: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      message: error instanceof Error ? error.message : 'Unknown error',
      responseTime: Date.now() - startTime,
      lastCheck: new Date().toISOString(),
    };
  }
}

async function checkMessageQueue(): Promise<ServiceHealth> {
  try {
    const channel = getChannel();
    
    if (!channel) {
      return {
        status: 'unhealthy',
        message: 'Channel not available',
        lastCheck: new Date().toISOString(),
      };
    }
    
    return {
      status: 'healthy',
      message: 'Connected',
      lastCheck: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      message: error instanceof Error ? error.message : 'Unknown error',
      lastCheck: new Date().toISOString(),
    };
  }
}

async function checkFirebase(): Promise<ServiceHealth> {
  try {
    const isInitialized = isFirebaseInitialized();
    
    if (!isInitialized) {
      return {
        status: 'unhealthy',
        message: 'Not initialized',
        lastCheck: new Date().toISOString(),
      };
    }
    
    // Could add more sophisticated Firebase health check here
    return {
      status: 'healthy',
      message: 'Initialized',
      lastCheck: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      message: error instanceof Error ? error.message : 'Unknown error',
      lastCheck: new Date().toISOString(),
    };
  }
}

async function checkAPNs(): Promise<ServiceHealth> {
  try {
    const isInitialized = isAPNsInitialized();
    
    if (!isInitialized) {
      return {
        status: 'unhealthy',
        message: 'Not initialized',
        lastCheck: new Date().toISOString(),
      };
    }
    
    return {
      status: 'healthy',
      message: 'Initialized',
      lastCheck: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      message: error instanceof Error ? error.message : 'Unknown error',
      lastCheck: new Date().toISOString(),
    };
  }
}

// System information
function getSystemInfo() {
  const memUsage = process.memoryUsage();
  
  return {
    memory: {
      used: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
      free: Math.round((memUsage.heapTotal - memUsage.heapUsed) / 1024 / 1024), // MB
      total: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
      usage: `${Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)}%`,
    },
    cpu: {
      loadAverage: require('os').loadavg(),
    },
    process: {
      pid: process.pid,
      uptime: Math.floor(process.uptime()),
      version: process.version,
    },
  };
}

// Application statistics
async function getApplicationStats() {
  try {
    // Import models dynamically to avoid circular dependencies
    const { default: Notification } = await import('../models/Notification');
    const { default: Device } = await import('../models/Device');
    
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    const [notificationsSent24h, devicesActive] = await Promise.all([
      Notification.countDocuments({
        createdAt: { $gte: oneDayAgo },
        status: { $in: ['sent', 'delivered'] },
      }),
      Device.countDocuments({
        isActive: true,
        lastSeen: { $gte: oneDayAgo },
      }),
    ]);
    
    return {
      notificationsSent24h,
      devicesActive,
    };
  } catch (error) {
    logger.error('Error getting application stats:', error);
    return {};
  }
}

// Get system stats (placeholder for more detailed metrics)
async function getSystemStats() {
  // This could integrate with monitoring systems like Prometheus
  return {};
}