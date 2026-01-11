/**
 * Idempotency Service
 * 
 * Provides robust idempotency checking with Redis primary and MongoDB fallback.
 * Ensures exactly-once processing of notification events even during Redis outages.
 * 
 * IDEMPOTENCY KEY STRATEGY:
 * - For events: Use eventId directly (globally unique)
 * - For notification intents: Use composite key (eventType:actorId:targetId:resourceId)
 * 
 * STORAGE STRATEGY:
 * 1. Redis (primary): Fast checks with 7-day TTL
 * 2. MongoDB (fallback): Persistent storage when Redis unavailable
 * 3. In-memory (last resort): Process-local cache for immediate duplicates
 * 
 * DUAL-WRITE PATTERN:
 * When marking as processed, we write to BOTH Redis and MongoDB to ensure
 * durability. The MongoDB write is the source of truth.
 */

import { logger } from '../utils/logger';
import { RedisCache, isRedisConnected } from '../config/redis';
import { cacheCircuitBreaker } from '../utils/circuitBreaker';
import mongoose, { Schema, Document, Model } from 'mongoose';

// ============================================================================
// MongoDB Schema for Idempotency Records
// ============================================================================

export interface IIdempotencyRecord extends Document {
  idempotencyKey: string;
  eventId: string;
  eventType: string;
  notificationId?: string;
  userId?: string;
  processedAt: Date;
  expiresAt: Date;
  metadata?: Record<string, any>;
}

const IdempotencyRecordSchema = new Schema<IIdempotencyRecord>({
  idempotencyKey: { 
    type: String, 
    required: true, 
    unique: true,
    index: true,
  },
  eventId: { type: String, required: true, index: true },
  eventType: { type: String, required: true },
  notificationId: { type: String, sparse: true },
  userId: { type: String, sparse: true, index: true },
  processedAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  metadata: { type: Schema.Types.Mixed },
}, {
  collection: 'idempotency_records',
  timestamps: true,
});

// Compound index for efficient lookups
IdempotencyRecordSchema.index({ eventId: 1, eventType: 1 });

export const IdempotencyRecord: Model<IIdempotencyRecord> = mongoose.model<IIdempotencyRecord>(
  'IdempotencyRecord',
  IdempotencyRecordSchema
);

// ============================================================================
// Idempotency Key Generation
// ============================================================================

export interface IdempotencyKeyComponents {
  eventId: string;
  eventType: string;
  actorId?: string;
  targetId?: string;
  resourceId?: string;
}

/**
 * Generate a stable idempotency key for a notification intent.
 * 
 * The key is designed to be:
 * 1. Deterministic: Same event always produces same key
 * 2. Unique per intent: Different intents produce different keys
 * 3. Readable: Easy to debug and trace
 */
export function generateIdempotencyKey(components: IdempotencyKeyComponents): string {
  const { eventId, eventType, actorId, targetId, resourceId } = components;
  
  // If we have actor/target/resource, use intent-based key
  // This catches duplicates even if eventIds differ (e.g., retries with new IDs)
  if (actorId && targetId && resourceId) {
    return `intent:${eventType}:${actorId}:${targetId}:${resourceId}`;
  }
  
  // Fall back to event-based key
  return `event:${eventType}:${eventId}`;
}

// ============================================================================
// Idempotency Service
// ============================================================================

const REDIS_KEY_PREFIX = 'idempotency:';
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// In-memory cache for immediate duplicate detection (process-local)
const inMemoryCache = new Set<string>();
const MAX_MEMORY_CACHE_SIZE = 10000;

export class IdempotencyService {
  private static instance: IdempotencyService;
  
  private constructor() {}
  
  static getInstance(): IdempotencyService {
    if (!IdempotencyService.instance) {
      IdempotencyService.instance = new IdempotencyService();
    }
    return IdempotencyService.instance;
  }

  /**
   * Check if an event/intent has already been processed.
   * Uses Redis first, falls back to MongoDB if Redis is unavailable.
   */
  async isProcessed(idempotencyKey: string): Promise<boolean> {
    // 1. Check in-memory cache first (fastest)
    if (inMemoryCache.has(idempotencyKey)) {
      logger.debug('Idempotency check: found in memory cache', { idempotencyKey });
      return true;
    }

    // 2. Try Redis with circuit breaker
    try {
      const { result: redisResult, circuitOpen } = await cacheCircuitBreaker.execute(
        async () => {
          if (!isRedisConnected()) {
            throw new Error('Redis not connected');
          }
          return await RedisCache.exists(`${REDIS_KEY_PREFIX}${idempotencyKey}`);
        },
        () => null // Fallback returns null to indicate Redis unavailable
      );

      if (redisResult !== null && redisResult) {
        // Add to memory cache for fast subsequent checks
        this.addToMemoryCache(idempotencyKey);
        logger.debug('Idempotency check: found in Redis', { idempotencyKey, circuitOpen });
        return true;
      }

      if (!circuitOpen && redisResult === false) {
        // Redis responded with "not found", trust it
        return false;
      }
    } catch (error) {
      logger.warn('Redis idempotency check failed, falling back to MongoDB', {
        idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 3. Fall back to MongoDB
    try {
      const record = await IdempotencyRecord.findOne({ idempotencyKey }).lean();
      if (record) {
        // Found in MongoDB, add to memory cache
        this.addToMemoryCache(idempotencyKey);
        logger.debug('Idempotency check: found in MongoDB', { idempotencyKey });
        return true;
      }
      return false;
    } catch (error) {
      logger.error('MongoDB idempotency check failed', {
        idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      });
      // On complete failure, be conservative and allow processing
      // This prevents duplicate suppression from blocking all processing
      return false;
    }
  }

  /**
   * Mark an event/intent as processed.
   * Uses dual-write to both Redis and MongoDB for durability.
   */
  async markProcessed(
    idempotencyKey: string,
    data: {
      eventId: string;
      eventType: string;
      notificationId?: string;
      userId?: string;
      metadata?: Record<string, any>;
    }
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000);
    
    // Add to memory cache immediately
    this.addToMemoryCache(idempotencyKey);

    // Write to both Redis and MongoDB in parallel
    const redisPromise = this.writeToRedis(idempotencyKey, data, DEFAULT_TTL_SECONDS);
    const mongoPromise = this.writeToMongo(idempotencyKey, data, expiresAt);

    try {
      await Promise.allSettled([redisPromise, mongoPromise]);
      logger.debug('Marked as processed', { idempotencyKey, eventId: data.eventId });
    } catch (error) {
      logger.error('Error marking as processed', {
        idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Try to acquire a processing lock for an event.
   * Returns true if lock acquired, false if already being processed.
   * Uses Redis SETNX for distributed locking.
   */
  async tryAcquireLock(idempotencyKey: string, lockTtlSeconds: number = 30): Promise<boolean> {
    const lockKey = `${REDIS_KEY_PREFIX}lock:${idempotencyKey}`;
    
    try {
      const { result, circuitOpen } = await cacheCircuitBreaker.execute(
        async () => {
          if (!isRedisConnected()) {
            throw new Error('Redis not connected');
          }
          // Use SETNX with TTL for atomic lock acquisition
          const client = (await import('../config/redis')).getRedisClient();
          if (!client?.isOpen) return false;
          
          const acquired = await client.set(lockKey, Date.now().toString(), {
            NX: true,
            EX: lockTtlSeconds,
          });
          return acquired === 'OK';
        },
        () => true // Fail-open: allow processing if Redis unavailable
      );
      
      return result;
    } catch (error) {
      logger.warn('Lock acquisition failed, allowing processing', {
        idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return true; // Fail-open
    }
  }

  /**
   * Release a processing lock.
   */
  async releaseLock(idempotencyKey: string): Promise<void> {
    const lockKey = `${REDIS_KEY_PREFIX}lock:${idempotencyKey}`;
    
    try {
      await RedisCache.del(lockKey);
    } catch (error) {
      logger.warn('Lock release failed', {
        idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get idempotency statistics for monitoring.
   */
  async getStats(): Promise<{
    memoryCacheSize: number;
    mongoRecordCount: number;
    redisAvailable: boolean;
    circuitBreakerState: string;
  }> {
    let mongoRecordCount = 0;
    try {
      mongoRecordCount = await IdempotencyRecord.countDocuments();
    } catch (error) {
      logger.warn('Failed to get MongoDB record count');
    }

    return {
      memoryCacheSize: inMemoryCache.size,
      mongoRecordCount,
      redisAvailable: isRedisConnected(),
      circuitBreakerState: cacheCircuitBreaker.getState(),
    };
  }

  /**
   * Clear expired records (maintenance operation).
   * MongoDB TTL index handles this automatically, but this can be called for immediate cleanup.
   */
  async cleanupExpired(): Promise<number> {
    try {
      const result = await IdempotencyRecord.deleteMany({
        expiresAt: { $lt: new Date() },
      });
      logger.info('Cleaned up expired idempotency records', { count: result.deletedCount });
      return result.deletedCount;
    } catch (error) {
      logger.error('Error cleaning up expired records', { error });
      return 0;
    }
  }

  // Private helpers

  private addToMemoryCache(key: string): void {
    // Prevent unbounded growth
    if (inMemoryCache.size >= MAX_MEMORY_CACHE_SIZE) {
      // Remove oldest entries (simple approach: clear half)
      const entries = Array.from(inMemoryCache);
      entries.slice(0, Math.floor(MAX_MEMORY_CACHE_SIZE / 2)).forEach(k => inMemoryCache.delete(k));
    }
    inMemoryCache.add(key);
  }

  private async writeToRedis(
    idempotencyKey: string,
    data: Record<string, any>,
    ttlSeconds: number
  ): Promise<void> {
    try {
      const { circuitOpen } = await cacheCircuitBreaker.execute(
        async () => {
          if (!isRedisConnected()) {
            throw new Error('Redis not connected');
          }
          await RedisCache.set(
            `${REDIS_KEY_PREFIX}${idempotencyKey}`,
            JSON.stringify({ ...data, processedAt: new Date().toISOString() }),
            ttlSeconds
          );
        },
        () => {} // Fallback: do nothing (MongoDB will persist)
      );
      
      if (circuitOpen) {
        logger.debug('Skipped Redis write (circuit open)', { idempotencyKey });
      }
    } catch (error) {
      logger.warn('Failed to write to Redis', {
        idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async writeToMongo(
    idempotencyKey: string,
    data: {
      eventId: string;
      eventType: string;
      notificationId?: string;
      userId?: string;
      metadata?: Record<string, any>;
    },
    expiresAt: Date
  ): Promise<void> {
    try {
      await IdempotencyRecord.findOneAndUpdate(
        { idempotencyKey },
        {
          $setOnInsert: {
            idempotencyKey,
            eventId: data.eventId,
            eventType: data.eventType,
            notificationId: data.notificationId,
            userId: data.userId,
            processedAt: new Date(),
            expiresAt,
            metadata: data.metadata,
          },
        },
        { upsert: true }
      );
    } catch (error) {
      // Duplicate key error is expected if already processed
      if ((error as any).code !== 11000) {
        logger.error('Failed to write to MongoDB', {
          idempotencyKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

// Export singleton instance
export const idempotencyService = IdempotencyService.getInstance();
