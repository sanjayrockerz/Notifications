import cron from 'node-cron';
import { logger } from '../utils/logger';
import Notification, { INotification } from '../models/Notification';
import Device from '../models/Device';
import UserPreferences from '../models/UserPreferences';
import { PushNotificationService } from './PushNotificationService';
import { RedisCache } from '../config/redis';
import { archivingService, ArchivingStats } from './ArchivingService';

export class SchedulerService {
  private pushService: PushNotificationService;
  private scheduledJobs: Map<string, cron.ScheduledTask> = new Map();
  private isInitialized = false;
  private processingInterval?: NodeJS.Timeout;

  constructor() {
    this.pushService = new PushNotificationService();
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      await this.pushService.initialize();
      
      // Start scheduled notification processor (runs every minute)
      this.startScheduledProcessor();
      
      // Start retry processor (runs every 15 minutes)
      this.startRetryProcessor();

      // Start archiving processor (runs daily at 2 AM UTC)
      this.startArchivingProcessor();
      
      this.isInitialized = true;
      logger.info('✅ SchedulerService initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize SchedulerService:', error);
      throw error;
    }
  }

  private startScheduledProcessor(): void {
    // Run every minute to check for scheduled notifications
    const task = cron.schedule('* * * * *', async () => {
      await this.processScheduledNotifications();
    }, {
      scheduled: false,
      timezone: 'UTC',
    });
    
    task.start();
    this.scheduledJobs.set('scheduled-processor', task);
    logger.info('🕰️ Scheduled notification processor started');
  }

  private startRetryProcessor(): void {
    // Run every 15 minutes to retry failed notifications
    const task = cron.schedule('*/15 * * * *', async () => {
      await this.retryFailedNotifications();
    }, {
      scheduled: false,
      timezone: 'UTC',
    });
    
    task.start();
    this.scheduledJobs.set('retry-processor', task);
    logger.info('🔄 Retry processor started');
  }

  private startArchivingProcessor(): void {
    // Run daily at 2 AM UTC to archive old notifications
    const task = cron.schedule('0 2 * * *', async () => {
      await this.runArchiving();
    }, {
      scheduled: false,
      timezone: 'UTC',
    });
    
    task.start();
    this.scheduledJobs.set('archiving-processor', task);
    logger.info('🗄️ Archiving processor started (daily at 2 AM UTC)');
  }

  private async runArchiving(): Promise<void> {
    try {
      logger.info('🗄️ Starting daily archiving job');

      const stats: ArchivingStats = await archivingService.archiveOldNotifications();

      logger.info('✅ Daily archiving completed:', {
        notificationsArchived: stats.notificationsArchived,
        groupNotificationsArchived: stats.groupNotificationsArchived,
        durationMs: stats.durationMs,
        errors: stats.errors,
        batchesProcessed: stats.batchesProcessed,
      });

      // Get storage statistics
      const storageStats = await archivingService.getStatistics();
      logger.info('📊 Storage statistics:', storageStats);

    } catch (error) {
      logger.error('❌ Daily archiving failed:', error);
    }
  }

  private async processScheduledNotifications(): Promise<void> {
    try {
      const pendingNotifications = await Notification.findPendingScheduled();
      
      if (pendingNotifications.length === 0) {
        return;
      }
      
      logger.info(`📅 Processing ${pendingNotifications.length} scheduled notifications`);
      
      for (const notification of pendingNotifications) {
        await this.deliverScheduledNotification(notification);
      }
      
    } catch (error) {
      logger.error('❌ Error processing scheduled notifications:', error);
    }
  }

  private async deliverScheduledNotification(notification: INotification): Promise<void> {
    try {
      // Check if we're still in the valid delivery window
      if (notification.expiresAt && new Date() > notification.expiresAt) {
        logger.info(`⏰ Notification ${notification.notificationId} expired, cancelling`);
        notification.status = 'cancelled';
        await notification.save();
        return;
      }
      
      // Get user preferences to check if delivery is still allowed
      const preferences = await UserPreferences.findOrCreate(notification.userId);
      const deliveryCheck = preferences.shouldDeliverNotification(
        notification.category,
        notification.priority,
        notification.source,
        { title: notification.title, body: notification.body }
      );
      
      if (!deliveryCheck.shouldDeliver) {
        logger.info(`🚫 Scheduled notification ${notification.notificationId} blocked: ${deliveryCheck.reason}`);
        notification.status = 'cancelled';
        await notification.save();
        return;
      }
      
      // Get user's active devices
      const devices = await Device.findActiveByUser(notification.userId);
      
      if (devices.length === 0) {
        logger.warn(`⚠️ No active devices for scheduled notification ${notification.notificationId}`);
        notification.status = 'failed';
        await notification.save();
        return;
      }
      
      // Update notification status and delivery info
      notification.status = 'sent';
      notification.delivery.attempts += 1;
      notification.delivery.lastAttempt = new Date();
      notification.delivery.devices = devices.map(device => ({
        deviceId: device._id.toString(),
        platform: device.platform,
        status: 'pending',
      }));
      
      await notification.save();
      
      // Deliver to devices
      await this.deliverToDevices(notification, devices);
      
      logger.info(`✅ Delivered scheduled notification ${notification.notificationId}`);
      
    } catch (error) {
      logger.error(`❌ Error delivering scheduled notification ${notification.notificationId}:`, error);
      notification.status = 'failed';
      await notification.save();
    }
  }

  private async retryFailedNotifications(): Promise<void> {
    try {
      const maxAttempts = parseInt(process.env.NOTIFICATION_RETRY_ATTEMPTS || '3', 10);
      const failedNotifications = await Notification.findFailedForRetry(maxAttempts);
      
      if (failedNotifications.length === 0) {
        return;
      }
      
      logger.info(`🔄 Retrying ${failedNotifications.length} failed notifications`);
      
      for (const notification of failedNotifications) {
        await this.retryNotification(notification, maxAttempts);
      }
      
    } catch (error) {
      logger.error('❌ Error retrying failed notifications:', error);
    }
  }

  private async retryNotification(notification: INotification, maxAttempts: number): Promise<void> {
    try {
      // Check if notification has expired
      if (notification.expiresAt && new Date() > notification.expiresAt) {
        logger.info(`⏰ Failed notification ${notification.notificationId} expired, not retrying`);
        return;
      }
      
      // Get fresh device list (some may have been deactivated)
      const devices = await Device.findActiveByUser(notification.userId);
      
      if (devices.length === 0) {
        logger.warn(`⚠️ No active devices for retry of ${notification.notificationId}`);
        return;
      }
      
      // Update attempt counter
      notification.delivery.attempts += 1;
      notification.delivery.lastAttempt = new Date();
      notification.status = 'sent'; // Reset to sent for retry
      
      // Reset failed device statuses for retry
      notification.delivery.devices.forEach(device => {
        if (device.status === 'failed') {
          device.status = 'pending';
        }
      });
      
      await notification.save();
      
      // Retry delivery
      await this.deliverToDevices(notification, devices);
      
      logger.info(`🔄 Retried notification ${notification.notificationId} (attempt ${notification.delivery.attempts}/${maxAttempts})`);
      
    } catch (error) {
      logger.error(`❌ Error retrying notification ${notification.notificationId}:`, error);
    }
  }

  private async deliverToDevices(notification: INotification, devices: any[]): Promise<void> {
    try {
      const payload: any = {
        title: notification.title,
        body: notification.body,
        data: notification.data || {},
        priority: notification.priority,
      };
      
      if (notification.imageUrl) {
        payload.imageUrl = notification.imageUrl;
      }
      
      // Group devices by platform
      const androidDevices = devices.filter(d => d.platform === 'android');
      const iosDevices = devices.filter(d => d.platform === 'ios');
      
      const results = { successCount: 0, failureCount: 0 };
      
      // Send to Android devices
      if (androidDevices.length > 0) {
        const fcmResult = await this.pushService.sendToAndroidDevices(androidDevices, payload);
        results.successCount += fcmResult.successCount;
        results.failureCount += fcmResult.failureCount;
        
        // Update device statuses
        for (const result of fcmResult.results || []) {
          await notification.updateDeliveryStatus(
            result.deviceId,
            result.success ? 'sent' : 'failed',
            result.error,
            result.messageId
          );
        }
      }
      
      // Send to iOS devices
      if (iosDevices.length > 0) {
        const apnsResult = await this.pushService.sendToiOSDevices(iosDevices, payload);
        results.successCount += apnsResult.successCount;
        results.failureCount += apnsResult.failureCount;
        
        // Update device statuses
        for (const result of apnsResult.results || []) {
          await notification.updateDeliveryStatus(
            result.deviceId,
            result.success ? 'sent' : 'failed',
            result.error,
            result.messageId
          );
        }
      }
      
      // Update overall notification status
      if (results.successCount > 0) {
        notification.status = results.failureCount === 0 ? 'delivered' : 'sent';
      } else {
        notification.status = 'failed';
      }
      
      await notification.save();
      
      // Cache the updated notification
      await RedisCache.set(
        `notification:${notification.notificationId}`,
        JSON.stringify(notification),
        3600
      );
      
    } catch (error) {
      logger.error(`❌ Error delivering to devices for ${notification.notificationId}:`, error);
      notification.status = 'failed';
      await notification.save();
    }
  }

  async scheduleNotification(
    notification: INotification,
    scheduleAt: Date,
    timezone?: string
  ): Promise<void> {
    try {
      notification.scheduleAt = scheduleAt;
      notification.timezone = timezone || 'UTC';
      notification.status = 'scheduled';
      
      await notification.save();
      
      logger.info(`📅 Notification ${notification.notificationId} scheduled for ${scheduleAt}`);
    } catch (error) {
      logger.error(`❌ Error scheduling notification:`, error);
      throw error;
    }
  }

  async cancelScheduledNotification(notificationId: string): Promise<boolean> {
    try {
      const notification = await Notification.findOne({ 
        notificationId, 
        status: 'scheduled' 
      });
      
      if (!notification) {
        return false;
      }
      
      notification.status = 'cancelled';
      await notification.save();
      
      // Remove from cache
      await RedisCache.del(`notification:${notificationId}`);
      
      logger.info(`❌ Cancelled scheduled notification ${notificationId}`);
      return true;
    } catch (error) {
      logger.error(`❌ Error cancelling notification ${notificationId}:`, error);
      return false;
    }
  }

  async getScheduledNotifications(userId?: string): Promise<INotification[]> {
    try {
      const query: any = { status: 'scheduled' };
      if (userId) {
        query.userId = userId;
      }
      
      return await Notification.find(query)
        .sort({ scheduleAt: 1 })
        .limit(100);
    } catch (error) {
      logger.error('❌ Error getting scheduled notifications:', error);
      return [];
    }
  }

  async shutdown(): Promise<void> {
    try {
      // Stop all cron jobs
      for (const [name, task] of this.scheduledJobs) {
        task.stop();
        logger.info(`🛑 Stopped scheduled job: ${name}`);
      }
      
      this.scheduledJobs.clear();
      
      // Clear processing interval
      if (this.processingInterval) {
        clearInterval(this.processingInterval);
      }
      
      await this.pushService.shutdown();
      
      this.isInitialized = false;
      logger.info('✅ SchedulerService shut down successfully');
    } catch (error) {
      logger.error('❌ Error shutting down SchedulerService:', error);
      throw error;
    }
  }
}