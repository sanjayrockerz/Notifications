import { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { getRedisClient } from '../config/redis';
import { logger } from '../utils/logger';
import { createError } from './errorHandler';

interface RateLimitConfig {
  windowMs: number;
  max: number;
  keyGenerator?: (req: Request) => string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

// Default rate limit configurations
const defaultConfig: RateLimitConfig = {
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
};

// Different rate limits for different endpoints
const rateLimitConfigs = {
  // General API rate limit
  general: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
  },
  
  // Stricter limits for notification sending
  notifications: {
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 notifications per minute per user/IP
  },
  
  // Device registration limits
  devices: {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 5, // 5 device registrations per 5 minutes
  },
  
  // Authentication limits
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 auth attempts per 15 minutes
  },
};

// Create rate limiters
let rateLimiters: Record<string, any> = {};

function createRateLimiter(name: string, config: RateLimitConfig) {
  const redisClient = getRedisClient();
  const options = {
    keyPrefix: `rate_limit_${name}`,
    points: config.max,
    duration: Math.floor(config.windowMs / 1000),
    execEvenly: true,
    storeClient: redisClient?.isOpen ? redisClient : undefined,
  };

  // Skip rate limiting in test environment
  if (process.env.NODE_ENV === 'test') {
    return {
      consume: async () => ({ remainingPoints: config.max, msBeforeNext: 0 })
    };
  }

  // Use Redis if available, fallback to memory
  if (redisClient?.isOpen) {
    return new RateLimiterRedis(options);
  } else {
    logger.warn('Redis not available, using memory rate limiter');
    // Remove storeClient for memory limiter
    const { storeClient, ...memOptions } = options;
    return new RateLimiterMemory(memOptions);
  }
}

// Initialize rate limiters
export function initializeRateLimiters() {
  Object.entries(rateLimitConfigs).forEach(([name, config]) => {
    rateLimiters[name] = createRateLimiter(name, config);
  });
  
  logger.info('Rate limiters initialized');
}

// Generic rate limiting middleware factory
function createRateLimitMiddleware(
  limiterName: string,
  keyGenerator?: (req: Request) => string
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limiter = rateLimiters[limiterName];
      
      if (!limiter) {
        logger.error(`Rate limiter '${limiterName}' not found`);
        return next();
      }
      
      // Generate key for rate limiting
      let key: string;
      if (keyGenerator) {
        key = keyGenerator(req);
      } else {
        // Default key: IP address
        key = req.ip || 'unknown';
      }
      
      const result = await limiter.consume(key);
      
      // Add rate limit info to response headers
      res.set({
        'X-RateLimit-Limit': rateLimitConfigs[limiterName as keyof typeof rateLimitConfigs].max.toString(),
        'X-RateLimit-Remaining': result.remainingPoints?.toString() || '0',
        'X-RateLimit-Reset': new Date(Date.now() + result.msBeforeNext).toISOString(),
      });
      
      next();
      
    } catch (rejRes: any) {
      // Rate limit exceeded
      const secs = Math.round(rejRes.msBeforeNext / 1000) || 1;
      
      res.set({
        'Retry-After': String(secs),
        'X-RateLimit-Limit': rateLimitConfigs[limiterName as keyof typeof rateLimitConfigs].max.toString(),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': new Date(Date.now() + rejRes.msBeforeNext).toISOString(),
      });
      
      logger.warn('Rate limit exceeded', {
        limiter: limiterName,
        key: req.ip,
        remainingPoints: rejRes.remainingPoints,
        msBeforeNext: rejRes.msBeforeNext,
        url: req.url,
        method: req.method,
      });
      
      const error = createError.tooManyRequests(
        `Rate limit exceeded. Try again in ${secs} seconds.`
      );
      
      next(error);
    }
  };
}

// Specific rate limit middlewares
export const generalRateLimit = createRateLimitMiddleware('general');

export const notificationRateLimit = createRateLimitMiddleware(
  'notifications',
  (req) => {
    // Rate limit by user ID if available, otherwise by IP
    const userId = (req as any).userId || req.body?.userId;
    return userId ? `user:${userId}` : `ip:${req.ip}`;
  }
);

export const deviceRateLimit = createRateLimitMiddleware(
  'devices',
  (req) => {
    // Rate limit device registration by IP and user ID
    const userId = (req as any).userId || req.body?.userId;
    return userId ? `device:user:${userId}` : `device:ip:${req.ip}`;
  }
);

export const authRateLimit = createRateLimitMiddleware(
  'auth',
  (req) => `auth:${req.ip}`
);

// Main rate limiting middleware (applied to all routes)
export const rateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Initialize rate limiters if not already done
  if (Object.keys(rateLimiters).length === 0) {
    initializeRateLimiters();
  }
  
  // Apply general rate limiting
  generalRateLimit(req, res, next);
};

// Rate limit bypass for health checks and internal requests
export const bypassRateLimit = (req: Request, res: Response, next: NextFunction) => {
  // Skip rate limiting for health checks
  if (req.path.startsWith('/health')) {
    return next();
  }
  
  // Skip for internal service requests (if they have a special header)
  const internalToken = req.get('X-Internal-Service-Token');
  if (internalToken === process.env.INTERNAL_SERVICE_TOKEN) {
    return next();
  }
  
  // Apply rate limiting
  rateLimitMiddleware(req, res, next);
};

// Get rate limit status for a key
export async function getRateLimitStatus(
  limiterName: string,
  key: string
): Promise<{
  totalHits: number;
  remainingPoints: number;
  msBeforeNext: number;
}> {
  const limiter = rateLimiters[limiterName];
  
  if (!limiter) {
    throw new Error(`Rate limiter '${limiterName}' not found`);
  }
  
  const result = await limiter.get(key);
  
  return {
    totalHits: result?.totalHits || 0,
    remainingPoints: result?.remainingPoints || rateLimitConfigs[limiterName as keyof typeof rateLimitConfigs].max,
    msBeforeNext: result?.msBeforeNext || 0,
  };
}

// Reset rate limit for a key (admin function)
export async function resetRateLimit(limiterName: string, key: string): Promise<boolean> {
  try {
    const limiter = rateLimiters[limiterName];
    
    if (!limiter) {
      return false;
    }
    
    await limiter.delete(key);
    
    logger.info('Rate limit reset', {
      limiter: limiterName,
      key,
    });
    
    return true;
  } catch (error) {
    logger.error('Error resetting rate limit:', error);
    return false;
  }
}