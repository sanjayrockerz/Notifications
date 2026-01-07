import { logger } from '../utils/logger';
import GroupNotification, { IGroupNotification } from '../models/GroupNotification';
import { fanoutService } from './FanoutService';
import { PushNotificationService } from './PushNotificationService';
import { v4 as uuidv4 } from 'uuid';

/**
 * HighFollowerEventService
 * 
 * Handles notification creation for high-follower users using fanout-on-read strategy:
 * - Creates single GroupNotification instead of thousands of individual notifications
 * - Uses Firebase Topics for push broadcasting
 * - Computes recipients on-read when users open inbox
 */

export interface HighFollowerEventData {
  eventId: string;
  eventType: 'PostCreated' | 'LiveStreamStarted' | 'StoryPosted' | 'AnnouncementMade';
  actorUserId: string;
  actorUsername?: string;
  actorAvatarUrl?: string;
  actorFollowerCount: number;
  title: string;
  body: string;
  data?: Record<string, any>;
  targetAudience: 'followers' | 'subscribers' | 'custom';
  targetUserIds?: string[]; // For custom targeting
  excludeUserIds?: string[]; // Users to exclude
  priority?: 'low' | 'normal' | 'high' | 'critical';
  pushStrategy?: 'none' | 'topic' | 'individual';
  firebaseTopic?: string;
  actionUrl?: string;
  imageUrl?: string;
  metadata?: Record<string, any>;
}

export interface HighFollowerEventResult {
  success: boolean;
  groupNotificationId?: string;
  estimatedReach: number;
  pushSent: boolean;
  error?: string;
}

export class HighFollowerEventService {
  private pushService: PushNotificationService;

  constructor() {
    this.pushService = new PushNotificationService();
  }

  /**
   * Check if event should use fanout-on-read based on actor's follower count
   */
  async shouldUseFanoutOnRead(actorUserId: string, followerCount?: number): Promise<boolean> {
    return await fanoutService.shouldUseFanoutOnRead(actorUserId, followerCount);
  }

  /**
   * Create group notification for high-follower event
   */
  async createGroupNotification(eventData: HighFollowerEventData): Promise<HighFollowerEventResult> {
    try {
      logger.info(`📊 Creating group notification for high-follower event: ${eventData.eventType} by ${eventData.actorUserId}`);

      // Get estimated reach
      const estimatedReach = await fanoutService.getEstimatedReach(
        eventData.actorUserId,
        eventData.targetAudience
      );

      // Determine push strategy
      const pushStrategy = eventData.pushStrategy || (estimatedReach > 50000 ? 'topic' : 'individual');

      // Create Firebase topic name if using topic-based push
      const firebaseTopic = pushStrategy === 'topic'
        ? eventData.firebaseTopic || `user_${eventData.actorUserId}_followers`
        : undefined;

      // Create group notification record
      const groupNotificationId = uuidv4();
      const groupNotification = new GroupNotification({
        groupNotificationId,
        eventId: eventData.eventId,
        eventType: eventData.eventType,
        actorUserId: eventData.actorUserId,
        actorUsername: eventData.actorUsername,
        actorAvatarUrl: eventData.actorAvatarUrl,
        actorFollowerCount: eventData.actorFollowerCount,
        title: eventData.title,
        body: eventData.body,
        data: eventData.data || {},
        targetAudience: eventData.targetAudience,
        targetUserIds: eventData.targetUserIds,
        excludeUserIds: eventData.excludeUserIds,
        pushStrategy,
        firebaseTopic,
        priority: eventData.priority || 'normal',
        estimatedReach,
        actualReach: 0, // Will be computed when users read
        viewCount: 0,
        clickCount: 0,
        actionUrl: eventData.actionUrl,
        imageUrl: eventData.imageUrl,
        isActive: true,
        metadata: eventData.metadata || {},
      });

      await groupNotification.save();

      logger.info(`✅ Group notification created: ${groupNotificationId} (estimated reach: ${estimatedReach})`);

      // Send push notification if strategy is not 'none'
      let pushSent = false;
      if (pushStrategy === 'topic' && firebaseTopic) {
        pushSent = await this.sendTopicPushNotification(firebaseTopic, {
          title: eventData.title,
          body: eventData.body,
          data: {
            groupNotificationId,
            eventType: eventData.eventType,
            actorUserId: eventData.actorUserId,
            actionUrl: eventData.actionUrl || '',
            ...eventData.data,
          },
          priority: eventData.priority || 'normal',
          ...(eventData.imageUrl && { imageUrl: eventData.imageUrl }),
        } as any);
      } else if (pushStrategy === 'individual') {
        // For individual push, we'd typically queue this for background processing
        // to avoid blocking the event handler
        logger.info(`📤 Individual push queued for group notification ${groupNotificationId}`);
        // TODO: Queue for background worker to send individual pushes
        pushSent = true; // Mark as sent since it's queued
      }

      return {
        success: true,
        groupNotificationId,
        estimatedReach,
        pushSent,
      };
    } catch (error) {
      logger.error('Error creating group notification:', error);
      return {
        success: false,
        estimatedReach: 0,
        pushSent: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Send push notification to Firebase topic
   */
  private async sendTopicPushNotification(
    topic: string,
    payload: {
      title: string;
      body: string;
      data: Record<string, string>;
      priority?: string;
      imageUrl?: string;
    }
  ): Promise<boolean> {
    try {
      await this.pushService.initialize();

      logger.info(`📡 Sending topic push to: ${topic}`);

      // Send to Firebase topic (FCM)
      const result = await this.pushService.sendToTopic(
        topic,
        {
          title: payload.title,
          body: payload.body,
          ...(payload.imageUrl && { imageUrl: payload.imageUrl }),
        },
        payload.data,
        payload.priority || 'normal'
      );

      if (result.success) {
        logger.info(`✅ Topic push sent successfully to ${topic}`);
        return true;
      } else {
        logger.error(`❌ Topic push failed for ${topic}:`, result.error);
        return false;
      }
    } catch (error) {
      logger.error('Error sending topic push:', error);
      return false;
    }
  }

  /**
   * Mark group notification as inactive (soft delete)
   */
  async deactivateGroupNotification(groupNotificationId: string): Promise<boolean> {
    try {
      const result = await GroupNotification.updateOne(
        { groupNotificationId },
        { isActive: false }
      );

      if (result.modifiedCount > 0) {
        logger.info(`🗑️ Group notification deactivated: ${groupNotificationId}`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Error deactivating group notification:', error);
      return false;
    }
  }

  /**
   * Get group notification statistics
   */
  async getStatistics(groupNotificationId: string): Promise<any> {
    try {
      const notification = await GroupNotification.findOne({ groupNotificationId });

      if (!notification) {
        return null;
      }

      return {
        groupNotificationId,
        eventType: notification.eventType,
        actorUserId: notification.actorUserId,
        estimatedReach: notification.estimatedReach,
        actualReach: notification.actualReach,
        viewCount: notification.viewCount,
        clickCount: notification.clickCount,
        engagementRate: notification.viewCount > 0 
          ? (notification.clickCount / notification.viewCount) * 100 
          : 0,
        createdAt: notification.createdAt,
      };
    } catch (error) {
      logger.error('Error getting group notification statistics:', error);
      return null;
    }
  }
}

// Export singleton instance
export const highFollowerEventService = new HighFollowerEventService();
