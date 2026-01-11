/**
 * NotificationReadReceipt Model
 * 
 * Stores per-user read state in a SEPARATE collection from notifications.
 * 
 * WHY SEPARATE COLLECTION?
 * 1. Notifications are immutable after creation (write once)
 * 2. Read state changes frequently (updates per user action)
 * 3. Separating allows for:
 *    - Better write performance (no document locking on notifications)
 *    - Efficient bulk read status checks
 *    - Easy aggregation of unread counts
 *    - Simpler fanout-on-read queries
 * 
 * INDEXES:
 * - (userId, notificationId): Unique compound for quick lookups
 * - (userId, readAt): For "recently read" queries
 * - (notificationId): For cleanup when notification is deleted
 * 
 * TTL: Read receipts are kept for 90 days (configurable via TTL index)
 */

import mongoose, { Schema, Document, Model } from 'mongoose';

// ============================================================================
// Interface Definitions
// ============================================================================

export interface IReadReceipt extends Document {
  userId: string;
  notificationId: string; // Can be personal or group notification ID
  notificationType: 'personal' | 'group';
  readAt: Date;
  /** How the notification was read (tap, swipe, auto-read, etc.) */
  readMethod?: 'tap' | 'swipe' | 'auto' | 'bulk' | 'api';
  /** Client context when read */
  context?: {
    appVersion?: string;
    platform?: 'ios' | 'android' | 'web';
    source?: 'inbox' | 'push' | 'badge_clear';
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface ReadReceiptModel extends Model<IReadReceipt> {
  /** Check if a single notification is read by user */
  isRead(userId: string, notificationId: string): Promise<boolean>;
  
  /** Check multiple notifications at once */
  getReadStatus(userId: string, notificationIds: string[]): Promise<Map<string, boolean>>;
  
  /** Mark single notification as read */
  markAsRead(
    userId: string,
    notificationId: string,
    notificationType: 'personal' | 'group',
    options?: { readMethod?: string; context?: IReadReceipt['context'] }
  ): Promise<IReadReceipt>;
  
  /** Mark multiple notifications as read (bulk operation) */
  markManyAsRead(
    userId: string,
    notificationIds: string[],
    notificationType: 'personal' | 'group'
  ): Promise<number>;
  
  /** Mark all notifications as read for a user */
  markAllAsRead(userId: string): Promise<number>;
  
  /** Get unread count for user */
  getUnreadCount(userId: string, notificationIds: string[]): Promise<number>;
  
  /** Get recently read notifications */
  getRecentlyRead(userId: string, limit?: number): Promise<IReadReceipt[]>;
  
  /** Cleanup old read receipts */
  cleanupOld(olderThanDays?: number): Promise<number>;
}

// ============================================================================
// Schema Definition
// ============================================================================

const ReadReceiptSchema = new Schema<IReadReceipt>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    notificationId: {
      type: String,
      required: true,
    },
    notificationType: {
      type: String,
      enum: ['personal', 'group'],
      required: true,
    },
    readAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    readMethod: {
      type: String,
      enum: ['tap', 'swipe', 'auto', 'bulk', 'api'],
    },
    context: {
      appVersion: String,
      platform: {
        type: String,
        enum: ['ios', 'android', 'web'],
      },
      source: {
        type: String,
        enum: ['inbox', 'push', 'badge_clear'],
      },
    },
  },
  {
    timestamps: true,
    collection: 'notification_read_receipts',
  }
);

// ============================================================================
// Indexes
// ============================================================================

// Unique compound index: one read receipt per user per notification
ReadReceiptSchema.index(
  { userId: 1, notificationId: 1 },
  { unique: true }
);

// For "recently read" queries
ReadReceiptSchema.index({ userId: 1, readAt: -1 });

// For cleanup when notification is deleted
ReadReceiptSchema.index({ notificationId: 1 });

// TTL index: auto-delete after 90 days
ReadReceiptSchema.index(
  { readAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 } // 90 days
);

// For analytics: when was it read relative to creation
ReadReceiptSchema.index({ createdAt: 1 });

// ============================================================================
// Static Methods
// ============================================================================

ReadReceiptSchema.statics.isRead = async function(
  userId: string,
  notificationId: string
): Promise<boolean> {
  const receipt = await this.findOne({ userId, notificationId }).lean();
  return receipt !== null;
};

ReadReceiptSchema.statics.getReadStatus = async function(
  userId: string,
  notificationIds: string[]
): Promise<Map<string, boolean>> {
  const receipts = await this.find({
    userId,
    notificationId: { $in: notificationIds },
  }).lean();

  const readMap = new Map<string, boolean>();
  
  // Initialize all as unread
  notificationIds.forEach(id => readMap.set(id, false));
  
  // Mark the ones we found as read
  receipts.forEach((r: { notificationId: string }) => readMap.set(r.notificationId, true));
  
  return readMap;
};

ReadReceiptSchema.statics.markAsRead = async function(
  userId: string,
  notificationId: string,
  notificationType: 'personal' | 'group',
  options: { readMethod?: string; context?: IReadReceipt['context'] } = {}
): Promise<IReadReceipt> {
  return this.findOneAndUpdate(
    { userId, notificationId },
    {
      $setOnInsert: {
        userId,
        notificationId,
        notificationType,
        readAt: new Date(),
        readMethod: options.readMethod,
        context: options.context,
      },
    },
    { upsert: true, new: true }
  );
};

ReadReceiptSchema.statics.markManyAsRead = async function(
  userId: string,
  notificationIds: string[],
  notificationType: 'personal' | 'group'
): Promise<number> {
  const operations = notificationIds.map(notificationId => ({
    updateOne: {
      filter: { userId, notificationId },
      update: {
        $setOnInsert: {
          userId,
          notificationId,
          notificationType,
          readAt: new Date(),
          readMethod: 'bulk' as const,
        },
      },
      upsert: true,
    },
  }));

  const result = await this.bulkWrite(operations, { ordered: false });
  return result.upsertedCount + result.modifiedCount;
};

ReadReceiptSchema.statics.markAllAsRead = async function(
  userId: string
): Promise<number> {
  // This requires knowing all notification IDs for the user
  // In practice, you'd pass in the notification IDs from the notifications collection
  // This is a placeholder that would be called with actual IDs
  return 0;
};

ReadReceiptSchema.statics.getUnreadCount = async function(
  userId: string,
  notificationIds: string[]
): Promise<number> {
  if (notificationIds.length === 0) return 0;
  
  const readCount = await this.countDocuments({
    userId,
    notificationId: { $in: notificationIds },
  });
  
  return notificationIds.length - readCount;
};

ReadReceiptSchema.statics.getRecentlyRead = async function(
  userId: string,
  limit: number = 50
): Promise<IReadReceipt[]> {
  return this.find({ userId })
    .sort({ readAt: -1 })
    .limit(limit)
    .lean();
};

ReadReceiptSchema.statics.cleanupOld = async function(
  olderThanDays: number = 90
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);
  
  const result = await this.deleteMany({
    readAt: { $lt: cutoff },
  });
  
  return result.deletedCount;
};

// ============================================================================
// Model Export
// ============================================================================

const ReadReceipt = mongoose.model<IReadReceipt, ReadReceiptModel>(
  'ReadReceipt',
  ReadReceiptSchema
);

export default ReadReceipt;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Merge notification data with read status efficiently
 * @param userId User to check read status for
 * @param notifications Array of notifications to enhance
 */
export async function enrichNotificationsWithReadStatus<T extends { notificationId?: string; _id?: any }>(
  userId: string,
  notifications: T[]
): Promise<(T & { isRead: boolean })[]> {
  const notificationIds = notifications.map(n => 
    n.notificationId || (n._id ? n._id.toString() : '')
  ).filter(Boolean);
  
  const readStatusMap = await ReadReceipt.getReadStatus(userId, notificationIds);
  
  return notifications.map(n => {
    const id = n.notificationId || (n._id ? n._id.toString() : '');
    return {
      ...n,
      isRead: readStatusMap.get(id) || false,
    };
  });
}
