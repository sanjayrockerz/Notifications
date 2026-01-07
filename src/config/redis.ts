import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';

let redisClient: RedisClientType | null = null;

export const connectRedis = async (): Promise<void> => {
  if (redisClient?.isOpen) {
    logger.info('Redis already connected');
    return;
  }

  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    
    redisClient = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 5000,
      },
    });

    redisClient.on('error', (error) => {
      logger.error('❌ Redis connection error:', error);
    });

    redisClient.on('connect', () => {
      logger.info('🔗 Redis connecting...');
    });

    redisClient.on('ready', () => {
      logger.info('✅ Redis connected successfully');
    });

    redisClient.on('reconnecting', () => {
      logger.info('🔄 Redis reconnecting...');
    });

    redisClient.on('end', () => {
      logger.info('🔌 Redis connection ended');
    });

    await redisClient.connect();
    
  } catch (error) {
    logger.error('❌ Failed to connect to Redis:', error);
    throw error;
  }
};

export const disconnectRedis = async (): Promise<void> => {
  if (redisClient?.isOpen) {
    try {
      await redisClient.quit();
      logger.info('✅ Redis disconnected successfully');
    } catch (error) {
      logger.error('❌ Error disconnecting from Redis:', error);
      throw error;
    }
  }
};

export const getRedisClient = (): RedisClientType | null => redisClient;

export const isRedisConnected = (): boolean => redisClient?.isOpen ?? false;

// Redis utility functions
export class RedisCache {
  private static client = () => getRedisClient();

  static async get(key: string): Promise<string | null> {
    try {
      const client = this.client();
      if (!client?.isOpen) return null;
      return await client.get(key);
    } catch (error) {
      logger.error('❌ Redis GET error:', error);
      return null;
    }
  }

  static async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    try {
      const client = this.client();
      if (!client?.isOpen) return false;
      
      if (ttlSeconds) {
        await client.setEx(key, ttlSeconds, value);
      } else {
        await client.set(key, value);
      }
      return true;
    } catch (error) {
      logger.error('❌ Redis SET error:', error);
      return false;
    }
  }

  static async del(key: string): Promise<boolean> {
    try {
      const client = this.client();
      if (!client?.isOpen) return false;
      await client.del(key);
      return true;
    } catch (error) {
      logger.error('❌ Redis DEL error:', error);
      return false;
    }
  }

  static async exists(key: string): Promise<boolean> {
    try {
      const client = this.client();
      if (!client?.isOpen) return false;
      const exists = await client.exists(key);
      return exists === 1;
    } catch (error) {
      logger.error('❌ Redis EXISTS error:', error);
      return false;
    }
  }

  static async expire(key: string, seconds: number): Promise<boolean> {
    try {
      const client = this.client();
      if (!client?.isOpen) return false;
      await client.expire(key, seconds);
      return true;
    } catch (error) {
      logger.error('❌ Redis EXPIRE error:', error);
      return false;
    }
  }
}