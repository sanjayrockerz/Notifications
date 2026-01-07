import { Application } from 'express';
import { rateLimitMiddleware } from './rateLimiting';
import { authMiddleware } from './auth';
import { requestLoggingMiddleware } from './requestLogging';
import { healthCheckMiddleware } from './healthCheck';
import { corsMiddleware } from './cors';

export async function setupMiddleware(app: Application): Promise<void> {
  // Security and CORS (already set in server.ts, but can be enhanced here)
  app.use(corsMiddleware);
  
  // Request logging and context
  app.use(requestLoggingMiddleware);
  
  // Rate limiting
  app.use(rateLimitMiddleware);
  
  // Health check (before auth to allow monitoring)
  app.use('/health', healthCheckMiddleware);
  
  // Authentication (for protected routes)
  app.use('/api', authMiddleware);
}

export { rateLimitMiddleware } from './rateLimiting';
export { authMiddleware } from './auth';
export { errorHandler } from './errorHandler';
export { requestLoggingMiddleware } from './requestLogging';
export { healthCheckMiddleware } from './healthCheck';
export { corsMiddleware } from './cors';