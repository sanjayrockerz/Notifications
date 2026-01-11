import { logger } from '../utils/logger';
import GroupNotification, { IGroupNotification } from '../models/GroupNotification';
import Notification, { INotification } from '../models/Notification';
import { RedisCache } from '../config/redis';
import { getOrSetWithSWR, coalesce, getCacheStats } from '../utils/stampedeProtection';
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

/**
 * Cursor-based pagination interface
 * Uses createdAt + _id for stable cursor (handles same-timestamp documents)
 */
export interface PaginationCursor {
  createdAt: string; // ISO date string
  id: string; // MongoDB _id as string
}

export interface CursorPaginationOptions {
  limit?: number;
  cursor?: PaginationCursor | null;
  since?: Date;
  includeRead?: boolean;
}

export interface CursorPaginatedResult<T> {
  items: T[];
  nextCursor: PaginationCursor | null;
  hasMore: boolean;
  total?: number;
}

export function encodeCursor(cursor: PaginationCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(encoded: string): PaginationCursor | null {
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (parsed.createdAt && parsed.id) {
      return parsed as PaginationCursor;
    }
    return null;
  } catch {
    return null;
  }
}

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
  nextCursor?: string | undefined;
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
   * Get follower count for user (with stampede protection)
   */
  private async getFollowerCount(userId: string): Promise<number> {
    const { value } = await getOrSetWithSWR(
      `follower_count:${userId}`,
      async () => {
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
      },
      { ttl: 300, staleTtl: 600 } // 5 min fresh, 10 min stale
    );
    return value;
  }

  /**
   * Check if user follows another user (with stampede protection)
   */
  async isFollowing(userId: string, targetUserId: string): Promise<boolean> {
    const { value } = await getOrSetWithSWR(
      `following:${userId}:${targetUserId}`,
      async () => {
        try {
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
          return data.isFollowing || false;
        } catch (error) {
          logger.error(`Error checking follow status ${userId} -> ${targetUserId}:`, error);
          return false;
        }
      },
      { ttl: this.config.cacheFollowersTTL, staleTtl: this.config.cacheFollowersTTL * 2 }
    );
    return value;
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
   * Compute user's notification feed with CURSOR-BASED pagination
   * 
   * Uses createdAt + _id as cursor to avoid deep skip() scans
   * that become O(n) expensive at scale.
   * 
   * Cursor format: { createdAt: ISO string, id: ObjectId string }
   */
  async computeNotificationFeedWithCursor(
    userId: string,
    options: CursorPaginationOptions = {}
  ): Promise<CursorPaginatedResult<INotification>> {
    try {
      const limit = Math.min(options.limit || 20, 100); // Cap at 100

      // Build query with cursor-based pagination
      const query: any = { userId };
      
      if (!options.includeRead) {
        query.isRead = false;
      }
      
      // Cursor-based: fetch items OLDER than the cursor
      if (options.cursor) {
        const cursorDate = new Date(options.cursor.createdAt);
        query.$or = [
          { createdAt: { $lt: cursorDate } },
          { 
            createdAt: cursorDate,
            _id: { $lt: options.cursor.id }
          }
        ];
      } else if (options.since) {
        // First page with since filter
        query.createdAt = { $gte: options.since };
      }

      // Fetch limit+1 to determine if there are more results
      const notifications = await Notification.find(query)
        .sort({ createdAt: -1, _id: -1 }) // Compound sort for stable ordering
        .limit(limit + 1)
        .lean()
        .exec() as any as INotification[];

      // Determine if there are more results
      const hasMore = notifications.length > limit;
      const items = hasMore ? notifications.slice(0, limit) : notifications;

      // Generate next cursor from last item
      let nextCursor: PaginationCursor | null = null;
      if (hasMore && items.length > 0) {
        const lastItem = items[items.length - 1]!;
        nextCursor = {
          createdAt: (lastItem.createdAt as Date).toISOString(),
          id: (lastItem as any)._id.toString(),
        };
      }

      return {
        items,
        nextCursor,
        hasMore,
      };
    } catch (error) {
      logger.error('Error computing notification feed with cursor:', error);
      throw error;
    }
  }

  /**
   * Compute user's notification feed (personal + relevant group notifications)
   * @deprecated Use computeNotificationFeedWithCursor for production - offset pagination is O(n)
   */
  async computeNotificationFeed(
    userId: string,
    options: {
      limit?: number;
      offset?: number;
      cursor?: string | undefined; // base64url encoded cursor
      since?: Date;
      includeRead?: boolean;
    } = {}
  ): Promise<UserNotificationFeed> {
    try {
      const limit = Math.min(options.limit || 20, 100);
      
      // If cursor provided, use cursor-based pagination
      const parsedCursor = options.cursor ? decodeCursor(options.cursor) : null;
      
      // Build query with cursor-based pagination (preferred) or offset (deprecated)
      const personalQuery: any = { userId };
      if (!options.includeRead) {
        personalQuery.isRead = false;
      }
      
      // Cursor-based pagination (efficient)
      if (parsedCursor) {
        const cursorDate = new Date(parsedCursor.createdAt);
        personalQuery.$or = [
          { createdAt: { $lt: cursorDate } },
          { 
            createdAt: cursorDate,
            _id: { $lt: parsedCursor.id }
          }
        ];
      } else if (options.since) {
        personalQuery.createdAt = { $gte: options.since };
      }

      // Fetch limit+1 to determine if there are more results
      let personalNotifications;
      if (parsedCursor || !options.offset) {
        // Cursor-based: no skip()
        personalNotifications = await Notification.find(personalQuery)
          .sort({ createdAt: -1, _id: -1 })
          .limit(limit + 1)
          .lean()
          .exec();
      } else {
        // Legacy offset-based (deprecated - O(n) at scale)
        logger.warn('Using deprecated offset pagination - migrate to cursor-based');
        personalNotifications = await Notification.find(personalQuery)
          .sort({ createdAt: -1, _id: -1 })
          .skip(options.offset)
          .limit(limit + 1)
          .lean()
          .exec();
      }

      // Determine if there are more personal notifications
      const hasMorePersonal = personalNotifications.length > limit;
      const personalItems = hasMorePersonal 
        ? personalNotifications.slice(0, limit) 
        : personalNotifications;

      // Generate next cursor
      let nextCursor: string | undefined;
      if (hasMorePersonal && personalItems.length > 0) {
        const lastItem = personalItems[personalItems.length - 1] as any;
        nextCursor = encodeCursor({
          createdAt: (lastItem.createdAt as Date).toISOString(),
          id: lastItem._id.toString(),
        });
      }

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

      const total = personalItems.length + filteredGroupNotifications.length;
      const hasMore = hasMorePersonal || filteredGroupNotifications.length > 0;

      return {
        personalNotifications: personalItems as any as INotification[],
        groupNotifications: filteredGroupNotifications,
        total,
        hasMore,
        nextCursor,
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

  /**
   * Get cache statistics for monitoring
   */
  getCacheStats() {
    return getCacheStats();
  }

  /**
   * Get current configuration (for debugging/monitoring)
   */
  getConfig(): FanoutConfig {
    return { ...this.config };
  }
}

// ============================================================================
// Factory Pattern for FanoutService
// ============================================================================

export interface FanoutServiceOptions extends Partial<FanoutConfig> {
  /** Enable/disable fanout-on-read feature entirely */
  enabled?: boolean;
  /** Force all users to use fanout-on-read (for testing) */
  forceFanoutOnRead?: boolean;
  /** Force all users to use fanout-on-write (for testing) */
  forceFanoutOnWrite?: boolean;
  /** Mock follower service for testing */
  mockFollowerService?: MockFollowerService;
}

export interface MockFollowerService {
  getFollowerCount(userId: string): Promise<number>;
  isFollowing(userId: string, targetUserId: string): Promise<boolean>;
  getFollowers(userId: string, limit?: number): Promise<string[]>;
}

/**
 * Create a FanoutService with explicit configuration
 * Use this factory for better testability and explicit feature flags
 */
export function createFanoutService(options: FanoutServiceOptions = {}): FanoutService {
  // Build config object, only including defined values
  const config: Partial<FanoutConfig> = {};
  if (options.highFollowerThreshold !== undefined) {
    config.highFollowerThreshold = options.highFollowerThreshold;
  }
  if (options.cacheFollowersTTL !== undefined) {
    config.cacheFollowersTTL = options.cacheFollowersTTL;
  }
  if (options.maxGroupNotificationsPerFetch !== undefined) {
    config.maxGroupNotificationsPerFetch = options.maxGroupNotificationsPerFetch;
  }
  if (options.followerServiceUrl !== undefined) {
    config.followerServiceUrl = options.followerServiceUrl;
  }

  const service = new FanoutService(config);

  // If mock service provided, inject it (useful for testing)
  if (options.mockFollowerService) {
    // @ts-ignore - for testing only
    service._mockFollowerService = options.mockFollowerService;
  }

  // Override shouldUseFanoutOnRead if forced
  if (options.forceFanoutOnRead !== undefined || options.forceFanoutOnWrite !== undefined) {
    const originalMethod = service.shouldUseFanoutOnRead.bind(service);
    service.shouldUseFanoutOnRead = async (userId: string, followerCount?: number) => {
      if (options.forceFanoutOnRead) {
        logger.debug('Fanout-on-read forced for all users', { userId });
        return true;
      }
      if (options.forceFanoutOnWrite) {
        logger.debug('Fanout-on-write forced for all users', { userId });
        return false;
      }
      return originalMethod(userId, followerCount);
    };
  }

  // If disabled entirely, make all methods return empty/default values
  if (options.enabled === false) {
    logger.info('FanoutService disabled - returning personal notifications only');
    
    const originalComputeFeed = service.computeNotificationFeed.bind(service);
    service.computeNotificationFeed = async (userId, opts) => {
      const result = await originalComputeFeed(userId, opts);
      // Clear group notifications when fanout is disabled
      result.groupNotifications = [];
      return result;
    };
  }

  return service;
}

// Export singleton instance with default configuration
export const fanoutService = new FanoutService();

/**
 * Reset the singleton instance (for testing)
 */
export function _resetFanoutService(): void {
  // Allow tests to reset the singleton
  Object.setPrototypeOf(fanoutService, FanoutService.prototype);
}

/**
 * Feature flag check for fanout-on-read
 * Can be used in other parts of the application to check if fanout is enabled
 */
export function isFanoutOnReadEnabled(): boolean {
  const envFlag = process.env.FANOUT_ON_READ_ENABLED;
  return envFlag !== 'false' && envFlag !== '0';
}

/**
 * Get the current fanout strategy for a user
 * Useful for debugging and monitoring
 */
export async function getFanoutStrategy(userId: string): Promise<{
  strategy: 'fanout-on-read' | 'fanout-on-write';
  reason: string;
  followerCount?: number;
  threshold: number;
}> {
  const threshold = fanoutService.getConfig().highFollowerThreshold;
  
  try {
    const shouldUseFanoutOnRead = await fanoutService.shouldUseFanoutOnRead(userId);
    
    return {
      strategy: shouldUseFanoutOnRead ? 'fanout-on-read' : 'fanout-on-write',
      reason: shouldUseFanoutOnRead 
        ? `User has >= ${threshold} followers`
        : `User has < ${threshold} followers`,
      threshold,
    };
  } catch (error) {
    return {
      strategy: 'fanout-on-write',
      reason: 'Error determining strategy, defaulting to fanout-on-write',
      threshold,
    };
  }
}
