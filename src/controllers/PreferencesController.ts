import { Request, Response } from 'express';
import UserPreferences from '../models/UserPreferences';
import { logger } from '../utils/logger';

/**
 * PreferencesController
 * Handles API requests for user notification preferences
 */
class PreferencesController {
  /**
   * GET /users/:userId/notification-preferences
   * Get user's notification preferences
   */
  async getPreferences(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;

      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      // Find or create preferences
      let preferences = await UserPreferences.findOne({ userId });

      if (!preferences) {
        // Create default preferences
        preferences = new UserPreferences({
          userId,
          notificationTypes: {
            follow: { isEnabled: true },
            like: { isEnabled: true },
            comment: { isEnabled: true },
            mention: { isEnabled: true },
            message: { isEnabled: true },
          },
          quietHours: {
            enabled: false,
            start: '22:00',
            end: '09:00',
            timezone: 'UTC',
          },
        });
        await preferences.save();
        logger.info(`Created default preferences for user ${userId}`);
      }

      res.status(200).json({
        userId: preferences.userId,
        notificationTypes: preferences.notificationTypes,
        quietHours: preferences.quietHours,
        updatedAt: preferences.get('updatedAt'),
      });
    } catch (error) {
      logger.error('Error getting preferences:', error);
      res.status(500).json({ error: 'Failed to get preferences' });
    }
  }

  /**
   * POST /users/:userId/notification-preferences
   * Update user's notification preferences
   * Body: { notificationType: 'follow', isEnabled: false }
   * or: { quietHours: { enabled: true, start: '22:00', end: '09:00', timezone: 'America/New_York' } }
   */
  async updatePreferences(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const { notificationType, isEnabled, quietHours } = req.body;

      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      // Find or create preferences
      let preferences = await UserPreferences.findOne({ userId });

      if (!preferences) {
        preferences = new UserPreferences({
          userId,
          notificationTypes: {
            follow: { isEnabled: true },
            like: { isEnabled: true },
            comment: { isEnabled: true },
            mention: { isEnabled: true },
            message: { isEnabled: true },
          },
          quietHours: {
            enabled: false,
            start: '22:00',
            end: '09:00',
            timezone: 'UTC',
          },
        });
      }

      // Update notification type preference
      if (notificationType !== undefined && isEnabled !== undefined) {
        if (!preferences.notificationTypes) {
          preferences.notificationTypes = {} as any;
        }
        // Initialize notificationTypes if not present
        if (!preferences.notificationTypes) {
          preferences.notificationTypes = {};
        }
        if (!preferences.notificationTypes[notificationType]) {
          preferences.notificationTypes[notificationType] = { isEnabled: true };
        }
        preferences.notificationTypes[notificationType].isEnabled = isEnabled;
        logger.info(`Updated preference for user ${userId}: ${notificationType} = ${isEnabled}`);
      }

      // Update quiet hours
      if (quietHours !== undefined) {
        if (!preferences.quietHours) {
          preferences.quietHours = {
            enabled: false,
            start: '22:00',
            end: '09:00',
            timezone: 'UTC',
          };
        }
        if (quietHours.enabled !== undefined) {
          preferences.quietHours.enabled = quietHours.enabled;
        }
        if (quietHours.start !== undefined) {
          preferences.quietHours.start = quietHours.start;
        }
        if (quietHours.end !== undefined) {
          preferences.quietHours.end = quietHours.end;
        }
        if (quietHours.timezone !== undefined) {
          preferences.quietHours.timezone = quietHours.timezone;
        }
        logger.info(`Updated quiet hours for user ${userId}:`, preferences.quietHours);
      }

      await preferences.save();

      res.status(200).json({
        userId: preferences.userId,
        notificationTypes: preferences.notificationTypes,
        quietHours: preferences.quietHours,
        updatedAt: preferences.get('updatedAt'),
      });
    } catch (error) {
      logger.error('Error updating preferences:', error);
      res.status(500).json({ error: 'Failed to update preferences' });
    }
  }

  /**
   * PUT /users/:userId/notification-preferences/bulk
   * Bulk update notification preferences
   * Body: { notificationTypes: { follow: true, like: false, ... } }
   */
  async updateBulkPreferences(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const { notificationTypes } = req.body;

      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      if (!notificationTypes || typeof notificationTypes !== 'object') {
        res.status(400).json({ error: 'notificationTypes object is required' });
        return;
      }

      // Find or create preferences
      let preferences = await UserPreferences.findOne({ userId });

      if (!preferences) {
        preferences = new UserPreferences({
          userId,
          notificationTypes: {
            follow: { isEnabled: true },
            like: { isEnabled: true },
            comment: { isEnabled: true },
            mention: { isEnabled: true },
            message: { isEnabled: true },
          },
        });
      }

      // Update each notification type
      for (const [type, enabled] of Object.entries(notificationTypes)) {
        if (typeof enabled === 'boolean') {
          if (!preferences.notificationTypes) {
            preferences.notificationTypes = {} as any;
          }
          if (!preferences.notificationTypes) {
            preferences.notificationTypes = {};
          }
          if (!preferences.notificationTypes[type]) {
            preferences.notificationTypes[type] = { isEnabled: enabled };
          } else {
            preferences.notificationTypes[type].isEnabled = enabled;
          }
        }
      }

      await preferences.save();

      logger.info(`Bulk updated preferences for user ${userId}`);

      res.status(200).json({
        userId: preferences.userId,
        notificationTypes: preferences.notificationTypes,
        quietHours: preferences.quietHours,
        updatedAt: preferences.get('updatedAt'),
      });
    } catch (error) {
      logger.error('Error bulk updating preferences:', error);
      res.status(500).json({ error: 'Failed to update preferences' });
    }
  }
}

export default new PreferencesController();
