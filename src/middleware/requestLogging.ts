import { Request, Response, NextFunction } from 'express';
import { logger, generateRequestId, PerformanceLogger } from '../utils/logger';

// Request logging middleware
export const requestLoggingMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Generate unique request ID
  const requestId = generateRequestId();
  (req as any).requestId = requestId;
  
  // Add request ID to response headers
  res.set('X-Request-ID', requestId);
  
  // Start performance timer
  const timerLabel = `request:${requestId}`;
  PerformanceLogger.startTimer(timerLabel);
  
  // Log request start
  const requestLog: any = {
    requestId,
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    contentLength: req.get('Content-Length'),
    contentType: req.get('Content-Type'),
    host: req.get('Host'),
    origin: req.get('Origin'),
    referer: req.get('Referer'),
  };
  
  // Log body for non-GET requests (but sanitize sensitive data)
  if (req.method !== 'GET' && req.body) {
    const sanitizedBody = sanitizeRequestBody(req.body);
    if (Object.keys(sanitizedBody).length > 0) {
      requestLog.body = sanitizedBody;
    }
  }
  
  // Log query parameters
  if (req.query && Object.keys(req.query).length > 0) {
    requestLog.query = req.query;
  }
  
  logger.info('Request started', requestLog);
  
  // Capture original res.end to log response
  const originalEnd = res.end;
  const originalSend = res.send;
  
  // Track response body size
  let responseSize = 0;
  
  // Override res.send to capture response data
  res.send = function(body: any) {
    if (body) {
      responseSize = Buffer.byteLength(JSON.stringify(body));
    }
    return originalSend.call(this, body);
  };
  
  // Override res.end to log when response completes
  res.end = function(chunk?: any, encoding?: any) {
    // Calculate response time
    const responseTime = PerformanceLogger.endTimer(timerLabel);
    
    // Log response
    const responseLog = {
      requestId,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      responseTime: `${responseTime}ms`,
      contentLength: res.get('Content-Length') || responseSize,
      userId: (req as any).userId,
      ip: req.ip,
    };
    
    // Determine log level based on status code
    if (res.statusCode >= 500) {
      logger.error('Request completed with server error', responseLog);
    } else if (res.statusCode >= 400) {
      logger.warn('Request completed with client error', responseLog);
    } else {
      logger.info('Request completed successfully', responseLog);
    }
    
    // Log slow requests
    if (responseTime > 5000) { // 5 seconds
      logger.warn('Slow request detected', {
        ...responseLog,
        slow: true,
        threshold: '5000ms',
      });
    }
    
    return originalEnd.call(this, chunk, encoding);
  };
  
  next();
};

// Sanitize request body to remove sensitive information
function sanitizeRequestBody(body: any): any {
  if (!body || typeof body !== 'object') {
    return {};
  }
  
  const sanitized = { ...body };
  
  // List of fields to remove or mask
  const sensitiveFields = [
    'password',
    'token',
    'secret',
    'key',
    'authorization',
    'auth',
    'deviceToken', // Don't log full device tokens
  ];
  
  const maskFields = [
    'email',
    'phone',
    'deviceToken',
  ];
  
  // Remove sensitive fields
  sensitiveFields.forEach(field => {
    if (sanitized[field]) {
      delete sanitized[field];
    }
  });
  
  // Mask fields (show only first few characters)
  maskFields.forEach(field => {
    if (sanitized[field] && typeof sanitized[field] === 'string') {
      const value = sanitized[field] as string;
      if (value.length > 6) {
        sanitized[field] = value.substring(0, 3) + '*'.repeat(value.length - 6) + value.substring(value.length - 3);
      } else {
        sanitized[field] = '*'.repeat(value.length);
      }
    }
  });
  
  // Handle nested objects recursively
  Object.keys(sanitized).forEach(key => {
    if (sanitized[key] && typeof sanitized[key] === 'object' && !Array.isArray(sanitized[key])) {
      sanitized[key] = sanitizeRequestBody(sanitized[key]);
    }
  });
  
  return sanitized;
}

// Middleware to log specific events
export const logEventMiddleware = (eventType: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    logger.info(`Event: ${eventType}`, {
      requestId: (req as any).requestId,
      userId: (req as any).userId,
      method: req.method,
      url: req.url,
      eventType,
    });
    next();
  };
};

// Middleware to skip logging for certain routes
export const skipLoggingFor = (paths: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const shouldSkip = paths.some(path => {
      if (path.endsWith('*')) {
        return req.path.startsWith(path.slice(0, -1));
      }
      return req.path === path;
    });
    
    if (shouldSkip) {
      (req as any).skipLogging = true;
    }
    
    next();
  };
};

// Enhanced logging for specific routes (like notifications)
export const enhancedLoggingMiddleware = (req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/notifications')) {
    // Log additional notification-specific details
    const enhancedLog = {
      requestId: (req as any).requestId,
      notificationAction: getNotificationAction(req),
      targetUserId: req.params.userId || req.body.userId,
      notificationId: req.params.id || req.body.notificationId,
    };
    
    logger.info('Notification API request', enhancedLog);
  }
  
  next();
};

function getNotificationAction(req: Request): string {
  const { method, path } = req;
  
  if (method === 'POST' && path.includes('/send')) {
    return 'send';
  } else if (method === 'POST' && path.includes('/schedule')) {
    return 'schedule';
  } else if (method === 'GET') {
    return 'retrieve';
  } else if (method === 'PUT' && path.includes('/read')) {
    return 'mark_read';
  } else if (method === 'DELETE') {
    return 'delete';
  }
  
  return 'unknown';
}

// Request correlation middleware (for distributed tracing)
export const correlationMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Check for existing correlation ID from upstream services
  const correlationId = req.get('X-Correlation-ID') || req.get('X-Request-ID') || (req as any).requestId;
  
  (req as any).correlationId = correlationId;
  res.set('X-Correlation-ID', correlationId);
  
  logger.info('Request correlation', {
    requestId: (req as any).requestId,
    correlationId,
    method: req.method,
    url: req.url,
  });
  
  next();
};