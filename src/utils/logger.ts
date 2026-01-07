import winston from 'winston';
import path from 'path';
import fs from 'fs';

// Ensure logs directory exists
const logsDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Custom format for structured logging
const customFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss.SSS',
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.prettyPrint()
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'HH:mm:ss.SSS',
  }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    let logMessage = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    
    if (Object.keys(meta).length > 0) {
      logMessage += ` ${JSON.stringify(meta, null, 2)}`;
    }
    
    return logMessage;
  })
);

// Create logger instance
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: customFormat,
  defaultMeta: {
    service: 'notification-service',
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    pid: process.pid,
  },
  transports: [
    // Console transport for development
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production' ? customFormat : consoleFormat,
      level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
    }),
    
    // File transport for all logs
    new winston.transports.File({
      filename: path.join(logsDir, 'app.log'),
      level: 'info',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true,
    }),
    
    // Error-only file
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 3,
      tailable: true,
    }),
    
    // Combined file for all levels
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      level: 'debug',
      maxsize: 50 * 1024 * 1024, // 50MB
      maxFiles: 10,
      tailable: true,
    }),
  ],
  
  // Handle uncaught exceptions
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, 'exceptions.log'),
    }),
  ],
  
  // Handle unhandled promise rejections
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, 'rejections.log'),
    }),
  ],
  
  // Exit on handled exceptions
  exitOnError: false,
});

// Add performance logging utilities
export class PerformanceLogger {
  private static timers: Map<string, number> = new Map();
  
  static startTimer(label: string): void {
    this.timers.set(label, Date.now());
  }
  
  static endTimer(label: string, metadata?: any): number {
    const startTime = this.timers.get(label);
    
    if (!startTime) {
      logger.warn(`Performance timer '${label}' not found`);
      return 0;
    }
    
    const duration = Date.now() - startTime;
    this.timers.delete(label);
    
    logger.info(`Performance: ${label}`, {
      duration: `${duration}ms`,
      ...metadata,
    });
    
    return duration;
  }
  
  static async timeAsync<T>(label: string, fn: () => Promise<T>, metadata?: any): Promise<T> {
    this.startTimer(label);
    try {
      const result = await fn();
      this.endTimer(label, { success: true, ...metadata });
      return result;
    } catch (error) {
      this.endTimer(label, { success: false, error: error, ...metadata });
      throw error;
    }
  }
}

// Structured logging helpers
export const logNotification = {
  sent: (notificationId: string, userId: string, deviceCount: number) => {
    logger.info('Notification sent', {
      event: 'notification.sent',
      notificationId,
      userId,
      deviceCount,
    });
  },
  
  failed: (notificationId: string, userId: string, error: string) => {
    logger.error('Notification failed', {
      event: 'notification.failed',
      notificationId,
      userId,
      error,
    });
  },
  
  delivered: (notificationId: string, userId: string, platform: string) => {
    logger.info('Notification delivered', {
      event: 'notification.delivered',
      notificationId,
      userId,
      platform,
    });
  },
  
  read: (notificationId: string, userId: string) => {
    logger.info('Notification read', {
      event: 'notification.read',
      notificationId,
      userId,
    });
  },
};

export const logDevice = {
  registered: (deviceId: string, userId: string, platform: string) => {
    logger.info('Device registered', {
      event: 'device.registered',
      deviceId,
      userId,
      platform,
    });
  },
  
  deactivated: (deviceId: string, userId: string, reason: string) => {
    logger.warn('Device deactivated', {
      event: 'device.deactivated',
      deviceId,
      userId,
      reason,
    });
  },
  
  failure: (deviceId: string, userId: string, error: string) => {
    logger.warn('Device delivery failure', {
      event: 'device.failure',
      deviceId,
      userId,
      error,
    });
  },
};

export const logEvent = {
  processed: (eventId: string, eventType: string, notificationId?: string) => {
    logger.info('Event processed', {
      event: 'event.processed',
      eventId,
      eventType,
      notificationId,
    });
  },
  
  failed: (eventId: string, eventType: string, error: string) => {
    logger.error('Event processing failed', {
      event: 'event.failed',
      eventId,
      eventType,
      error,
    });
  },
  
  retry: (eventId: string, eventType: string, attempt: number) => {
    logger.warn('Event retry attempt', {
      event: 'event.retry',
      eventId,
      eventType,
      attempt,
    });
  },
};

// Request ID generator for tracing
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Add request context to logger
export function createRequestLogger(requestId: string) {
  return logger.child({ requestId });
}

// Health check logging
export const logHealth = {
  check: (component: string, status: 'healthy' | 'unhealthy', details?: any) => {
    const logLevel = status === 'healthy' ? 'info' : 'error';
    logger.log(logLevel, `Health check: ${component}`, {
      event: 'health.check',
      component,
      status,
      ...details,
    });
  },
};

// Export logger as default
export default logger;