import mongoose from 'mongoose';
import { logger } from '../utils/logger';

/**
 * Database Connection Pooling Configuration
 * 
 * Optimized for horizontal scaling with multiple workers:
 * - Pool size: (num_workers + num_api_instances) × 5
 * - Default: 25 connections (assumes 5 workers/instances)
 * - Min pool: 10 connections (always available)
 * - Max pool: 50 connections (prevents overload)
 * 
 * Connection lifecycle:
 * - Auto-reconnect on failure
 * - Connection health checks every 30s
 * - Idle timeout: 60s
 * - Server selection timeout: 5s
 */

export interface ConnectionPoolConfig {
  uri: string;
  poolSize: number;
  minPoolSize: number;
  maxPoolSize: number;
  serverSelectionTimeoutMS: number;
  socketTimeoutMS: number;
  connectTimeoutMS: number;
  heartbeatFrequencyMS: number;
  retryWrites: boolean;
  retryReads: boolean;
  maxIdleTimeMS: number;
}

export class DatabaseConnectionPool {
  private config: ConnectionPoolConfig;
  private isConnected = false;
  private connectionAttempts = 0;
  private maxConnectionAttempts = 5;
  private reconnectDelay = 5000; // 5 seconds

  constructor(config?: Partial<ConnectionPoolConfig>) {
    const numWorkers = parseInt(process.env.NUM_WORKERS || '5', 10);
    const numApiInstances = parseInt(process.env.NUM_API_INSTANCES || '0', 10);
    const calculatedPoolSize = (numWorkers + numApiInstances) * 5;

    this.config = {
      uri: config?.uri || process.env.MONGODB_URI || 'mongodb://localhost:27017/notifications',
      poolSize: config?.poolSize || calculatedPoolSize || 25,
      minPoolSize: config?.minPoolSize || 10,
      maxPoolSize: config?.maxPoolSize || 50,
      serverSelectionTimeoutMS: config?.serverSelectionTimeoutMS || 5000,
      socketTimeoutMS: config?.socketTimeoutMS || 45000,
      connectTimeoutMS: config?.connectTimeoutMS || 10000,
      heartbeatFrequencyMS: config?.heartbeatFrequencyMS || 30000,
      retryWrites: config?.retryWrites !== false,
      retryReads: config?.retryReads !== false,
      maxIdleTimeMS: config?.maxIdleTimeMS || 60000,
    };

    logger.info('📊 Connection pool configuration:', {
      poolSize: this.config.poolSize,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
      numWorkers,
      numApiInstances,
    });
  }

  /**
   * Initialize database connection with pooling
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      logger.warn('⚠️ Database already connected');
      return;
    }

    try {
      this.connectionAttempts++;

      logger.info(`🔌 Connecting to MongoDB (attempt ${this.connectionAttempts}/${this.maxConnectionAttempts})...`);

      await mongoose.connect(this.config.uri, {
        maxPoolSize: this.config.maxPoolSize,
        minPoolSize: this.config.minPoolSize,
        serverSelectionTimeoutMS: this.config.serverSelectionTimeoutMS,
        socketTimeoutMS: this.config.socketTimeoutMS,
        connectTimeoutMS: this.config.connectTimeoutMS,
        heartbeatFrequencyMS: this.config.heartbeatFrequencyMS,
        retryWrites: this.config.retryWrites,
        retryReads: this.config.retryReads,
        maxIdleTimeMS: this.config.maxIdleTimeMS,
      });

      this.isConnected = true;
      this.connectionAttempts = 0;

      logger.info('✅ MongoDB connected with connection pooling', {
        host: mongoose.connection.host,
        database: mongoose.connection.name,
        poolSize: this.config.poolSize,
      });

      // Setup connection event listeners
      this.setupEventListeners();

    } catch (error) {
      logger.error('❌ MongoDB connection failed:', error);

      if (this.connectionAttempts < this.maxConnectionAttempts) {
        logger.info(`🔄 Retrying connection in ${this.reconnectDelay / 1000}s...`);
        await this.delay(this.reconnectDelay);
        return this.connect();
      } else {
        logger.error('❌ Max connection attempts reached, giving up');
        throw error;
      }
    }
  }

  /**
   * Setup event listeners for connection monitoring
   */
  private setupEventListeners(): void {
    mongoose.connection.on('connected', () => {
      logger.info('📡 MongoDB connected');
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('⚠️ MongoDB disconnected');
      this.isConnected = false;

      // Auto-reconnect
      if (this.connectionAttempts < this.maxConnectionAttempts) {
        logger.info('🔄 Attempting to reconnect...');
        this.connect().catch((err) => {
          logger.error('❌ Reconnection failed:', err);
        });
      }
    });

    mongoose.connection.on('error', (error) => {
      logger.error('❌ MongoDB connection error:', error);
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('✅ MongoDB reconnected');
      this.isConnected = true;
      this.connectionAttempts = 0;
    });

    // Log pool statistics periodically
    setInterval(() => {
      this.logPoolStats();
    }, 60000); // Every minute
  }

  /**
   * Get connection pool statistics
   */
  getPoolStats(): {
    isConnected: boolean;
    readyState: number;
    host?: string;
    database?: string;
    maxPoolSize: number;
    minPoolSize: number;
  } {
    return {
      isConnected: this.isConnected,
      readyState: mongoose.connection.readyState,
      host: mongoose.connection.host,
      database: mongoose.connection.name,
      maxPoolSize: this.config.maxPoolSize,
      minPoolSize: this.config.minPoolSize,
    };
  }

  /**
   * Log pool statistics
   */
  private logPoolStats(): void {
    const stats = this.getPoolStats();
    
    logger.debug('📊 Connection pool stats:', {
      isConnected: stats.isConnected,
      readyState: this.getReadyStateString(stats.readyState),
      host: stats.host,
      database: stats.database,
      maxPoolSize: stats.maxPoolSize,
      minPoolSize: stats.minPoolSize,
    });
  }

  /**
   * Get human-readable ready state string
   */
  private getReadyStateString(state: number): string {
    const states: Record<number, string> = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting',
    };
    return states[state] || 'unknown';
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.isConnected || !mongoose.connection.db) {
        return false;
      }

      // Ping database
      await mongoose.connection.db.admin().ping();
      return true;
    } catch (error) {
      logger.error('❌ Health check failed:', error);
      return false;
    }
  }

  /**
   * Disconnect from database
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await mongoose.disconnect();
      this.isConnected = false;
      logger.info('✅ MongoDB disconnected gracefully');
    } catch (error) {
      logger.error('❌ Error disconnecting from MongoDB:', error);
      throw error;
    }
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const connectionPool = new DatabaseConnectionPool();
