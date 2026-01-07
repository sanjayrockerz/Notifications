import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * GroupNotification Model
 * 
 * Used for fanout-on-read strategy for high-follower-count users.
 * Instead of creating 100K individual notification rows, we store one
 * event-based notification that's computed on-read when users open their inbox.
 * 
 * Example: User with 100K followers creates a post
 * - Traditional fanout-on-write: Create 100K notification rows
 * - Fanout-on-read: Create 1 GroupNotification row, compute recipients on read
 */
export interface IGroupNotification extends Document {
  groupNotificationId: string;
  eventType: 'PostCreated' | 'LiveStreamStarted' | 'StoryPosted' | 'AnnouncementMade';
  eventId: string;
  
  // Actor information
  actorUserId: string;
  actorUsername?: string;
  actorDisplayName?: string;
  actorAvatarUrl?: string;
  actorFollowerCount: number;
  
  // Notification content
  title: string;
  body: string;
  imageUrl?: string;
  actionUrl?: string;
  
  // Event data
  data: Record<string, any>;
  
  // Targeting
  targetAudience: 'followers' | 'subscribers' | 'custom';
  targetUserIds?: string[]; // For custom targeting
  excludeUserIds?: string[]; // Users to exclude from notification
  
  // Delivery
  priority: 'low' | 'normal' | 'high' | 'critical';
  
  // Push notification strategy
  pushStrategy: 'none' | 'topic' | 'individual';
  firebaseTopic?: string; // For topic-based push
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  isActive: boolean;
  metadata?: Record<string, any>;
  
  // Statistics (flattened for easier access)
  estimatedReach: number; // Estimated number of recipients
  actualReach: number; // Actual number who viewed
  viewCount: number;
  clickCount: number;
}

export interface GroupNotificationModel extends Model<IGroupNotification> {
  findActiveForUser(userId: string, since?: Date): Promise<IGroupNotification[]>;
  findByActorUserId(actorUserId: string, limit?: number): Promise<IGroupNotification[]>;
  incrementViewCount(groupNotificationId: string): Promise<void>;
  incrementClickCount(groupNotificationId: string): Promise<void>;
}

const GroupNotificationSchema = new Schema<IGroupNotification>({
  groupNotificationId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  
  eventType: {
    type: String,
    enum: ['PostCreated', 'LiveStreamStarted', 'StoryPosted', 'AnnouncementMade'],
    required: true,
    index: true,
  },
  
  eventId: {
    type: String,
    required: true,
    index: true,
  },
  
  actorUserId: {
    type: String,
    required: true,
    index: true,
  },
  
  actorUsername: {
    type: String,
    required: true,
  },
  
  actorDisplayName: String,
  actorAvatarUrl: String,
  
  actorFollowerCount: {
    type: Number,
    required: true,
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
  
  imageUrl: String,
  actionUrl: String,
  
  data: {
    type: Schema.Types.Mixed,
    default: {},
  },
  
  targetAudience: {
    type: String,
    enum: ['followers', 'subscribers', 'custom'],
    default: 'followers',
    index: true,
  },
  
  targetUserIds: [{
    type: String,
  }],
  
  excludeUserIds: [{
    type: String,
  }],
  
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'critical'],
    default: 'normal',
  },
  
  pushStrategy: {
    type: String,
    enum: ['none', 'topic', 'individual'],
    default: 'topic',
  },
  
  firebaseTopic: String,
  
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  
  expiresAt: {
    type: Date,
    index: true,
  },
  
  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },
}, {
  timestamps: true,
  collection: 'group_notifications',
});

// Compound indexes for common queries
GroupNotificationSchema.index({ actorUserId: 1, createdAt: -1 });
GroupNotificationSchema.index({ isActive: 1, createdAt: -1 });
GroupNotificationSchema.index({ eventType: 1, createdAt: -1 });
GroupNotificationSchema.index({ createdAt: -1, isActive: 1 });

/**
 * Find active group notifications that a user should see
 * @param userId - User ID to check
 * @param since - Only return notifications after this date
 */
GroupNotificationSchema.statics.findActiveForUser = async function(
  userId: string,
  since?: Date
): Promise<IGroupNotification[]> {
  const query: any = {
    isActive: true,
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: { $gt: new Date() } },
    ],
  };
  
  if (since) {
    query.createdAt = { $gte: since };
  }
  
  // Find notifications targeting this user
  // Note: The actual follower check is done by FanoutService
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(100)
    .lean()
    .exec();
};

/**
 * Find group notifications by actor user ID
 */
GroupNotificationSchema.statics.findByActorUserId = async function(
  actorUserId: string,
  limit: number = 20
): Promise<IGroupNotification[]> {
  return this.find({ actorUserId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
    .exec();
};

/**
 * Increment view count
 */
GroupNotificationSchema.statics.incrementViewCount = async function(
  groupNotificationId: string
): Promise<void> {
  await this.updateOne(
    { groupNotificationId },
    { $inc: { 'stats.viewCount': 1 } }
  );
};

/**
 * Increment click count
 */
GroupNotificationSchema.statics.incrementClickCount = async function(
  groupNotificationId: string
): Promise<void> {
  await this.updateOne(
    { groupNotificationId },
    { $inc: { 'stats.clickCount': 1 } }
  );
};

const GroupNotification = mongoose.model<IGroupNotification, GroupNotificationModel>(
  'GroupNotification',
  GroupNotificationSchema
);

export default GroupNotification;
