import mongoose, { Schema, Document, Model } from 'mongoose';

// Add custom statics and methods to Notification model

export interface INotification extends Document {
  notificationId: string;
  userId: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  imageUrl?: string;
  iconUrl?: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  category: string;
  tags: string[];
  urgent?: boolean; // If true, delivers even during quiet hours
  scheduleAt?: Date;
  timezone?: string;
  status: 'pending' | 'scheduled' | 'sent' | 'delivered' | 'failed' | 'cancelled';
  isRead: boolean;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  
  // Distributed processing locks (for parallel workers)
  lockedBy?: string; // Worker ID that locked this notification
  lockedAt?: Date; // When the lock was acquired
  lockExpiry?: Date; // When the lock expires
  
  delivery: {
    attempts: number;
    lastAttempt?: Date;
    devices: Array<{
      deviceId: string;
      platform: 'android' | 'ios';
      status: 'pending' | 'sent' | 'delivered' | 'failed';
      sentAt?: Date;
      deliveredAt?: Date;
      errorMessage?: string;
      fcmMessageId?: string;
      apnsId?: string;
    }>;
  };
  interactions: Array<{
    type: 'opened' | 'clicked' | 'dismissed';
    timestamp: Date;
    deviceId?: string;
    metadata?: Record<string, any>;
  }>;
  expiresAt?: Date;
  source: string;
  campaign?: string;
  metadata: Record<string, any>;
  resourceId?: string; // For idempotency: ID of the resource that triggered notification (e.g., followerId, postId)
  
  // Instance methods
  markAsRead(): Promise<INotification>;
  addInteraction(type: 'opened' | 'clicked' | 'dismissed', deviceId?: string, metadata?: Record<string, any>): Promise<INotification>;
  updateDeliveryStatus(deviceId: string, status: 'sent' | 'delivered' | 'failed', errorMessage?: string, externalId?: string): Promise<INotification>;
}

export interface NotificationModel extends Model<INotification> {
  findPendingScheduled(): Promise<INotification[]>;
  findFailedForRetry(maxAttempts?: number): Promise<INotification[]>;
  findDuplicate(userId: string, category: string, resourceId?: string): Promise<INotification | null>;
  findByEventId(eventId: string): Promise<INotification | null>;
}

const NotificationSchema = new Schema<INotification>({
  notificationId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  userId: {
    type: String,
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
    maxlength: 100,
  },
  body: {
    type: String,
    required: true,
    maxlength: 500,
  },
  data: {
    type: Schema.Types.Mixed,
    default: {},
  },
  imageUrl: String,
  iconUrl: String,
  
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'critical'],
    default: 'normal',
    index: true,
  },
  category: {
    type: String,
    required: true,
    index: true,
  },
  tags: [{
    type: String,
  }],
  
  urgent: {
    type: Boolean,
    default: false,
  },
  
  scheduleAt: {
    type: Date,
    index: true,
  },
  timezone: String,
  
  status: {
    type: String,
    enum: ['pending', 'scheduled', 'sent', 'delivered', 'failed', 'cancelled'],
    default: 'pending',
    index: true,
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true,
  },
  readAt: Date,
  
  // Distributed processing locks (for parallel workers)
  lockedBy: {
    type: String,
    index: true,
  },
  lockedAt: Date,
  lockExpiry: {
    type: Date,
    index: true,
  },
  
  delivery: {
    attempts: { type: Number, default: 0 },
    lastAttempt: Date,
    lockedBy: Number, // Worker ID that has locked this notification
    lockExpiresAt: Date, // Lock expiration time
    lockAcquiredAt: Date, // When lock was acquired
    devices: [{
      deviceId: { type: String, required: true },
      platform: { type: String, enum: ['android', 'ios'], required: true },
      status: {
        type: String,
        enum: ['pending', 'sent', 'delivered', 'failed'],
        default: 'pending',
      },
      sentAt: Date,
      deliveredAt: Date,
      errorMessage: String,
      fcmMessageId: String,
      apnsId: String,
    }],
  },
  
  interactions: [{
    type: {
      type: String,
      enum: ['opened', 'clicked', 'dismissed'],
      required: true,
    },
    timestamp: { type: Date, default: Date.now },
    deviceId: String,
    metadata: Schema.Types.Mixed,
  }],
  
  expiresAt: {
    type: Date,
    index: { expireAfterSeconds: 0 },
  },
  
  source: {
    type: String,
    required: true,
    index: true,
  },
  campaign: {
    type: String,
    index: true,
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {},
  },
  resourceId: {
    type: String,
    index: true,
  },
}, {
  timestamps: true,
  collection: 'notifications',
});

// Indexes
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, status: 1 });
NotificationSchema.index({ userId: 1, isRead: 1 });
NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 }); // Optimized for unread notifications
NotificationSchema.index({ status: 1, scheduleAt: 1 });
NotificationSchema.index({ category: 1, createdAt: -1 });
NotificationSchema.index({ tags: 1 });
NotificationSchema.index({ source: 1, createdAt: -1 });

// Cursor-based pagination indexes - compound for equality + sort pattern
// Supports: { userId, isRead } + sort by { createdAt: -1, _id: -1 }
NotificationSchema.index(
  { userId: 1, isRead: 1, createdAt: -1, _id: -1 },
  { name: 'cursor_pagination_unread' }
);
NotificationSchema.index(
  { userId: 1, createdAt: -1, _id: -1 },
  { name: 'cursor_pagination_all' }
);

// Idempotency indexes - prevents duplicate notifications
// Composite unique index for follow/like type notifications
NotificationSchema.index(
  { userId: 1, category: 1, resourceId: 1 },
  { 
    unique: true, 
    partialFilterExpression: { resourceId: { $exists: true, $ne: null } },
    name: 'unique_user_category_resource'
  }
);

// Index for quick duplicate checking
NotificationSchema.index({ userId: 1, category: 1, source: 1, createdAt: -1 });

// Methods
NotificationSchema.methods.markAsRead = function(): Promise<INotification> {
  this.isRead = true;
  this.readAt = new Date();
  return this.save();
};

NotificationSchema.methods.addInteraction = function(
  type: 'opened' | 'clicked' | 'dismissed',
  deviceId?: string,
  metadata?: Record<string, any>
): Promise<INotification> {
  this.interactions.push({
    type,
    timestamp: new Date(),
    deviceId,
    metadata,
  });
  return this.save();
};

NotificationSchema.methods.updateDeliveryStatus = function(
  deviceId: string,
  status: 'sent' | 'delivered' | 'failed',
  errorMessage?: string,
  externalId?: string
): Promise<INotification> {
  const deviceDelivery = this.delivery.devices.find((d: any) => d.deviceId === deviceId);
  
  if (deviceDelivery) {
    deviceDelivery.status = status;
    
    if (status === 'sent') {
      deviceDelivery.sentAt = new Date();
    } else if (status === 'delivered') {
      deviceDelivery.deliveredAt = new Date();
    }
    
    if (errorMessage) {
      deviceDelivery.errorMessage = errorMessage;
    }
    
    if (externalId) {
      if (deviceDelivery.platform === 'android') {
        deviceDelivery.fcmMessageId = externalId;
      } else {
        deviceDelivery.apnsId = externalId;
      }
    }
    
    // Update overall status
    const allStatuses = this.delivery.devices.map((d: any) => d.status);
    if (allStatuses.every((s: any) => s === 'delivered')) {
      this.status = 'delivered';
    } else if (allStatuses.some((s: any) => s === 'sent' || s === 'delivered')) {
      this.status = 'sent';
    } else if (allStatuses.every((s: any) => s === 'failed')) {
      this.status = 'failed';
    }
  }
  
  return this.save();
};

// Static methods
NotificationSchema.statics.findByUser = function(
  userId: string,
  options: { limit?: number; skip?: number; unreadOnly?: boolean } = {}
): Promise<INotification[]> {
  const query: any = { userId };
  
  if (options.unreadOnly) {
    query.isRead = false;
  }
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

NotificationSchema.statics.findPendingScheduled = function(): Promise<INotification[]> {
  return this.find({
    status: 'scheduled',
    scheduleAt: { $lte: new Date() },
  }).sort({ scheduleAt: 1 });
};

NotificationSchema.statics.findFailedForRetry = function(
  maxAttempts = 3
): Promise<INotification[]> {
  return this.find({
    status: 'failed',
    'delivery.attempts': { $lt: maxAttempts },
    'delivery.lastAttempt': {
      $lt: new Date(Date.now() - 15 * 60 * 1000), // 15 minutes ago
    },
  });
};

// Find duplicate notification based on user, category, and resource
NotificationSchema.statics.findDuplicate = function(
  userId: string,
  category: string,
  resourceId?: string
): Promise<INotification | null> {
  if (!resourceId) {
    return Promise.resolve(null);
  }
  
  return this.findOne({
    userId,
    category,
    resourceId,
  });
};

// Find notification by eventId stored in metadata
NotificationSchema.statics.findByEventId = function(
  eventId: string
): Promise<INotification | null> {
  return this.findOne({
    'metadata.eventId': eventId,
  });
};

NotificationSchema.statics.getAnalytics = function(
  userId?: string,
  dateFrom?: Date,
  dateTo?: Date
): Promise<any> {
  const match: any = {};
  
  if (userId) match.userId = userId;
  if (dateFrom || dateTo) {
    match.createdAt = {};
    if (dateFrom) match.createdAt.$gte = dateFrom;
    if (dateTo) match.createdAt.$lte = dateTo;
  }
  
  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        categories: { $addToSet: '$category' },
      },
    },
  ]);
};

const Notification = mongoose.model<INotification, NotificationModel>('Notification', NotificationSchema);

export default Notification;