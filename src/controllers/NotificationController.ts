
import { Request, Response } from 'express';
import Notification from '../models/Notification';
import GroupNotification from '../models/GroupNotification';
import mongoose from 'mongoose';
import { createClient } from 'redis';
import { fanoutService } from '../services/FanoutService';
import { logger } from '../utils/logger';

// Use a singleton Redis client
const redisClient = createClient();
redisClient.connect();

// Extract userId from req.user (assume JWT middleware sets req.user.id)
function getUserIdFromAuth(req: Request): string | null {
  if (req.user && typeof req.user === 'object' && 'id' in req.user) {
    return (req.user as any).id;
  }
  return null;
}

export default {
  async getNotifications(req: Request, res: Response) {
    try {
      const userId = getUserIdFromAuth(req);
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const includeRead = req.query.includeRead === 'true';
      const since = req.query.since ? new Date(req.query.since as string) : undefined;

      // Use FanoutService to compute complete feed (personal + group notifications)
      const feed = await fanoutService.computeNotificationFeed(userId, {
        limit,
        includeRead,
        ...(since && { since }),
      });

      // Merge and sort personal and group notifications by createdAt
      const mergedNotifications = [
        ...feed.personalNotifications.map((n) => ({
          type: 'personal',
          id: n.notificationId,
          title: n.title,
          body: n.body,
          data: n.data,
          category: n.category,
          priority: n.priority,
          isRead: n.isRead,
          createdAt: n.createdAt,
          actionUrl: n.data?.actionUrl,
          imageUrl: n.imageUrl,
        })),
        ...feed.groupNotifications.map((gn) => ({
          type: 'group',
          id: gn.notification.groupNotificationId,
          title: gn.notification.title,
          body: gn.notification.body,
          data: gn.notification.data,
          category: gn.notification.eventType,
          priority: gn.notification.priority,
          isRead: gn.readStatus || false,
          createdAt: gn.notification.createdAt,
          actionUrl: gn.notification.actionUrl,
          imageUrl: gn.notification.imageUrl,
          actor: {
            userId: gn.notification.actorUserId,
            username: gn.notification.actorUsername,
            avatarUrl: gn.notification.actorAvatarUrl,
          },
          stats: {
            viewCount: gn.notification.viewCount,
            clickCount: gn.notification.clickCount,
          },
        })),
      ].sort((a, b) => {
        const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
        const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
        return bTime - aTime;
      });

      // Take only the limit
      const items = mergedNotifications.slice(0, limit);
      const hasMore = feed.hasMore;

      return res.json({
        notifications: items,
        total: feed.total,
        hasMore,
      });
    } catch (err) {
      logger.error('Error fetching notifications:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  },

  async getUnreadCount(req: Request, res: Response) {
    try {
      const userId = getUserIdFromAuth(req);
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      
      const cacheKey = `unreadCount:${userId}`;
      let cached: string | null = null;
      try {
        cached = await redisClient.get(cacheKey);
      } catch {}
      
      if (cached !== null) {
        return res.json({ unreadCount: Number(cached) });
      }
      
      // Use FanoutService to get combined unread count (personal + group)
      const unreadCount = await fanoutService.getUnreadCount(userId);
      
      try {
        await redisClient.setEx(cacheKey, 30, String(unreadCount));
      } catch {}
      
      return res.json({ unreadCount });
    } catch (err) {
      logger.error('Error fetching unread count:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  },

  async markAsRead(req: Request, res: Response) {
    try {
      const userId = getUserIdFromAuth(req);
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      
      const { notificationId } = req.params;
      const { type } = req.query; // 'personal' or 'group'

      if (type === 'group') {
        // Mark group notification as read for this user
        if (!notificationId) {
          return res.status(400).json({ success: false, error: 'notificationId required' });
        }
        await fanoutService.markGroupNotificationAsRead(userId, notificationId);
        return res.json({ success: true, readAt: new Date() });
      }

      // Mark personal notification as read
      const notification = await Notification.findOneAndUpdate(
        { notificationId, userId },
        { $set: { isRead: true, readAt: new Date() } },
        { new: true }
      );
      
      if (!notification) return res.status(404).json({ success: false, error: 'Not found' });
      
      // Invalidate unread count cache
      try {
        await redisClient.del(`unreadCount:${userId}`);
      } catch {}
      
      return res.json({ success: true, readAt: notification.readAt });
    } catch (err) {
      logger.error('Error marking notification as read:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  },

  async markBatchAsRead(req: Request, res: Response) {
    try {
      const userId = getUserIdFromAuth(req);
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const { notificationIds } = req.body;
      if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
        return res.status(400).json({ success: false, error: 'notificationIds required' });
      }
      const result = await Notification.updateMany(
        { _id: { $in: notificationIds }, userId },
        { $set: { readAt: new Date() } }
      );
      return res.json({ success: true, markedCount: result.modifiedCount });
    } catch (err) {
      return res.status(500).json({ error: 'Server error' });
    }
  },
};
