import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import Device, { IDevice } from '../models/Device';
import Notification, { INotification } from '../models/Notification';
import UserPreferences, { IUserPreferences } from '../models/UserPreferences';
import { PushNotificationService } from './PushNotificationService';
import { MessageQueue } from '../config/messageQueue';
import { RedisCache } from '../config/redis';

export interface SendNotificationRequest {
  userId: string;
  title: string;
  body: string;
  category: string;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  data?: Record<string, any>;
  imageUrl?: string;
  iconUrl?: string;
  scheduleAt?: Date;
  timezone?: string;
  tags?: string[];
  source: string;
  campaign?: string;
  metadata?: Record<string, any>;
}

export interface NotificationResponse {
  notificationId: string;
  status: 'success' | 'partial' | 'failed';
  message: string;
  deliveryDetails: {
    totalDevices: number;
    successCount: number;
    failureCount: number;
    errors?: string[];
  };
}

export class NotificationService {
  private pushService: PushNotificationService;
  private isInitialized = false;

  constructor() {
    this.pushService = new PushNotificationService();
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      await this.pushService.initialize();
      
      // Start consuming notification queue
      await this.startMessageConsumer();
      
      this.isInitialized = true;
      logger.info('✅ NotificationService initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize NotificationService:', error);
      throw error;
    }
  }

  async sendNotification(request: SendNotificationRequest): Promise<NotificationResponse> {
    const notificationId = uuidv4();
    logger.info(`📤 Sending notification ${notificationId} to user ${request.userId}`);

    try {
      // Extract resourceId from metadata for idempotency checking
      const resourceId = request.metadata?.resourceId || request.metadata?.followerId || 
                         request.metadata?.postId || request.metadata?.commentId;

      // Check for duplicate notification (idempotency)
      if (resourceId) {
        const duplicate = await (Notification as any).findDuplicate(
          request.userId,
          request.category,
          resourceId
        );

        if (duplicate) {
          logger.info(`🔄 Duplicate notification detected, skipping`, {
            notificationId: duplicate.notificationId,
            userId: request.userId,
            category: request.category,
            resourceId,
          });

          return {
            notificationId: duplicate.notificationId,
            status: 'success',
            message: 'Notification already exists (idempotent)',
            deliveryDetails: {
              totalDevices: duplicate.delivery.devices.length,
              successCount: duplicate.delivery.devices.filter((d: any) => d.status === 'delivered').length,
              failureCount: duplicate.delivery.devices.filter((d: any) => d.status === 'failed').length,
            },
          };
        }
      }

      // Get user preferences
      const preferences: IUserPreferences = await (UserPreferences as any).findOrCreate(request.userId);
      
      // Check if notification should be delivered
      const deliveryCheck = (preferences as any).shouldDeliverNotification(
        request.category,
        request.priority || 'normal',
        request.source,
        { title: request.title, body: request.body }
      );

      if (!deliveryCheck.shouldDeliver) {
        logger.info(`🚫 Notification blocked: ${deliveryCheck.reason}`);
        return {
          notificationId,
          status: 'failed',
          message: `Notification blocked: ${deliveryCheck.reason}`,
          deliveryDetails: {
            totalDevices: 0,
            successCount: 0,
            failureCount: 0,
          },
        };
      }

      // Get user's active devices
      const devices: IDevice[] = await (Device as any).findActiveByUser(request.userId);
      
      if (devices.length === 0) {
        logger.warn(`⚠️ No active devices found for user ${request.userId}`);
        return {
          notificationId,
          status: 'failed',
          message: 'No active devices found for user',
          deliveryDetails: {
            totalDevices: 0,
            successCount: 0,
            failureCount: 0,
          },
        };
      }

      // Create notification record
      const notification: INotification = new Notification({
        notificationId,
        userId: request.userId,
        title: request.title,
        body: request.body,
        category: request.category,
        priority: request.priority || 'normal',
        data: request.data || {},
        imageUrl: request.imageUrl,
        iconUrl: request.iconUrl,
        scheduleAt: request.scheduleAt,
        timezone: request.timezone,
        tags: request.tags || [],
        source: request.source,
        campaign: request.campaign,
        metadata: request.metadata || {},
        resourceId, // Store for idempotency
        status: request.scheduleAt ? 'scheduled' : 'pending',
        delivery: {
          attempts: 0,
          devices: devices.map((device: IDevice) => ({
            deviceId: device._id.toString(),
            platform: device.platform,
            status: 'pending',
          })),
        },
        // Set expiry based on priority
        expiresAt: this.getExpiryDate(request.priority || 'normal'),
      });

      try {
        await notification.save();
        logger.info(`💾 Notification record created: ${notificationId}`);
      } catch (saveError: any) {
        // Handle duplicate key error gracefully (race condition)
        if (saveError.code === 11000) {
          logger.warn(`⚠️ Duplicate notification caught during save (race condition)`, {
            notificationId,
            userId: request.userId,
            category: request.category,
            resourceId,
          });

          // Find and return the existing notification
          const existing = await (Notification as any).findDuplicate(
            request.userId,
            request.category,
            resourceId
          );

          if (existing) {
            return {
              notificationId: existing.notificationId,
              status: 'success',
              message: 'Notification already exists (duplicate key caught)',
              deliveryDetails: {
                totalDevices: existing.delivery.devices.length,
                successCount: existing.delivery.devices.filter((d: any) => d.status === 'delivered').length,
                failureCount: existing.delivery.devices.filter((d: any) => d.status === 'failed').length,
              },
            };
          }
        }
        throw saveError;
      }

      // If scheduled, don't send immediately
      if (request.scheduleAt) {
        logger.info(`⏰ Notification scheduled for ${request.scheduleAt}`);
        return {
          notificationId,
          status: 'success',
          message: 'Notification scheduled successfully',
          deliveryDetails: {
            totalDevices: devices.length,
            successCount: devices.length,
            failureCount: 0,
          },
        };
      }

      // Send immediately
      const deliveryResult = await this.deliverNotification(notification, devices, preferences);
      
      return {
        notificationId,
        status: deliveryResult.successCount > 0 ? 'success' : 'failed',
        message: deliveryResult.successCount > 0 ? 'Notification sent successfully' : 'Failed to send notification',
        deliveryDetails: deliveryResult,
      };

    } catch (error) {
      logger.error(`❌ Error sending notification ${notificationId}:`, error);
      throw error;
    }
  }

  private async deliverNotification(
    notification: INotification,
    devices: IDevice[],
    preferences: IUserPreferences
  ): Promise<{ totalDevices: number; successCount: number; failureCount: number; errors?: string[] }> {
    const results = {
      totalDevices: devices.length,
      successCount: 0,
      failureCount: 0,
      errors: [] as string[],
    };

    notification.delivery.attempts += 1;
    notification.delivery.lastAttempt = new Date();
    notification.status = 'sent';

    // Group devices by platform for batch sending
    const androidDevices = devices.filter(d => d.platform === 'android');
    const iosDevices = devices.filter(d => d.platform === 'ios');

    // Send to Android devices (FCM)
    if (androidDevices.length > 0) {
      try {
        const fcmResult = await this.pushService.sendToAndroidDevices(
          androidDevices,
          {
            title: notification.title,
            body: notification.body,
            data: notification.data || {},
            imageUrl: notification.imageUrl || '',
            priority: notification.priority,
          }
        );

        results.successCount += fcmResult.successCount;
        results.failureCount += fcmResult.failureCount;
        if (fcmResult.errors) results.errors.push(...fcmResult.errors);

        // Update device delivery status
        for (const result of fcmResult.results || []) {
          await (notification as any).updateDeliveryStatus(
            result.deviceId,
            result.success ? 'sent' : 'failed',
            result.error,
            result.messageId
          );
        }
      } catch (error) {
        logger.error('Error sending FCM notifications:', error);
        results.failureCount += androidDevices.length;
        results.errors.push(`FCM error: ${error}`);
      }
    }

    // Send to iOS devices (APNs)
    if (iosDevices.length > 0) {
      try {
        const apnsResult = await this.pushService.sendToiOSDevices(
          iosDevices,
          {
            title: notification.title,
            body: notification.body,
            data: notification.data || {},
            priority: notification.priority,
          }
        );

        results.successCount += apnsResult.successCount;
        results.failureCount += apnsResult.failureCount;
        if (apnsResult.errors) results.errors.push(...apnsResult.errors);

        // Update device delivery status
        for (const result of apnsResult.results || []) {
          await (notification as any).updateDeliveryStatus(
            result.deviceId,
            result.success ? 'sent' : 'failed',
            result.error,
            result.messageId
          );
        }
      } catch (error) {
        logger.error('Error sending APNs notifications:', error);
        results.failureCount += iosDevices.length;
        results.errors.push(`APNs error: ${error}`);
      }
    }

    // Update notification status based on results
    if (results.successCount > 0) {
      notification.status = results.failureCount === 0 ? 'delivered' : 'sent';
    } else {
      notification.status = 'failed';
    }

    await (notification as any).save();

    // Publish delivery event
    await this.publishDeliveryEvent(notification, results);

    // Cache notification for quick access
    await RedisCache.set(
      `notification:${notification.notificationId}`,
      JSON.stringify(notification),
      3600 // 1 hour
    );

    return results;
  }

  private async publishDeliveryEvent(notification: INotification, results: any): Promise<void> {
    try {
      const event = {
        eventType: notification.status === 'delivered' ? 'notification.delivered' : 
                   notification.status === 'sent' ? 'notification.sent' : 'notification.failed',
        notificationId: notification.notificationId,
        userId: notification.userId,
        category: notification.category,
        source: notification.source,
        timestamp: new Date().toISOString(),
        deliveryStats: results,
      };

      await MessageQueue.publish('notification.delivery', event);
    } catch (error) {
      logger.error('Error publishing delivery event:', error);
    }
  }

  private getExpiryDate(priority: string): Date {
    const now = new Date();
    const expiryHours = {
      critical: 72, // 3 days
      high: 48,     // 2 days
      normal: 24,   // 1 day
      low: 12,      // 12 hours
    };

    now.setHours(now.getHours() + (expiryHours[priority as keyof typeof expiryHours] || 24));
    return now;
  }

  private async startMessageConsumer(): Promise<void> {
    try {
      await MessageQueue.consume('notification_queue', async (message) => {
        try {
          logger.info('📥 Processing queued notification message');
          
          // Handle different message types
          if (message.type === 'send_notification') {
            await this.sendNotification(message.data);
            return true;
          }
          
          return false;
        } catch (error) {
          logger.error('Error processing queued message:', error);
          return false;
        }
      });
    } catch (error) {
      logger.error('Error setting up message consumer:', error);
      throw error;
    }
  }

  async getNotificationById(notificationId: string): Promise<INotification | null> {
    try {
      // Check cache first
      const cached = await RedisCache.get(`notification:${notificationId}`);
      if (cached) {
        return JSON.parse(cached);
      }

      // Fallback to database
      const notification = await Notification.findOne({ notificationId });
      
      if (notification) {
        // Cache for future requests
        await RedisCache.set(
          `notification:${notificationId}`,
          JSON.stringify(notification),
          3600
        );
      }
      
      return notification;
    } catch (error) {
      logger.error(`Error getting notification ${notificationId}:`, error);
      return null;
    }
  }

  async getUserNotifications(
    userId: string,
    options: { limit?: number; skip?: number; unreadOnly?: boolean } = {}
  ): Promise<INotification[]> {
    try {
      return await (Notification as any).findByUser(userId, options);
    } catch (error) {
      logger.error(`Error getting notifications for user ${userId}:`, error);
      return [];
    }
  }

  async markAsRead(notificationId: string, userId: string): Promise<boolean> {
    try {
      const notification = await Notification.findOne({ notificationId, userId });
      
      if (!notification) {
        return false;
      }

      await (notification as any).markAsRead();
      
      // Update cache
      await RedisCache.set(
        `notification:${notificationId}`,
        JSON.stringify(notification),
        3600
      );
      
      return true;
    } catch (error) {
      logger.error(`Error marking notification ${notificationId} as read:`, error);
      return false;
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.pushService.shutdown();
      this.isInitialized = false;
      logger.info('✅ NotificationService shut down successfully');
    } catch (error) {
      logger.error('❌ Error shutting down NotificationService:', error);
      throw error;
    }
  }
}