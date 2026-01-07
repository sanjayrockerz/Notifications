import mongoose from 'mongoose';
import { logger } from '../utils/logger';

/**
 * DatabasePool
 * 
 * Optimized database connection pooling for horizontal scaling:
 * - Connection pool sizing: (workers + API instances) × 5
 * - Handles connection lifecycle
 * - Monitors pool usage
 * - Auto-reconnect on failure
 */

export interface DatabasePoolConfig {
  uri: string;
  poolSize: number; // Max connections in pool
  serverSelectionTimeoutMS: number;
  socketTimeoutMS: number;
  maxIdleTimeMS: number;
  minPoolSize: number;
  maxPoolSize: number;
  waitQueueTimeoutMS: number;
}

export interface PoolStats {
  totalConnections: number;
  availableConnections: number;
  activeConnections: number;
  waitingRequests: number;
  poolSize: number;
}

export class DatabasePool {
  private config: DatabasePoolConfig;
  private isConnected = false;

  constructor(config?: Partial<DatabasePoolConfig>) {
    // Calculate optimal pool size: (workers + API instances) × 5
    // Default: 3 workers + 2 API instances = 25 connections
    const defaultPoolSize = parseInt(process.env.DB_POOL_SIZE || '25', 10);

    this.config = {
      uri: config?.uri || process.env.MONGODB_URI || 'mongodb://localhost:27017/notifications',
      poolSize: config?.poolSize || defaultPoolSize,
      serverSelectionTimeoutMS: config?.serverSelectionTimeoutMS || 5000,
      socketTimeoutMS: config?.socketTimeoutMS || 45000,
      maxIdleTimeMS: config?.maxIdleTimeMS || 30000,
      minPoolSize: config?.minPoolSize || 5,
      maxPoolSize: config?.maxPoolSize || defaultPoolSize,
      waitQueueTimeoutMS: config?.waitQueueTimeoutMS || 10000,
    };

    logger.info('🔧 DatabasePool configured:', {
      poolSize: this.config.poolSize,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
    });
  }

  /**
   * Connect to database with optimized pooling
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      logger.warn('⚠️ Database already connected');
      return;
    }

    try {
      await mongoose.connect(this.config.uri, {
        // Connection pool settings
        minPoolSize: this.config.minPoolSize,
        maxPoolSize: this.config.maxPoolSize,
        maxIdleTimeMS: this.config.maxIdleTimeMS,
        
        // Timeout settings
        serverSelectionTimeoutMS: this.config.serverSelectionTimeoutMS,
        socketTimeoutMS: this.config.socketTimeoutMS,
        waitQueueTimeoutMS: this.config.waitQueueTimeoutMS,
        
        // Connection settings
        retryWrites: true,
        retryReads: true,
        
        // Heartbeat
        heartbeatFrequencyMS: 10000,
        
        // Buffering (disabled for better error handling)
        bufferCommands: false,
        autoIndex: false, // Don't build indexes automatically
        
        // Connection string options
        w: 'majority',
        journal: true,
      });

      this.isConnected = true;

      // Connection event handlers
      mongoose.connection.on('connected', () => {
        logger.info('✅ MongoDB connected successfully');
      });

      mongoose.connection.on('error', (error) => {
        logger.error('❌ MongoDB connection error:', error);
      });

      mongoose.connection.on('disconnected', () => {
        logger.warn('⚠️ MongoDB disconnected');
        this.isConnected = false;
      });

      mongoose.connection.on('reconnected', () => {
        logger.info('🔄 MongoDB reconnected');
        this.isConnected = true;
      });

      // Log pool stats periodically
      this.startStatsMonitoring();

      logger.info('✅ Database connection pool initialized', {
        poolSize: this.config.maxPoolSize,
      });
    } catch (error) {
      logger.error('❌ Failed to connect to database:', error);
      this.isConnected = false;
      throw error;
    }
  }

  /**
   * Disconnect from database
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      logger.warn('⚠️ Database not connected');
      return;
    }

    try {
      await mongoose.connection.close();
      this.isConnected = false;
      logger.info('✅ Database disconnected');
    } catch (error) {
      logger.error('❌ Error disconnecting from database:', error);
      throw error;
    }
  }

  /**
   * Get current pool statistics
   */
  getStats(): PoolStats {
    const db = mongoose.connection.db;
    const client = mongoose.connection.getClient();

    // Get pool stats from MongoDB driver
    let poolStats: any = {};
    
    try {
      // Access internal connection pool stats
      if (client && (client as any).topology) {
        const topology = (client as any).topology;
        if (topology.s && topology.s.sessionPool) {
          const pool = topology.s.sessionPool;
          poolStats = {
            totalConnections: pool.totalConnectionCount || 0,
            availableConnections: pool.availableConnectionCount || 0,
            activeConnections: (pool.totalConnectionCount || 0) - (pool.availableConnectionCount || 0),
            waitingRequests: pool.waitQueueSize || 0,
            poolSize: this.config.maxPoolSize,
          };
        }
      }
    } catch (error) {
      logger.error('Error getting pool stats:', error);
    }

    return poolStats as PoolStats;
  }

  /**
   * Monitor pool usage
   */
  private startStatsMonitoring(): void {
    setInterval(() => {
      const stats = this.getStats();
      
      if (stats.totalConnections > 0) {
        const utilizationPercent = (stats.activeConnections / stats.poolSize) * 100;
        
        logger.info('📊 Database Pool Stats:', {
          totalConnections: stats.totalConnections,
          activeConnections: stats.activeConnections,
          availableConnections: stats.availableConnections,
          waitingRequests: stats.waitingRequests,
          utilization: `${utilizationPercent.toFixed(1)}%`,
        });

        // Warn if pool is heavily utilized
        if (utilizationPercent > 80) {
          logger.warn('⚠️ Database pool utilization > 80%, consider scaling');
        }

        // Warn if requests are waiting
        if (stats.waitingRequests > 0) {
          logger.warn(`⚠️ ${stats.waitingRequests} requests waiting for connections`);
        }
      }
    }, 60000); // Every minute
  }

  /**
   * Check if database is connected
   */
  isConnectionHealthy(): boolean {
    return this.isConnected && mongoose.connection.readyState === 1;
  }

  /**
   * Get connection health status
   */
  getHealth(): { healthy: boolean; message: string; stats?: PoolStats } {
    const readyState = mongoose.connection.readyState;
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    
    const healthy = readyState === 1; // 1 = connected
    const message = `Database ${states[readyState]}`;
    const stats = healthy ? this.getStats() : undefined;

    return { healthy, message, ...(stats && { stats }) };
  }

  /**
   * Calculate optimal pool size based on worker and API instance count
   */
  static calculateOptimalPoolSize(workerCount: number, apiInstances: number): number {
    // Formula: (workers + API instances) × 5
    // Add 20% buffer for spikes
    const baseSize = (workerCount + apiInstances) * 5;
    const withBuffer = Math.ceil(baseSize * 1.2);
    
    // Ensure minimum of 10 and maximum of 100
    return Math.max(10, Math.min(100, withBuffer));
  }

  /**
   * Update pool size dynamically (requires reconnection)
   */
  async updatePoolSize(newSize: number): Promise<void> {
    logger.info(`🔄 Updating pool size from ${this.config.maxPoolSize} to ${newSize}`);
    
    this.config.maxPoolSize = newSize;
    this.config.minPoolSize = Math.max(5, Math.floor(newSize / 5));
    
    // Note: Changing pool size requires reconnection
    logger.warn('⚠️ Pool size change requires database reconnection');
  }
}

// Export singleton instance
export const databasePool = new DatabasePool();

/**
 * Initialize database with optimal pooling
 */
export async function initializeDatabasePool(
  workerCount: number = 3,
  apiInstances: number = 2
): Promise<void> {
  const optimalPoolSize = DatabasePool.calculateOptimalPoolSize(workerCount, apiInstances);
  
  logger.info('🚀 Initializing database pool:', {
    workerCount,
    apiInstances,
    optimalPoolSize,
  });

  const pool = new DatabasePool({
    poolSize: optimalPoolSize,
    maxPoolSize: optimalPoolSize,
    minPoolSize: Math.max(5, Math.floor(optimalPoolSize / 5)),
  });

  await pool.connect();
  
  return;
}
