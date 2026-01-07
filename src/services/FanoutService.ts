import { logger } from '../utils/logger';
import GroupNotification, { IGroupNotification } from '../models/GroupNotification';
import Notification, { INotification } from '../models/Notification';
import { RedisCache } from '../config/redis';
// import axios from 'axios'; // Not used in current implementation

/**
 * FanoutService
 * 
 * Implements fanout-on-read strategy for large audiences:
 * - Detects high-follower-count users (>10k followers)
 * - Creates group notifications instead of individual rows
 * - Computes recipients on-read when user opens inbox
 * - Merges group notifications with personal notifications
 */

export interface FanoutConfig {
  highFollowerThreshold: number; // Default: 10,000
  cacheFollowersTTL: number; // Cache followers list TTL (seconds)
  maxGroupNotificationsPerFetch: number; // Max group notifications per inbox fetch
  followerServiceUrl: string; // URL to follower service API
}

export interface UserNotificationFeed {
  personalNotifications: INotification[];
  groupNotifications: Array<{
    notification: IGroupNotification;
    isRelevant: boolean;
    readStatus?: boolean;
  }>;
  total: number;
  hasMore: boolean;
}

export class FanoutService {
  private config: FanoutConfig;

  constructor(config?: Partial<FanoutConfig>) {
    this.config = {
      highFollowerThreshold: config?.highFollowerThreshold || 10000,
      cacheFollowersTTL: config?.cacheFollowersTTL || 300, // 5 minutes
      maxGroupNotificationsPerFetch: config?.maxGroupNotificationsPerFetch || 50,
      followerServiceUrl: config?.followerServiceUrl || process.env.FOLLOWER_SERVICE_URL || 'http://localhost:4000',
    };
  }

  /**
   * Check if user has high follower count (should use fanout-on-read)
   */
  async shouldUseFanoutOnRead(userId: string, followerCount?: number): Promise<boolean> {
    try {
      // If follower count provided, use it
      if (followerCount !== undefined) {
        return followerCount >= this.config.highFollowerThreshold;
      }

      // Otherwise fetch from cache or service
      const cachedCount = await RedisCache.get(`follower_count:${userId}`);
      if (cachedCount) {
        return parseInt(cachedCount, 10) >= this.config.highFollowerThreshold;
      }

      // Fetch from follower service
      const count = await this.getFollowerCount(userId);
      
      // Cache for 5 minutes
      await RedisCache.set(
        `follower_count:${userId}`,
        count.toString(),
        this.config.cacheFollowersTTL
      );

      return count >= this.config.highFollowerThreshold;
    } catch (error) {
      logger.error('Error checking fanout strategy:', error);
      // Default to fanout-on-write (safer)
      return false;
    }
  }

  /**
   * Get follower count for user
   */
  private async getFollowerCount(userId: string): Promise<number> {
    try {
      const response = await fetch(
        `${this.config.followerServiceUrl}/users/${userId}/follower-count`,
        { 
          signal: AbortSignal.timeout(2000),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      if (!response.ok) return 0;
      const data = await response.json() as { count?: number };
      return data.count || 0;
    } catch (error) {
      logger.error(`Error fetching follower count for ${userId}:`, error);
      return 0;
    }
  }

  /**
   * Check if user follows another user
   */
  async isFollowing(userId: string, targetUserId: string): Promise<boolean> {
    try {
      // Check cache first
      const cacheKey = `following:${userId}:${targetUserId}`;
      const cached = await RedisCache.get(cacheKey);
      
      if (cached !== null) {
        return cached === '1';
      }

      // Fetch from follower service
      const response = await fetch(
        `${this.config.followerServiceUrl}/users/${userId}/following/${targetUserId}`,
        { 
          signal: AbortSignal.timeout(1000),
          headers: { 'Content-Type': 'application/json' },
        }
      );

      if (!response.ok) return false;
      const data = await response.json() as { isFollowing?: boolean };
      const isFollowing = data.isFollowing || false;

      // Cache for 5 minutes
      await RedisCache.set(cacheKey, isFollowing ? '1' : '0', this.config.cacheFollowersTTL);

      return isFollowing;
    } catch (error) {
      logger.error(`Error checking follow status ${userId} -> ${targetUserId}:`, error);
      return false;
    }
  }

  /**
   * Get followers for a user
   */
  async getFollowers(userId: string, limit?: number): Promise<string[]> {
    try {
      // Check cache first
      const cacheKey = `followers:${userId}`;
      const cached = await RedisCache.get(cacheKey);
      
      if (cached) {
        const followers = JSON.parse(cached);
        return limit ? followers.slice(0, limit) : followers;
      }

      // Fetch from follower service
      const url = new URL(`${this.config.followerServiceUrl}/users/${userId}/followers`);
      url.searchParams.set('limit', String(limit || 1000));
      
      const response = await fetch(url.toString(), { 
        signal: AbortSignal.timeout(3000),
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) return [];
      const data = await response.json() as { followers?: string[] };

      const followers = data.followers || [];

      // Cache for 5 minutes
      await RedisCache.set(cacheKey, JSON.stringify(followers), this.config.cacheFollowersTTL);

      return followers;
    } catch (error) {
      logger.error(`Error fetching followers for ${userId}:`, error);
      return [];
    }
  }

  /**
   * Compute user's notification feed (personal + relevant group notifications)
   */
  async computeNotificationFeed(
    userId: string,
    options: {
      limit?: number;
      offset?: number;
      since?: Date;
      includeRead?: boolean;
    } = {}
  ): Promise<UserNotificationFeed> {
    try {
      const limit = options.limit || 20;
      const offset = options.offset || 0;

      // Fetch personal notifications
      const personalQuery: any = { userId };
      if (!options.includeRead) {
        personalQuery.isRead = false;
      }
      if (options.since) {
        personalQuery.createdAt = { $gte: options.since };
      }

      const personalNotifications = await Notification.find(personalQuery)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .exec();

      // Fetch active group notifications
      const groupNotifications = await GroupNotification.findActiveForUser(userId, options.since);

      // Filter group notifications based on user's following list
      const relevantGroupNotifications = await Promise.all(
        groupNotifications.map(async (groupNotif) => {
          // Check if user follows the actor
          const isFollowing = await this.isFollowing(userId, groupNotif.actorUserId);

          // Check if user is explicitly excluded
          const isExcluded = groupNotif.excludeUserIds?.includes(userId);

          // Check if user is explicitly included (for custom targeting)
          const isIncluded = groupNotif.targetUserIds?.includes(userId);

          const isRelevant = !isExcluded && (
            isFollowing ||
            isIncluded ||
            groupNotif.targetAudience === 'custom'
          );

          // Get read status for this specific user
          const readStatus = await this.getGroupNotificationReadStatus(
            userId,
            groupNotif.groupNotificationId
          );

          return {
            notification: groupNotif,
            isRelevant,
            readStatus,
          };
        })
      );

      // Filter to only relevant notifications
      const filteredGroupNotifications = relevantGroupNotifications.filter(
        (item) => item.isRelevant && (!options.includeRead ? !item.readStatus : true)
      );

      const total = personalNotifications.length + filteredGroupNotifications.length;
      const hasMore = total >= limit;

      return {
        personalNotifications: personalNotifications as any as INotification[],
        groupNotifications: filteredGroupNotifications,
        total,
        hasMore,
      };
    } catch (error) {
      logger.error('Error computing notification feed:', error);
      throw error;
    }
  }

  /**
   * Mark group notification as read for specific user
   */
  async markGroupNotificationAsRead(
    userId: string,
    groupNotificationId: string
  ): Promise<void> {
    try {
      const cacheKey = `group_notif_read:${userId}:${groupNotificationId}`;
      await RedisCache.set(cacheKey, '1', 30 * 24 * 60 * 60); // 30 days

      // Increment view count
      await GroupNotification.incrementViewCount(groupNotificationId);

      logger.info(`Group notification marked as read: ${groupNotificationId} by ${userId}`);
    } catch (error) {
      logger.error('Error marking group notification as read:', error);
    }
  }

  /**
   * Get group notification read status for user
   */
  async getGroupNotificationReadStatus(
    userId: string,
    groupNotificationId: string
  ): Promise<boolean> {
    try {
      const cacheKey = `group_notif_read:${userId}:${groupNotificationId}`;
      const cached = await RedisCache.get(cacheKey);
      return cached === '1';
    } catch (error) {
      logger.error('Error getting group notification read status:', error);
      return false;
    }
  }

  /**
   * Get estimated reach for group notification
   */
  async getEstimatedReach(actorUserId: string, targetAudience: string): Promise<number> {
    try {
      if (targetAudience === 'followers') {
        return await this.getFollowerCount(actorUserId);
      }
      return 0;
    } catch (error) {
      logger.error('Error getting estimated reach:', error);
      return 0;
    }
  }

  /**
   * Get unread count for user (personal + group notifications)
   */
  async getUnreadCount(userId: string): Promise<number> {
    try {
      // Count unread personal notifications
      const personalUnreadCount = await Notification.countDocuments({
        userId,
        isRead: false,
      });

      // Get active group notifications
      const groupNotifications = await GroupNotification.findActiveForUser(userId);

      // Count unread group notifications
      let groupUnreadCount = 0;
      for (const groupNotif of groupNotifications) {
        const isFollowing = await this.isFollowing(userId, groupNotif.actorUserId);
        const isRead = await this.getGroupNotificationReadStatus(userId, groupNotif.groupNotificationId);
        
        if (isFollowing && !isRead) {
          groupUnreadCount++;
        }
      }

      return personalUnreadCount + groupUnreadCount;
    } catch (error) {
      logger.error('Error getting unread count:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const fanoutService = new FanoutService();
