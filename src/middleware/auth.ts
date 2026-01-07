import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';
import { createError } from './errorHandler';
import { RedisCache } from '../config/redis';

interface JWTPayload {
  userId: string;
  email?: string;
  role?: string;
  iat: number;
  exp: number;
}

// Extend Request type to include user info
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
      userId?: string;
      requestId?: string;
    }
  }
}

// JWT secret
const JWT_SECRET: string = process.env.JWT_SECRET || 'default-dev-secret';
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  logger.error('JWT_SECRET environment variable is required in production');
  process.exit(1);
}

// Public routes that don't require authentication
const PUBLIC_ROUTES = [
  '/health',
  '/health/detailed',
  '/api/webhooks', // For external service callbacks
];

// Routes that require internal service authentication
const INTERNAL_ROUTES = [
  '/api/internal',
];

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const path = req.path;
    
    // Skip authentication for public routes
    if (PUBLIC_ROUTES.some(route => path.startsWith(route))) {
      return next();
    }
    
    // Check for internal service routes
    if (INTERNAL_ROUTES.some(route => path.startsWith(route))) {
      return await handleInternalAuth(req, res, next);
    }
    
    // Extract token from header
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      throw createError.unauthorized('Authorization header is required');
    }
    
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : authHeader;
    
    if (!token) {
      throw createError.unauthorized('Token is required');
    }
    
    // Check if token is blacklisted
    const isBlacklisted = await RedisCache.exists(`blacklist:${token}`);
    if (isBlacklisted) {
      throw createError.unauthorized('Token has been revoked');
    }
    
    // Verify JWT token
    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;
    
    // Check token expiration
    if (decoded.exp <= Math.floor(Date.now() / 1000)) {
      throw createError.unauthorized('Token has expired');
    }
    
    // Add user info to request
    req.user = decoded;
    req.userId = decoded.userId;
    
    // Update last seen (optional, can be expensive for high-traffic)
    if (process.env.TRACK_LAST_SEEN === 'true') {
      await updateLastSeen(decoded.userId);
    }
    
    next();
    
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      next(createError.unauthorized('Invalid token'));
    } else if (error instanceof jwt.TokenExpiredError) {
      next(createError.unauthorized('Token has expired'));
    } else {
      next(error);
    }
  }
};

// Handle internal service authentication
const handleInternalAuth = async (req: Request, res: Response, next: NextFunction) => {
  const internalToken = req.get('X-Internal-Service-Token');
  const expectedToken = process.env.INTERNAL_SERVICE_TOKEN;
  
  if (!expectedToken) {
    logger.error('INTERNAL_SERVICE_TOKEN not configured');
    throw createError.unauthorized('Internal service authentication not configured');
  }
  
  if (!internalToken || internalToken !== expectedToken) {
    logger.warn('Invalid internal service token', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path,
    });
    throw createError.unauthorized('Invalid internal service token');
  }
  
  // Mark request as internal
  (req as any).isInternal = true;
  next();
};

// Optional authentication (user info if token provided, but doesn't fail)
export const optionalAuthMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return next();
    }
    
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : authHeader;
    
    if (!token) {
      return next();
    }
    
    // Check if token is blacklisted
    const isBlacklisted = await RedisCache.exists(`blacklist:${token}`);
    if (isBlacklisted) {
      return next();
    }
    
    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;
    
    // Add user info to request if token is valid
    req.user = decoded;
    req.userId = decoded.userId;
    
    next();
    
  } catch (error) {
    // Don't fail on optional auth errors, just continue without user info
    logger.debug('Optional auth failed:', error);
    next();
  }
};

// Role-based authorization middleware
export const requireRole = (roles: string | string[]) => {
  const allowedRoles = Array.isArray(roles) ? roles : [roles];
  
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      throw createError.unauthorized('Authentication required');
    }
    
    const userRole = req.user.role || 'user';
    
    if (!allowedRoles.includes(userRole)) {
      logger.warn('Insufficient permissions', {
        userId: req.userId,
        userRole,
        requiredRoles: allowedRoles,
        path: req.path,
      });
      
      throw createError.forbidden('Insufficient permissions');
    }
    
    next();
  };
};

// User ownership verification (user can only access their own resources)
export const requireOwnership = (userIdExtractor?: (req: Request) => string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      throw createError.unauthorized('Authentication required');
    }
    
    let resourceUserId: string;
    
    if (userIdExtractor) {
      resourceUserId = userIdExtractor(req);
    } else {
      // Default: get from params.userId or body.userId
      resourceUserId = req.params.userId || req.body.userId;
    }
    
    if (!resourceUserId) {
      throw createError.badRequest('User ID not found in request');
    }
    
    if (req.user.userId !== resourceUserId && req.user.role !== 'admin') {
      logger.warn('Ownership verification failed', {
        requestUserId: req.user.userId,
        resourceUserId,
        path: req.path,
      });
      
      throw createError.forbidden('Access denied: insufficient permissions');
    }
    
    next();
  };
};

// JWT token generation utility
export function generateToken(
  payload: { userId: string; email?: string; role?: string },
  expiresIn: string | number = process.env.JWT_EXPIRES_IN || '7d'
): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn,
    issuer: 'notification-service',
    audience: 'notification-api',
  } as jwt.SignOptions);
}

// Token blacklisting (for logout)
export async function blacklistToken(token: string): Promise<void> {
  try {
    const decoded = jwt.decode(token) as JWTPayload;
    if (decoded && decoded.exp) {
      const ttl = decoded.exp - Math.floor(Date.now() / 1000);
      if (ttl > 0) {
        await RedisCache.set(`blacklist:${token}`, 'true', ttl);
        logger.info('Token blacklisted', { userId: decoded.userId });
      }
    }
  } catch (error) {
    logger.error('Error blacklisting token:', error);
  }
}

// Refresh token logic (if needed)
export function refreshToken(currentToken: string): string | null {
  try {
    const decoded = jwt.verify(currentToken, JWT_SECRET) as unknown as JWTPayload;
    
    // Check if token is close to expiry (within 1 hour)
    const timeUntilExpiry = decoded.exp - Math.floor(Date.now() / 1000);
    const oneHour = 60 * 60;
    
    if (timeUntilExpiry < oneHour) {
      // Generate new token
      return generateToken({
        userId: decoded.userId,
        ...(decoded.email && { email: decoded.email }),
        ...(decoded.role && { role: decoded.role }),
      });
    }
    
    return null; // Token doesn't need refresh
    
  } catch (error) {
    logger.error('Error refreshing token:', error);
    return null;
  }
}

// Update last seen timestamp
const updateLastSeen = async (userId: string): Promise<void> => {
  try {
    await RedisCache.set(
      `user:last_seen:${userId}`,
      new Date().toISOString(),
      24 * 60 * 60 // 24 hours TTL
    );
  } catch (error) {
    logger.error('Error updating last seen:', error);
  }
};

// Get user's last seen timestamp
export async function getLastSeen(userId: string): Promise<Date | null> {
  try {
    const lastSeen = await RedisCache.get(`user:last_seen:${userId}`);
    return lastSeen ? new Date(lastSeen) : null;
  } catch (error) {
    logger.error('Error getting last seen:', error);
    return null;
  }
}

// API key authentication (alternative to JWT for service-to-service)
export const apiKeyAuth = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.get('X-API-Key');
  const validApiKeys = process.env.API_KEYS?.split(',') || [];
  
  if (!apiKey || !validApiKeys.includes(apiKey)) {
    logger.warn('Invalid API key', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path,
    });
    
    throw createError.unauthorized('Invalid API key');
  }
  
  // Mark request as API authenticated
  (req as any).isApiAuthenticated = true;
  next();
};