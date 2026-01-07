import admin from 'firebase-admin';
import cron from 'node-cron';
import { logger } from '../utils/logger';
import Device from '../models/Device';
import Notification from '../models/Notification';
import { RedisCache } from '../config/redis';

export class CleanupService {
  private scheduledJobs: Map<string, cron.ScheduledTask> = new Map();
  private isInitialized = false;

  async weeklyTokenValidation(): Promise<void> {
    const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - ONE_WEEK);
    const tokens = await Device.find({ lastSeen: { $lt: cutoff }, isActive: true });
    logger.info(`Weekly token validation: ${tokens.length} tokens to check`);
    let invalidCount = 0;
    for (const device of tokens) {
      try {
        const res = await admin.messaging().send({
          token: device.fcmToken,
          android: { priority: 'normal' },
          data: { ping: '1' },
        }, true);
      } catch (err: any) {
        if (err.code === 'messaging/registration-token-not-registered' || err.code === 'messaging/invalid-registration-token') {
          await Device.updateOne({ _id: device._id }, { $set: { isActive: false } });
          logger.info(`Marked device as inactive due to invalid token: ${device.deviceToken}`);
          invalidCount++;
        } else if (err.code === 'messaging/quota-exceeded') {
          logger.warn('FCM rate limit hit, backing off');
          await new Promise(r => setTimeout(r, 60000)); // 1 min backoff
        } else {
          logger.error('Error sending test message to device', { deviceId: device.deviceToken, error: err });
        }
      }
    }
    if (tokens.length > 0 && invalidCount / tokens.length > 0.1) {
      logger.warn(`High invalid-token rate: ${(invalidCount / tokens.length * 100).toFixed(2)}%`);
      // TODO: Alert ops team
    }
  }

  async monthlyHardCleanup(): Promise<void> {
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - THIRTY_DAYS);
    const result = await Device.deleteMany({ isActive: false, updatedAt: { $lt: cutoff } });
    logger.info(`Monthly hard cleanup: deleted ${result.deletedCount} inactive device tokens`);
  }

  async manualRefresh(userId: string): Promise<void> {
    const tokens = await Device.find({ userId, isActive: true });
    logger.info(`Manual token refresh for user ${userId}: ${tokens.length} tokens`);
    for (const device of tokens) {
      try {
        await admin.messaging().send({
          token: device.fcmToken,
          android: { priority: 'normal' },
          data: { ping: '1' },
        }, true);
      } catch (err: any) {
        if (err.code === 'messaging/registration-token-not-registered' || err.code === 'messaging/invalid-registration-token') {
          await Device.updateOne({ _id: device._id }, { $set: { isActive: false } });
          logger.info(`Marked device as inactive due to invalid token: ${device.deviceToken}`);
        } else if (err.code === 'messaging/quota-exceeded') {
          logger.warn('FCM rate limit hit, backing off');
          await new Promise(r => setTimeout(r, 60000));
        } else {
          logger.error('Error sending test message to device', { deviceId: device.deviceToken, error: err });
        }
      }
    }
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Start cleanup jobs
      this.startDeviceCleanup();
      this.startNotificationCleanup();
      this.startCacheCleanup();
      
      this.isInitialized = true;
      logger.info('✅ CleanupService initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize CleanupService:', error);
      throw error;
    }
  }

  private startDeviceCleanup(): void {
    // Run daily at 2 AM UTC to cleanup inactive devices
    const task = cron.schedule('0 2 * * *', async () => {
      await this.cleanupInactiveDevices();
    }, {
      scheduled: false,
      timezone: 'UTC',
    });
    
    task.start();
    this.scheduledJobs.set('device-cleanup', task);
    logger.info('🧼 Daily device cleanup scheduled');
  }

  private startNotificationCleanup(): void {
    // Run daily at 3 AM UTC to cleanup old notifications
    const task = cron.schedule('0 3 * * *', async () => {
      await this.cleanupOldNotifications();
    }, {
      scheduled: false,
      timezone: 'UTC',
    });
    
    task.start();
    this.scheduledJobs.set('notification-cleanup', task);
    logger.info('🧼 Daily notification cleanup scheduled');
  }

  private startCacheCleanup(): void {
    // Run every 4 hours to cleanup expired cache entries
    const task = cron.schedule('0 */4 * * *', async () => {
      await this.cleanupExpiredCache();
    }, {
      scheduled: false,
      timezone: 'UTC',
    });
    
    task.start();
    this.scheduledJobs.set('cache-cleanup', task);
    logger.info('🧼 Cache cleanup scheduled every 4 hours');
  }

  private async cleanupInactiveDevices(): Promise<void> {
    try {
      logger.info('🧼 Starting inactive device cleanup...');
      
      const inactiveDays = parseInt(process.env.DEVICE_TOKEN_CLEANUP_DAYS || '30', 10);
      const result = await Device.cleanupInactive(inactiveDays);
      
      logger.info(`✅ Cleaned up ${result.deletedCount} inactive devices`);
      
      // Also deactivate devices with high failure counts
      const highFailureDevices = await Device.updateMany(
        { 
          failureCount: { $gte: 10 },
          isActive: true
        },
        { 
          isActive: false,
          lastFailure: new Date()
        }
      );
      
      if (highFailureDevices.modifiedCount > 0) {
        logger.info(`⚠️ Deactivated ${highFailureDevices.modifiedCount} devices with high failure counts`);
      }
      
    } catch (error) {
      logger.error('❌ Error cleaning up inactive devices:', error);
    }
  }

  private async cleanupOldNotifications(): Promise<void> {
    try {
      logger.info('🧼 Starting old notification cleanup...');
      
      const retentionDays = parseInt(process.env.NOTIFICATION_RETENTION_DAYS || '30', 10);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
      
      // Delete old notifications that are delivered or failed
      const deleteResult = await Notification.deleteMany({
        createdAt: { $lt: cutoffDate },
        status: { $in: ['delivered', 'failed', 'cancelled'] },
      });
      
      logger.info(`✅ Cleaned up ${deleteResult.deletedCount} old notifications`);
      
      // Archive important notifications instead of deleting
      const archiveResult = await Notification.updateMany(
        {
          createdAt: { $lt: cutoffDate },
          status: { $in: ['delivered'] },
          priority: { $in: ['high', 'critical'] },
        },
        {
          $set: { 
            archived: true,
            archivedAt: new Date()
          }
        }
      );
      
      if (archiveResult.modifiedCount > 0) {
        logger.info(`🗄️ Archived ${archiveResult.modifiedCount} important notifications`);
      }
      
      // Clean up expired scheduled notifications
      const expiredScheduled = await Notification.updateMany(
        {
          status: 'scheduled',
          expiresAt: { $lt: new Date() }
        },
        {
          status: 'cancelled'
        }
      );
      
      if (expiredScheduled.modifiedCount > 0) {
        logger.info(`⏰ Cancelled ${expiredScheduled.modifiedCount} expired scheduled notifications`);
      }
      
    } catch (error) {
      logger.error('❌ Error cleaning up old notifications:', error);
    }
  }

  private async cleanupExpiredCache(): Promise<void> {
    try {
      logger.info('🧼 Starting cache cleanup...');
      
      // Redis handles TTL automatically, but we can clean up specific patterns
      // This is more of a maintenance check
      
      const redisClient = await import('../config/redis').then(m => m.getRedisClient());
      
      if (!redisClient?.isOpen) {
        logger.warn('⚠️ Redis client not available for cache cleanup');
        return;
      }
      
      // Get all notification cache keys
      const notificationKeys = await redisClient.keys('notification:*');
      let expiredCount = 0;
      
      for (const key of notificationKeys) {
        try {
          const ttl = await redisClient.ttl(key);
          
          // If TTL is -1 (no expiry) and key is old, remove it
          if (ttl === -1) {
            const value = await redisClient.get(key);
            if (value) {
              const data = JSON.parse(value);
              const createdAt = new Date(data.createdAt || data.timestamp);
              const hoursSinceCreated = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
              
              // Remove cached notifications older than 24 hours
              if (hoursSinceCreated > 24) {
                await redisClient.del(key);
                expiredCount++;
              }
            }
          }
        } catch (keyError) {
          // If we can't process a key, just log and continue
          logger.warn(`⚠️ Error processing cache key ${key}:`, keyError);
        }
      }
      
      if (expiredCount > 0) {
        logger.info(`✅ Cleaned up ${expiredCount} expired cache entries`);
      }
      
      // Clean up device cache keys
      const deviceKeys = await redisClient.keys('device:*');
      let deviceCacheCount = 0;
      
      for (const key of deviceKeys) {
        try {
          const ttl = await redisClient.ttl(key);
          if (ttl === -1) {
            await redisClient.expire(key, 3600); // Set 1-hour expiry
            deviceCacheCount++;
          }
        } catch (keyError) {
          logger.warn(`⚠️ Error processing device cache key ${key}:`, keyError);
        }
      }
      
      if (deviceCacheCount > 0) {
        logger.info(`🔄 Added expiry to ${deviceCacheCount} device cache entries`);
      }
      
    } catch (error) {
      logger.error('❌ Error cleaning up cache:', error);
    }
  }

  async getCleanupStats(): Promise<{
    inactiveDevices: number;
    oldNotifications: number;
    scheduledNotifications: number;
    cacheKeys: number;
  }> {
    try {
      const inactiveDays = parseInt(process.env.DEVICE_TOKEN_CLEANUP_DAYS || '30', 10);
      const retentionDays = parseInt(process.env.NOTIFICATION_RETENTION_DAYS || '30', 10);
      
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - inactiveDays);
      
      const retentionCutoff = new Date();
      retentionCutoff.setDate(retentionCutoff.getDate() - retentionDays);
      
      const [inactiveDevices, oldNotifications, scheduledNotifications] = await Promise.all([
        Device.countDocuments({
          $or: [
            { lastSeen: { $lt: cutoffDate } },
            { isActive: false, lastFailure: { $lt: cutoffDate } },
          ],
        }),
        
        Notification.countDocuments({
          createdAt: { $lt: retentionCutoff },
          status: { $in: ['delivered', 'failed', 'cancelled'] },
        }),
        
        Notification.countDocuments({
          status: 'scheduled',
        }),
      ]);
      
      let cacheKeys = 0;
      try {
        const redisClient = await import('../config/redis').then(m => m.getRedisClient());
        if (redisClient?.isOpen) {
          const keys = await redisClient.keys('notification:*');
          cacheKeys = keys.length;
        }
      } catch (error) {
        logger.warn('⚠️ Could not count cache keys:', error);
      }
      
      return {
        inactiveDevices,
        oldNotifications,
        scheduledNotifications,
        cacheKeys,
      };
    } catch (error) {
      logger.error('❌ Error getting cleanup stats:', error);
      return {
        inactiveDevices: 0,
        oldNotifications: 0,
        scheduledNotifications: 0,
        cacheKeys: 0,
      };
    }
  }

  async forceCleanup(): Promise<void> {
    logger.info('🧼 Starting manual cleanup...');
    
    await Promise.all([
      this.cleanupInactiveDevices(),
      this.cleanupOldNotifications(),
      this.cleanupExpiredCache(),
    ]);
    
    logger.info('✅ Manual cleanup completed');
  }

  async shutdown(): Promise<void> {
    try {
      // Stop all cron jobs
      for (const [name, task] of this.scheduledJobs) {
        task.stop();
        logger.info(`🛑 Stopped cleanup job: ${name}`);
      }
      
      this.scheduledJobs.clear();
      this.isInitialized = false;
      
      logger.info('✅ CleanupService shut down successfully');
    } catch (error) {
      logger.error('❌ Error shutting down CleanupService:', error);
      throw error;
    }
  }
}