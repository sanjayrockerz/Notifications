import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { getRedisClient } from '../config/redis';
import { getChannel } from '../config/messageQueue';
import { isFirebaseInitialized } from '../config/firebase';
import { isAPNsInitialized } from '../config/apns';
import { logger, logHealth } from '../utils/logger';
import { asyncHandler } from './errorHandler';

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
async function readinessCheck(req: Request, res: Response): Promise<void> {
  try {
    // Check critical services that are required for serving requests
    const [database, redis] = await Promise.all([
      checkDatabase(),
      checkRedis(),
    ]);
    
    const isReady = database.status === 'healthy' && redis.status === 'healthy';
    
    if (isReady) {
      res.status(200).json({ status: 'ready' });
    } else {
      res.status(503).json({
        status: 'not ready',
        services: { database: database.status, redis: redis.status },
      });
    }
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: 'Health check failed' });
  }
}

// Kubernetes liveness probe
async function livenessCheck(req: Request, res: Response): Promise<void> {
  // Simple check that the process is alive and responsive
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  });
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