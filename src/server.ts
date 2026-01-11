import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import dotenv from 'dotenv';
import { connectDatabase } from './config/database';
import { connectRedis } from './config/redis';
import { connectMessageQueue } from './config/messageQueue';
import { initializeFirebase } from './config/firebase';
import { initializeAPNs } from './config/apns';
import { setupRoutes } from './routes';
import { setupMiddleware } from './middleware';
import { errorHandler } from './middleware/errorHandler';
import { markInitializationComplete, markInitializationFailed } from './middleware/healthCheck';
import { logger } from './utils/logger';
import { NotificationService } from './services/NotificationService';
import { SchedulerService } from './services/SchedulerService';
import { CleanupService } from './services/CleanupService';

dotenv.config();

class NotificationServer {
  private app: express.Application;
  private port: number;
  private notificationService: NotificationService;
  private schedulerService: SchedulerService;
  private cleanupService: CleanupService;

  constructor() {
    this.app = express();
    this.port = parseInt(process.env.PORT || '3000', 10);
    this.notificationService = new NotificationService();
    this.schedulerService = new SchedulerService();
    this.cleanupService = new CleanupService();
  }

  async initialize(): Promise<void> {
    try {
      logger.info('🚀 Starting Notification Microservice...');

      // Initialize external connections
      await this.initializeConnections();

      // Setup middleware
      this.setupCoreMiddleware();
      await setupMiddleware(this.app);

      // Setup routes (including device token management)
      const { setupRoutes } = await import('./routes');
      setupRoutes(this.app);

      // Setup error handling
      this.app.use(errorHandler);

      // Initialize services
      await this.initializeServices();

      logger.info('✅ Notification Microservice initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize server:', error);
      throw error;
    }
  }

  private setupCoreMiddleware(): void {
    // Security middleware
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
    }));

    // CORS configuration
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    }));

    // Compression and parsing
    this.app.use(compression());
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Request logging
    this.app.use(morgan('combined', {
      stream: {
        write: (message: string) => logger.info(message.trim()),
      },
    }));
  }

  private async initializeConnections(): Promise<void> {
    const connections = [
      { name: 'Database', fn: connectDatabase },
      { name: 'Redis', fn: connectRedis },
      { name: 'Message Queue', fn: connectMessageQueue },
      { name: 'Firebase', fn: initializeFirebase },
      { name: 'APNs', fn: initializeAPNs },
    ];

    for (const { name, fn } of connections) {
      try {
        logger.info(`Connecting to ${name}...`);
        await fn();
        logger.info(`✅ ${name} connected successfully`);
      } catch (error) {
        logger.error(`❌ Failed to connect to ${name}:`, error);
        throw error;
      }
    }
  }

  private async initializeServices(): Promise<void> {
    try {
      logger.info('Initializing services...');
      
      await this.notificationService.initialize();
      await this.schedulerService.initialize();
      await this.cleanupService.initialize();

      logger.info('✅ All services initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize services:', error);
      throw error;
    }
  }

  async start(): Promise<void> {
    try {
      await this.initialize();
      
      // Mark initialization complete for startup probe
      markInitializationComplete();

      const server = this.app.listen(this.port, () => {
        logger.info(`🎯 Notification Service running on port ${this.port}`);
        logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
        logger.info(`🏥 Health check: http://localhost:${this.port}/health`);
        logger.info(`🏥 Liveness: http://localhost:${this.port}/health/live`);
        logger.info(`🏥 Readiness: http://localhost:${this.port}/health/ready`);
        logger.info(`🏥 Startup: http://localhost:${this.port}/health/startup`);
      });

      // Graceful shutdown handling
      const shutdown = async (signal: string) => {
        logger.info(`📨 Received ${signal}. Starting graceful shutdown...`);
        
        server.close(async () => {
          try {
            await this.notificationService.shutdown();
            await this.schedulerService.shutdown();
            await this.cleanupService.shutdown();
            
            logger.info('✅ Graceful shutdown completed');
            process.exit(0);
          } catch (error) {
            logger.error('❌ Error during shutdown:', error);
            process.exit(1);
          }
        });
      };

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));

    } catch (error) {
      // Mark initialization as failed for startup probe
      markInitializationFailed(error instanceof Error ? error : new Error(String(error)));
      logger.error('❌ Failed to start server:', error);
      process.exit(1);
    }
  }

  getApp(): express.Application {
    return this.app;
  }
}

// Start server if this file is run directly
if (require.main === module) {
  const server = new NotificationServer();
  server.start();
}

export default NotificationServer;