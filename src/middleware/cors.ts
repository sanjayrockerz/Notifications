import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

// CORS configuration
interface CorsOptions {
  origin: string | string[] | boolean | ((origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void);
  methods: string | string[];
  allowedHeaders: string | string[];
  credentials: boolean;
  optionsSuccessStatus?: number;
  maxAge?: number;
}

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) {
      return callback(null, true);
    }
    
    // Get allowed origins from environment
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://localhost:3000',
      'https://localhost:3001',
    ];
    
    // In development, allow localhost with any port
    if (process.env.NODE_ENV === 'development') {
      if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
        return callback(null, true);
      }
    }
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    // Log blocked origin for debugging
    logger.warn('CORS: Origin not allowed', {
      origin,
      allowedOrigins,
    });
    
    callback(new Error(`Origin ${origin} not allowed by CORS`), false);
  },
  
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-HTTP-Method-Override',
    'X-API-Key',
    'X-Request-ID',
    'X-Correlation-ID',
    'X-Internal-Service-Token',
  ],
  
  credentials: true,
  optionsSuccessStatus: 204, // For legacy browser support
  maxAge: 86400, // 24 hours
};

// Custom CORS middleware
export const corsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const origin = req.get('Origin');
  const requestMethod = req.method;
  const requestHeaders = req.get('Access-Control-Request-Headers');
  
  // Handle preflight requests
  if (requestMethod === 'OPTIONS') {
    handlePreflightRequest(req, res, origin);
    return;
  }
  
  // Handle actual requests
  handleActualRequest(req, res, next, origin);
};

function handlePreflightRequest(req: Request, res: Response, origin?: string) {
  logger.debug('CORS: Handling preflight request', {
    origin,
    method: req.get('Access-Control-Request-Method'),
    headers: req.get('Access-Control-Request-Headers'),
  });
  
  // Check origin
  const originCallback = corsOptions.origin as Function;
  originCallback(origin, (error: Error | null, allowed?: boolean) => {
    if (error || !allowed) {
      logger.warn('CORS: Preflight request blocked', { origin, error: error?.message });
      res.status(403).json({
        error: 'CORS: Origin not allowed',
        origin,
      });
      return;
    }
    
    // Set CORS headers for preflight
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
    }
    
    res.set('Access-Control-Allow-Methods', (corsOptions.methods as string[]).join(', '));
    res.set('Access-Control-Allow-Headers', (corsOptions.allowedHeaders as string[]).join(', '));
    
    if (corsOptions.credentials) {
      res.set('Access-Control-Allow-Credentials', 'true');
    }
    
    if (corsOptions.maxAge) {
      res.set('Access-Control-Max-Age', corsOptions.maxAge.toString());
    }
    
    // Respond to preflight
    res.status(corsOptions.optionsSuccessStatus || 204).end();
  });
}

function handleActualRequest(req: Request, res: Response, next: NextFunction, origin?: string) {
  // Check origin for actual requests
  const originCallback = corsOptions.origin as Function;
  originCallback(origin, (error: Error | null, allowed?: boolean) => {
    if (error || !allowed) {
      logger.warn('CORS: Actual request blocked', { origin, error: error?.message });
      res.status(403).json({
        error: 'CORS: Origin not allowed',
        origin,
      });
      return;
    }
    
    // Set CORS headers for actual request
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
    } else {
      // If no origin (mobile app, etc.), allow all
      res.set('Access-Control-Allow-Origin', '*');
    }
    
    if (corsOptions.credentials && origin) {
      // Don't set credentials with wildcard origin
      res.set('Access-Control-Allow-Credentials', 'true');
    }
    
    // Expose headers that client can read
    res.set('Access-Control-Expose-Headers', [
      'X-Request-ID',
      'X-Correlation-ID',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ].join(', '));
    
    next();
  });
}

// Middleware to set security headers
export const securityHeadersMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // X-Content-Type-Options
  res.set('X-Content-Type-Options', 'nosniff');
  
  // X-Frame-Options
  res.set('X-Frame-Options', 'DENY');
  
  // X-XSS-Protection
  res.set('X-XSS-Protection', '1; mode=block');
  
  // Referrer-Policy
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Content-Security-Policy (basic policy)
  if (!req.path.startsWith('/health')) {
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:");
  }
  
  next();
};

// Helper function to check if origin is allowed
export function isOriginAllowed(origin?: string): boolean {
  if (!origin) return true; // Allow requests without origin
  
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
  
  if (process.env.NODE_ENV === 'development') {
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return true;
    }
  }
  
  return allowedOrigins.includes(origin);
}

// Dynamic CORS for webhooks (may need different settings)
export const webhookCorsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // More permissive CORS for webhook endpoints
  const origin = req.get('Origin');
  
  // For webhooks, we might want to allow specific service origins
  const webhookOrigins = process.env.WEBHOOK_ALLOWED_ORIGINS?.split(',') || [];
  
  if (origin && webhookOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Signature, X-Timestamp');
  }
  
  next();
};