import { logger } from '../utils/logger';
import Notification from '../models/Notification';
import GroupNotification from '../models/GroupNotification';
import mongoose from 'mongoose';

/**
 * ArchivingService
 * 
 * Moves old notifications to archive collections to keep live tables small and fast.
 * - Archives notifications older than configured threshold (default: 30 days)
 * - Supports batch processing to avoid memory issues
 * - Runs as scheduled cron job
 * - Keeps live tables < 100M rows for optimal query performance
 */

export interface ArchivingConfig {
  archiveThresholdDays: number; // Days before archiving (default: 30)
  batchSize: number; // Records per batch (default: 1000)
  maxRecordsPerRun: number; // Max records to archive per run
  deleteAfterArchive: boolean; // Delete from live table after archiving
  dryRun: boolean; // If true, only logs what would be archived
}

export interface ArchivingStats {
  notificationsArchived: number;
  groupNotificationsArchived: number;
  durationMs: number;
  errors: number;
  batchesProcessed: number;
}

export class ArchivingService {
  private config: ArchivingConfig;
  private isRunning = false;

  // Archive collections
  private NotificationArchive: mongoose.Model<any>;
  private GroupNotificationArchive: mongoose.Model<any>;

  constructor(config?: Partial<ArchivingConfig>) {
    this.config = {
      archiveThresholdDays: config?.archiveThresholdDays || 30,
      batchSize: config?.batchSize || 1000,
      maxRecordsPerRun: config?.maxRecordsPerRun || 100000,
      deleteAfterArchive: config?.deleteAfterArchive !== false, // Default true
      dryRun: config?.dryRun || false,
    };

    // Create archive models (same schema, different collection)
    this.NotificationArchive = mongoose.model(
      'NotificationArchive',
      Notification.schema,
      'notifications_archive'
    );

    this.GroupNotificationArchive = mongoose.model(
      'GroupNotificationArchive',
      GroupNotification.schema,
      'group_notifications_archive'
    );
  }

  /**
   * Archive old notifications
   */
  async archiveOldNotifications(): Promise<ArchivingStats> {
    if (this.isRunning) {
      logger.warn('⚠️ Archiving already in progress, skipping run');
      return {
        notificationsArchived: 0,
        groupNotificationsArchived: 0,
        durationMs: 0,
        errors: 0,
        batchesProcessed: 0,
      };
    }

    this.isRunning = true;
    const startTime = Date.now();
    let stats: ArchivingStats = {
      notificationsArchived: 0,
      groupNotificationsArchived: 0,
      durationMs: 0,
      errors: 0,
      batchesProcessed: 0,
    };

    try {
      logger.info(`🗄️ Starting archiving process (threshold: ${this.config.archiveThresholdDays} days)`);

      // Archive notifications
      const notificationStats = await this.archiveNotifications();
      stats.notificationsArchived = notificationStats.archived;
      stats.errors += notificationStats.errors;
      stats.batchesProcessed += notificationStats.batches;

      // Archive group notifications
      const groupStats = await this.archiveGroupNotifications();
      stats.groupNotificationsArchived = groupStats.archived;
      stats.errors += groupStats.errors;
      stats.batchesProcessed += groupStats.batches;

      stats.durationMs = Date.now() - startTime;

      logger.info(`✅ Archiving completed:`, stats);

      return stats;
    } catch (error) {
      logger.error('❌ Archiving failed:', error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Archive old personal notifications
   */
  private async archiveNotifications(): Promise<{ archived: number; errors: number; batches: number }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.archiveThresholdDays);

    logger.info(`📦 Archiving notifications older than ${cutoffDate.toISOString()}`);

    let archived = 0;
    let errors = 0;
    let batches = 0;

    try {
      while (archived < this.config.maxRecordsPerRun) {
        // Find old notifications
        const notifications = await Notification.find({
          createdAt: { $lt: cutoffDate },
        })
          .limit(this.config.batchSize)
          .lean();

        if (notifications.length === 0) {
          break; // No more to archive
        }

        batches++;

        if (this.config.dryRun) {
          logger.info(`[DRY RUN] Would archive ${notifications.length} notifications`);
          archived += notifications.length;
          break; // Don't continue in dry run
        }

        // Insert into archive collection
        try {
          await this.NotificationArchive.insertMany(notifications, { ordered: false });
          logger.info(`✅ Archived ${notifications.length} notifications (batch ${batches})`);

          // Delete from live collection
          if (this.config.deleteAfterArchive) {
            const ids = notifications.map(n => n._id);
            await Notification.deleteMany({ _id: { $in: ids } });
            logger.info(`🗑️ Deleted ${ids.length} notifications from live table`);
          }

          archived += notifications.length;
        } catch (error) {
          logger.error('Error archiving notifications batch:', error);
          errors++;
        }

        // Prevent infinite loop
        if (batches >= 100) {
          logger.warn('⚠️ Max batches (100) reached, stopping');
          break;
        }
      }

      return { archived, errors, batches };
    } catch (error) {
      logger.error('Error in archiveNotifications:', error);
      return { archived, errors: errors + 1, batches };
    }
  }

  /**
   * Archive old group notifications
   */
  private async archiveGroupNotifications(): Promise<{ archived: number; errors: number; batches: number }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.archiveThresholdDays);

    logger.info(`📦 Archiving group notifications older than ${cutoffDate.toISOString()}`);

    let archived = 0;
    let errors = 0;
    let batches = 0;

    try {
      while (archived < this.config.maxRecordsPerRun) {
        // Find old group notifications
        const groupNotifications = await GroupNotification.find({
          createdAt: { $lt: cutoffDate },
          isActive: false, // Only archive inactive ones
        })
          .limit(this.config.batchSize)
          .lean();

        if (groupNotifications.length === 0) {
          break; // No more to archive
        }

        batches++;

        if (this.config.dryRun) {
          logger.info(`[DRY RUN] Would archive ${groupNotifications.length} group notifications`);
          archived += groupNotifications.length;
          break; // Don't continue in dry run
        }

        // Insert into archive collection
        try {
          await this.GroupNotificationArchive.insertMany(groupNotifications, { ordered: false });
          logger.info(`✅ Archived ${groupNotifications.length} group notifications (batch ${batches})`);

          // Delete from live collection
          if (this.config.deleteAfterArchive) {
            const ids = groupNotifications.map(n => n._id);
            await GroupNotification.deleteMany({ _id: { $in: ids } });
            logger.info(`🗑️ Deleted ${ids.length} group notifications from live table`);
          }

          archived += groupNotifications.length;
        } catch (error) {
          logger.error('Error archiving group notifications batch:', error);
          errors++;
        }

        // Prevent infinite loop
        if (batches >= 100) {
          logger.warn('⚠️ Max batches (100) reached, stopping');
          break;
        }
      }

      return { archived, errors, batches };
    } catch (error) {
      logger.error('Error in archiveGroupNotifications:', error);
      return { archived, errors: errors + 1, batches };
    }
  }

  /**
   * Get statistics about live vs archive data
   */
  async getStatistics(): Promise<{
    live: { notifications: number; groupNotifications: number };
    archived: { notifications: number; groupNotifications: number };
    oldestLive: { notifications?: Date; groupNotifications?: Date };
  }> {
    try {
      const [
        liveNotificationsCount,
        liveGroupNotificationsCount,
        archivedNotificationsCount,
        archivedGroupNotificationsCount,
      ] = await Promise.all([
        Notification.countDocuments(),
        GroupNotification.countDocuments(),
        this.NotificationArchive.countDocuments(),
        this.GroupNotificationArchive.countDocuments(),
      ]);

      // Get oldest live records
      const oldestNotification = await Notification.findOne()
        .sort({ createdAt: 1 })
        .select('createdAt')
        .lean();

      const oldestGroupNotification = await GroupNotification.findOne()
        .sort({ createdAt: 1 })
        .select('createdAt')
        .lean();

      return {
        live: {
          notifications: liveNotificationsCount,
          groupNotifications: liveGroupNotificationsCount,
        },
        archived: {
          notifications: archivedNotificationsCount,
          groupNotifications: archivedGroupNotificationsCount,
        },
        oldestLive: {
          ...(oldestNotification && { notifications: (oldestNotification as any).createdAt }),
          ...(oldestGroupNotification && { groupNotifications: oldestGroupNotification.createdAt }),
        },
      };
    } catch (error) {
      logger.error('Error getting archiving statistics:', error);
      throw error;
    }
  }

  /**
   * Restore archived notification (for debugging/recovery)
   */
  async restoreNotification(notificationId: string): Promise<boolean> {
    try {
      const archived = await this.NotificationArchive.findOne({ notificationId }).lean();

      if (!archived) {
        logger.warn(`Notification ${notificationId} not found in archive`);
        return false;
      }

      await Notification.create(archived);
      await this.NotificationArchive.deleteOne({ notificationId });

      logger.info(`✅ Restored notification ${notificationId} from archive`);
      return true;
    } catch (error) {
      logger.error(`Error restoring notification ${notificationId}:`, error);
      return false;
    }
  }
}

// Export singleton instance
export const archivingService = new ArchivingService();
