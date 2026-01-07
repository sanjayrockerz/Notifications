import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
  code?: string;
  details?: any;
}

export class NotificationError extends Error implements AppError {
  public statusCode: number;
  public isOperational: boolean;
  public code: string;
  public details?: any;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    isOperational: boolean = true,
    details?: any
  ) {
    super(message);
    this.name = 'NotificationError';
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;
    this.details = details;

    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: AppError | Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Default error properties
  let statusCode = 500;
  let message = 'Internal Server Error';
  let code = 'INTERNAL_ERROR';
  let details: any = undefined;
  let isOperational = false;

  // Handle different error types
  if (err instanceof NotificationError) {
    statusCode = err.statusCode;
    message = err.message;
    code = err.code;
    details = err.details;
    isOperational = err.isOperational;
  } else if (err.name === 'ValidationError') {
    // Mongoose validation error
    statusCode = 400;
    message = 'Validation Error';
    code = 'VALIDATION_ERROR';
    details = Object.values((err as any).errors || {}).map((error: any) => ({
      field: error.path,
      message: error.message,
    }));
    isOperational = true;
  } else if (err.name === 'CastError') {
    // Mongoose cast error (invalid ObjectId, etc.)
    statusCode = 400;
    message = 'Invalid ID format';
    code = 'INVALID_ID';
    isOperational = true;
  } else if (err.name === 'MongoNetworkError') {
    // MongoDB connection error
    statusCode = 503;
    message = 'Database connection error';
    code = 'DATABASE_ERROR';
    isOperational = true;
  } else if (err.name === 'JsonWebTokenError') {
    // JWT error
    statusCode = 401;
    message = 'Invalid token';
    code = 'INVALID_TOKEN';
    isOperational = true;
  } else if (err.name === 'TokenExpiredError') {
    // JWT expired
    statusCode = 401;
    message = 'Token expired';
    code = 'TOKEN_EXPIRED';
    isOperational = true;
  } else if (err.name === 'SyntaxError' && 'body' in err) {
    // JSON parsing error
    statusCode = 400;
    message = 'Invalid JSON format';
    code = 'INVALID_JSON';
    isOperational = true;
  } else if ((err as any).code === 11000) {
    // MongoDB duplicate key error
    statusCode = 409;
    message = 'Resource already exists';
    code = 'DUPLICATE_RESOURCE';
    
    // Extract field from error
    const field = Object.keys((err as any).keyValue || {})[0] || 'unknown';
    details = { field, value: (err as any).keyValue?.[field] };
    isOperational = true;
  }

  // Log the error
  const errorLog = {
    message: err.message,
    stack: err.stack,
    statusCode,
    code,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    requestId: (req as any).requestId,
    userId: (req as any).userId,
    isOperational,
    details,
  };

  if (statusCode >= 500) {
    logger.error('Server error occurred:', errorLog);
  } else if (statusCode >= 400) {
    logger.warn('Client error occurred:', errorLog);
  }

  // Don't send stack traces in production
  const responseError: any = {
    success: false,
    error: message,
    code,
  };

  if (details) {
    responseError.details = details;
  }

  if (process.env.NODE_ENV !== 'production' && err.stack) {
    responseError.stack = err.stack;
  }

  // Add request ID for tracking
  if ((req as any).requestId) {
    responseError.requestId = (req as any).requestId;
  }

  res.status(statusCode).json(responseError);
};

// Async error wrapper
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Common error creators
export const createError = {
  badRequest: (message: string, details?: any) => 
    new NotificationError(message, 400, 'BAD_REQUEST', true, details),
    
  unauthorized: (message: string = 'Unauthorized') => 
    new NotificationError(message, 401, 'UNAUTHORIZED', true),
    
  forbidden: (message: string = 'Forbidden') => 
    new NotificationError(message, 403, 'FORBIDDEN', true),
    
  notFound: (resource: string = 'Resource') => 
    new NotificationError(`${resource} not found`, 404, 'NOT_FOUND', true),
    
  conflict: (message: string, details?: any) => 
    new NotificationError(message, 409, 'CONFLICT', true, details),
    
  tooManyRequests: (message: string = 'Too many requests') => 
    new NotificationError(message, 429, 'TOO_MANY_REQUESTS', true),
    
  internal: (message: string = 'Internal server error', details?: any) => 
    new NotificationError(message, 500, 'INTERNAL_ERROR', false, details),
    
  serviceUnavailable: (message: string = 'Service temporarily unavailable') => 
    new NotificationError(message, 503, 'SERVICE_UNAVAILABLE', true),
};

// 404 handler for undefined routes
export const notFoundHandler = (req: Request, res: Response, next: NextFunction) => {
  const error = createError.notFound(`Route ${req.method} ${req.path}`);
  next(error);
};