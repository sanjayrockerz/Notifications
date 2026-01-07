import { logger } from '../utils/logger';
import Notification, { INotification } from '../models/Notification';
import { PushNotificationService } from './PushNotificationService';
import Device from '../models/Device';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import { checkQuietHours } from '../utils/quietHours';

/**
 * DeliveryWorkerService (Horizontal Scaling Edition)
 * 
 * Supports 3-5 parallel worker instances with:
 * - Distributed locking (prevents duplicate processing)
 * - Batch processing (fetches multiple notifications)
 * - Lease-based locking (auto-expires if worker crashes)
 * - Worker ID assignment (tracks which worker processes what)
 * - Circuit breaker integration
 * - Quiet hours support
 * 
 * Architecture:
 * - Each worker gets unique ID (hostname + UUID)
 * - Workers compete for batches using optimistic locking
 * - Lock expires after 5 minutes (prevents stuck locks)
 * - Failed deliveries released back to pool
 */

export interface WorkerConfig {
  workerId: string;
  batchSize: number;
  lockDurationMs: number;
  pollIntervalMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

export class DeliveryWorkerService {
  private pushService: PushNotificationService;
  private config: WorkerConfig;
  private isRunning = false;
  private processingInterval?: NodeJS.Timeout;
  private processedCount = 0;
  private failedCount = 0;
  private startTime?: Date;

  constructor(config?: Partial<WorkerConfig>) {
    this.pushService = new PushNotificationService();
    
    // Generate unique worker ID: hostname-processId-uuid
    const hostname = os.hostname();
    const processId = process.pid;
    const uuid = uuidv4().split('-')[0];
    const workerId = `${hostname}-${processId}-${uuid}`;

    this.config = {
      workerId: config?.workerId || workerId,
      batchSize: config?.batchSize || parseInt(process.env.WORKER_BATCH_SIZE || '50', 10),
      lockDurationMs: config?.lockDurationMs || 5 * 60 * 1000, // 5 minutes
      pollIntervalMs: config?.pollIntervalMs || 5000, // 5 seconds
      maxRetries: config?.maxRetries || 3,
      retryDelayMs: config?.retryDelayMs || 5 * 60 * 1000, // 5 minutes
    };

    logger.info('🤖 Delivery worker initialized:', {
      workerId: this.config.workerId,
      batchSize: this.config.batchSize,
      lockDuration: `${this.config.lockDurationMs / 1000}s`,
      pollInterval: `${this.config.pollIntervalMs / 1000}s`,
    });
  }

  /**
   * Start worker
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('⚠️ Worker already running');
      return;
    }

    try {
      await this.pushService.initialize();
      
      this.isRunning = true;
      this.startTime = new Date();
      this.processedCount = 0;
      this.failedCount = 0;

      logger.info(`🚀 Worker ${this.config.workerId} started`);

      // Start polling for pending deliveries
      this.startPolling();

    } catch (error) {
      logger.error('❌ Failed to start worker:', error);
      throw error;
    }
  }

  /**
   * Stop worker
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info(`🛑 Stopping worker ${this.config.workerId}...`);

    this.isRunning = false;

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined as any;
    }

    // Release any locks held by this worker
    await this.releaseLocks();

    const uptime = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    
    logger.info(`✅ Worker ${this.config.workerId} stopped`, {
      uptime: `${(uptime / 1000 / 60).toFixed(2)} minutes`,
      processed: this.processedCount,
      failed: this.failedCount,
      successRate: this.processedCount > 0 
        ? `${((this.processedCount / (this.processedCount + this.failedCount)) * 100).toFixed(2)}%`
        : '0%',
    });
  }

  /**
   * Start polling for pending deliveries
   */
  private startPolling(): void {
    this.processingInterval = setInterval(async () => {
      if (!this.isRunning) {
        return;
      }

      try {
        await this.processBatch();
      } catch (error) {
        logger.error('❌ Error processing batch:', error);
      }
    }, this.config.pollIntervalMs);

    logger.info(`👂 Worker polling every ${this.config.pollIntervalMs / 1000}s`);
  }

  /**
   * Process a batch of pending notifications
   */
  private async processBatch(): Promise<void> {
    try {
      // Acquire lock on batch of pending notifications
      const notifications = await this.acquireBatch();

      if (notifications.length === 0) {
        return; // No work available
      }

      logger.info(`📦 Processing batch of ${notifications.length} notifications`);

      // Process each notification
      for (const notification of notifications) {
        try {
          await this.processNotification(notification);
          this.processedCount++;
        } catch (error) {
          logger.error(`❌ Failed to process notification ${notification.notificationId}:`, error);
          this.failedCount++;
          await this.handleFailure(notification, error);
        }
      }

    } catch (error) {
      logger.error('❌ Error acquiring batch:', error);
    }
  }

  /**
   * Acquire lock on batch of pending notifications
   * Uses optimistic locking to prevent duplicate processing
   */
  private async acquireBatch(): Promise<INotification[]> {
    const now = new Date();
    const lockExpiry = new Date(now.getTime() + this.config.lockDurationMs);

    try {
      // Find and lock pending notifications in a single atomic operation
      // Conditions:
      // 1. Status is 'pending' or 'scheduled' (ready to send)
      // 2. Not locked OR lock expired
      // 3. Schedule time has passed (if scheduled)
      // 4. Retry attempts < maxRetries
      const result = await Notification.updateMany(
        {
          $and: [
            {
              status: { $in: ['pending', 'scheduled'] },
            },
            {
              $or: [
                { lockedBy: { $exists: false } }, // Not locked
                { lockedBy: null }, // No lock
                { lockExpiry: { $lt: now } }, // Lock expired
              ],
            },
            {
              $or: [
                { scheduleAt: { $exists: false } }, // No schedule
                { scheduleAt: null }, // No schedule
                { scheduleAt: { $lte: now } }, // Schedule passed
              ],
            },
            {
              $or: [
                { 'delivery.attempts': { $exists: false } },
                { 'delivery.attempts': { $lt: this.config.maxRetries } },
              ],
            },
          ],
        },
        {
          $set: {
            lockedBy: this.config.workerId,
            lockedAt: now,
            lockExpiry,
          },
        }
      );

      if (result.modifiedCount === 0) {
        return []; // No notifications locked
      }

      // Fetch the locked notifications
      const notifications = await Notification.find({
        lockedBy: this.config.workerId,
        lockExpiry,
      }).lean();

      logger.debug(`🔒 Acquired lock on ${notifications.length} notifications`);

      return notifications as any[];

    } catch (error) {
      logger.error('❌ Error acquiring batch lock:', error);
      return [];
    }
  }

  /**
   * Process individual notification
   */
  private async processNotification(notification: INotification): Promise<void> {
    const notificationId = notification.notificationId;

    try {
      logger.debug(`📤 Processing notification: ${notificationId}`);

      // Check quiet hours (unless urgent)
      if (!notification.urgent) {
        const quietHoursCheck = await checkQuietHours(
          notification.userId,
          new Date()
        );

        if (quietHoursCheck.isQuietHours) {
          logger.info(`🔕 Notification ${notificationId} in quiet hours, rescheduling`);
          
          // Release lock and reschedule
          await Notification.updateOne(
            { notificationId },
            {
              $set: {
                status: 'scheduled',
                scheduleAt: quietHoursCheck.nextAvailableTime,
                lockedBy: null,
                lockedAt: null,
                lockExpiry: null,
              },
            }
          );
          return;
        }
      }

      // Get user's active devices
      const devices = await Device.find({
        userId: notification.userId,
        isActive: true,
      });

      if (devices.length === 0) {
        logger.warn(`⚠️ No active devices for user ${notification.userId}`);
        
        // Mark as failed - no devices
        await Notification.updateOne(
          { notificationId },
          {
            $set: {
              status: 'failed',
              'delivery.lastAttempt': new Date(),
              lockedBy: null,
              lockedAt: null,
              lockExpiry: null,
            },
            $inc: { 'delivery.attempts': 1 },
          }
        );
        return;
      }

      // Send to devices
      const androidDevices = devices.filter(d => d.platform === 'android');
      const iosDevices = devices.filter(d => d.platform === 'ios');

      let successCount = 0;
      let failureCount = 0;

      // Send to Android devices
      if (androidDevices.length > 0) {
        const result = await this.pushService.sendToAndroidDevices(androidDevices as any, {
          title: notification.title,
          body: notification.body,
          data: notification.data || {},
          ...(notification.imageUrl && { imageUrl: notification.imageUrl }),
          priority: notification.priority,
        });
        successCount += result.successCount;
        failureCount += result.failureCount;
      }

      // Send to iOS devices
      if (iosDevices.length > 0) {
        const result = await this.pushService.sendToiOSDevices(iosDevices as any, {
          title: notification.title,
          body: notification.body,
          data: notification.data || {},
          ...(notification.imageUrl && { imageUrl: notification.imageUrl }),
          priority: notification.priority,
        });
        successCount += result.successCount;
        failureCount += result.failureCount;
      }

      // Update notification status
      const finalStatus = successCount > 0 ? 'sent' : 'failed';

      await Notification.updateOne(
        { notificationId },
        {
          $set: {
            status: finalStatus,
            'delivery.lastAttempt': new Date(),
            lockedBy: null,
            lockedAt: null,
            lockExpiry: null,
          },
          $inc: { 'delivery.attempts': 1 },
        }
      );

      logger.info(`✅ Notification ${notificationId} processed`, {
        devices: devices.length,
        success: successCount,
        failed: failureCount,
      });

    } catch (error) {
      logger.error(`❌ Error processing notification ${notificationId}:`, error);
      throw error;
    }
  }

  /**
   * Handle notification processing failure
   */
  private async handleFailure(notification: INotification, error: any): Promise<void> {
    const notificationId = notification.notificationId;
    const attempts = (notification.delivery?.attempts || 0) + 1;

    try {
      if (attempts >= this.config.maxRetries) {
        // Max retries reached, mark as failed permanently
        await Notification.updateOne(
          { notificationId },
          {
            $set: {
              status: 'failed',
              'delivery.lastAttempt': new Date(),
              lockedBy: null,
              lockedAt: null,
              lockExpiry: null,
            },
            $inc: { 'delivery.attempts': 1 },
          }
        );

        logger.error(`❌ Notification ${notificationId} failed permanently after ${attempts} attempts`);
      } else {
        // Schedule retry
        const nextRetryAt = new Date(Date.now() + this.config.retryDelayMs);

        await Notification.updateOne(
          { notificationId },
          {
            $set: {
              status: 'pending',
              scheduleAt: nextRetryAt,
              'delivery.lastAttempt': new Date(),
              lockedBy: null,
              lockedAt: null,
              lockExpiry: null,
            },
            $inc: { 'delivery.attempts': 1 },
          }
        );

        logger.warn(`⚠️ Notification ${notificationId} scheduled for retry (attempt ${attempts}/${this.config.maxRetries})`);
      }
    } catch (updateError) {
      logger.error(`❌ Error handling failure for ${notificationId}:`, updateError);
    }
  }

  /**
   * Release all locks held by this worker
   */
  private async releaseLocks(): Promise<void> {
    try {
      const result = await Notification.updateMany(
        { lockedBy: this.config.workerId },
        {
          $set: {
            lockedBy: null,
            lockedAt: null,
            lockExpiry: null,
          },
        }
      );

      if (result.modifiedCount > 0) {
        logger.info(`🔓 Released ${result.modifiedCount} locks`);
      }
    } catch (error) {
      logger.error('❌ Error releasing locks:', error);
    }
  }

  /**
   * Get worker statistics
   */
  getStats(): {
    workerId: string;
    isRunning: boolean;
    uptime: number;
    processed: number;
    failed: number;
    successRate: string;
  } {
    const uptime = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    const total = this.processedCount + this.failedCount;
    const successRate = total > 0 
      ? `${((this.processedCount / total) * 100).toFixed(2)}%`
      : '0%';

    return {
      workerId: this.config.workerId,
      isRunning: this.isRunning,
      uptime,
      processed: this.processedCount,
      failed: this.failedCount,
      successRate,
    };
  }
}
