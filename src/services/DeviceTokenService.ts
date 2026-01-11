/**
 * Device Token Lifecycle Service
 * 
 * Handles the complete lifecycle of device push tokens:
 * 1. Registration and validation
 * 2. Active/inactive state management
 * 3. Failure tracking and automatic deactivation
 * 4. Periodic cleanup of invalid tokens
 * 5. Token refresh handling
 * 
 * INVALID TOKEN DETECTION:
 * - FCM: 'messaging/registration-token-not-registered', 'messaging/invalid-registration-token'
 * - APNs: 400 BadDeviceToken, 410 Unregistered
 * 
 * CLEANUP STRATEGY:
 * 1. Immediate deactivation on explicit invalid token errors
 * 2. Deactivation after 5 consecutive failures
 * 3. Scheduled cleanup of tokens not seen for 30+ days
 * 4. Hard delete of deactivated tokens after 90 days
 */

import { logger } from '../utils/logger';
import Device, { IDevice, DeviceModel } from '../models/Device';
import mongoose, { Document } from 'mongoose';

// ============================================================================
// Token Error Types
// ============================================================================

export enum TokenErrorType {
  INVALID = 'INVALID', // Token is malformed or wrong format
  UNREGISTERED = 'UNREGISTERED', // Token was once valid but app was uninstalled
  EXPIRED = 'EXPIRED', // Token has expired (APNs sandbox tokens)
  CREDENTIAL_ERROR = 'CREDENTIAL_ERROR', // Server credentials issue
  RATE_LIMITED = 'RATE_LIMITED', // Too many requests
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE', // FCM/APNs down
  UNKNOWN = 'UNKNOWN',
}

export interface TokenError {
  type: TokenErrorType;
  shouldDeactivate: boolean;
  shouldRetry: boolean;
  retryAfter?: number; // seconds
  originalError: any;
}

// ============================================================================
// FCM Error Classification
// ============================================================================

export function classifyFCMError(error: any): TokenError {
  const errorCode = error?.code || error?.errorCode || '';
  
  switch (errorCode) {
    case 'messaging/registration-token-not-registered':
    case 'messaging/invalid-registration-token':
      return {
        type: TokenErrorType.UNREGISTERED,
        shouldDeactivate: true,
        shouldRetry: false,
        originalError: error,
      };
    
    case 'messaging/mismatched-credential':
    case 'messaging/invalid-package-name':
    case 'messaging/authentication-error':
      return {
        type: TokenErrorType.CREDENTIAL_ERROR,
        shouldDeactivate: false,
        shouldRetry: false, // Need to fix credentials
        originalError: error,
      };
    
    case 'messaging/message-rate-exceeded':
    case 'messaging/device-message-rate-exceeded':
      return {
        type: TokenErrorType.RATE_LIMITED,
        shouldDeactivate: false,
        shouldRetry: true,
        retryAfter: 60,
        originalError: error,
      };
    
    case 'messaging/server-unavailable':
    case 'messaging/internal-error':
      return {
        type: TokenErrorType.SERVICE_UNAVAILABLE,
        shouldDeactivate: false,
        shouldRetry: true,
        retryAfter: 30,
        originalError: error,
      };
    
    default:
      return {
        type: TokenErrorType.UNKNOWN,
        shouldDeactivate: false,
        shouldRetry: true,
        originalError: error,
      };
  }
}

// ============================================================================
// APNs Error Classification
// ============================================================================

export function classifyAPNsError(status: number, reason?: string): TokenError {
  switch (status) {
    case 400:
      if (reason === 'BadDeviceToken') {
        return {
          type: TokenErrorType.INVALID,
          shouldDeactivate: true,
          shouldRetry: false,
          originalError: { status, reason },
        };
      }
      return {
        type: TokenErrorType.UNKNOWN,
        shouldDeactivate: false,
        shouldRetry: false, // Bad request, likely client error
        originalError: { status, reason },
      };
    
    case 403:
      return {
        type: TokenErrorType.CREDENTIAL_ERROR,
        shouldDeactivate: false,
        shouldRetry: false,
        originalError: { status, reason },
      };
    
    case 410:
      return {
        type: TokenErrorType.UNREGISTERED,
        shouldDeactivate: true,
        shouldRetry: false,
        originalError: { status, reason },
      };
    
    case 429:
      return {
        type: TokenErrorType.RATE_LIMITED,
        shouldDeactivate: false,
        shouldRetry: true,
        retryAfter: 60,
        originalError: { status, reason },
      };
    
    case 500:
    case 503:
      return {
        type: TokenErrorType.SERVICE_UNAVAILABLE,
        shouldDeactivate: false,
        shouldRetry: true,
        retryAfter: 30,
        originalError: { status, reason },
      };
    
    default:
      return {
        type: TokenErrorType.UNKNOWN,
        shouldDeactivate: false,
        shouldRetry: true,
        originalError: { status, reason },
      };
  }
}

// ============================================================================
// Device Token Lifecycle Service
// ============================================================================

export interface TokenCleanupStats {
  deactivated: number;
  deleted: number;
  errors: number;
}

export interface TokenHealthStats {
  totalTokens: number;
  activeTokens: number;
  inactiveTokens: number;
  byPlatform: {
    android: { active: number; inactive: number };
    ios: { active: number; inactive: number };
  };
  failureDistribution: {
    noFailures: number;
    oneToThree: number;
    fourPlus: number;
  };
  lastSeenDistribution: {
    within24Hours: number;
    within7Days: number;
    within30Days: number;
    older: number;
  };
}

export class DeviceTokenService {
  private static instance: DeviceTokenService;
  
  private constructor() {}
  
  static getInstance(): DeviceTokenService {
    if (!DeviceTokenService.instance) {
      DeviceTokenService.instance = new DeviceTokenService();
    }
    return DeviceTokenService.instance;
  }

  /**
   * Handle a push delivery failure and update device state accordingly
   */
  async handleDeliveryFailure(
    device: IDevice,
    platform: 'fcm' | 'apns',
    error: any
  ): Promise<{ deactivated: boolean; shouldRetry: boolean }> {
    const tokenError = platform === 'fcm'
      ? classifyFCMError(error)
      : classifyAPNsError(error.status, error.reason);

    logger.info(`Token error classified`, {
      deviceId: device._id,
      platform,
      errorType: tokenError.type,
      shouldDeactivate: tokenError.shouldDeactivate,
      shouldRetry: tokenError.shouldRetry,
    });

    if (tokenError.shouldDeactivate) {
      await this.deactivateDevice(device, tokenError.type.toString());
      return { deactivated: true, shouldRetry: false };
    }

    // Track failure
    await this.trackFailure(device);

    return {
      deactivated: device.failureCount >= 5, // Will be deactivated by incrementFailureCount
      shouldRetry: tokenError.shouldRetry,
    };
  }

  /**
   * Deactivate a device token
   */
  async deactivateDevice(device: IDevice, reason: string): Promise<void> {
    try {
      device.isActive = false;
      device.metadata = {
        ...device.metadata,
        deactivatedAt: new Date(),
        deactivationReason: reason,
      };
      await device.save();

      logger.info(`Device token deactivated`, {
        deviceId: device._id,
        userId: device.userId,
        platform: device.platform,
        reason,
      });
    } catch (error) {
      logger.error(`Error deactivating device`, {
        deviceId: device._id,
        error,
      });
    }
  }

  /**
   * Track a delivery failure
   */
  async trackFailure(device: IDevice): Promise<void> {
    try {
      if (typeof device.incrementFailureCount === 'function') {
        await device.incrementFailureCount();
      } else {
        device.failureCount = (device.failureCount || 0) + 1;
        device.lastFailure = new Date();
        if (device.failureCount >= 5) {
          device.isActive = false;
          device.metadata = {
            ...device.metadata,
            deactivatedAt: new Date(),
            deactivationReason: 'consecutive_failures',
          };
        }
        await device.save();
      }
    } catch (error) {
      logger.error(`Error tracking device failure`, {
        deviceId: device._id,
        error,
      });
    }
  }

  /**
   * Reset failure count on successful delivery
   */
  async trackSuccess(device: IDevice): Promise<void> {
    try {
      if (typeof device.markAsSeen === 'function') {
        await device.markAsSeen();
      } else {
        device.lastSeen = new Date();
        device.failureCount = 0;
        await device.save();
      }
    } catch (error) {
      logger.error(`Error tracking device success`, {
        deviceId: device._id,
        error,
      });
    }
  }

  /**
   * Handle token refresh (old token replaced with new one)
   */
  async refreshToken(
    userId: string,
    oldToken: string,
    newToken: string
  ): Promise<IDevice | null> {
    try {
      const device = await Device.findOne({ deviceToken: oldToken });
      
      if (!device) {
        logger.warn(`Token refresh: old token not found`, { userId });
        return null;
      }

      // Check if new token already exists
      const existingDevice = await Device.findOne({ deviceToken: newToken });
      if (existingDevice) {
        // New token already registered, deactivate old one
        await this.deactivateDevice(device, 'token_refreshed');
        logger.info(`Token refresh: new token already exists, deactivated old`, {
          userId,
          oldDeviceId: device._id,
          newDeviceId: existingDevice._id,
        });
        return existingDevice;
      }

      // Update token
      device.deviceToken = newToken;
      device.lastSeen = new Date();
      device.failureCount = 0;
      await device.save();

      logger.info(`Token refreshed successfully`, {
        deviceId: device._id,
        userId,
      });

      return device;
    } catch (error) {
      logger.error(`Error refreshing token`, { userId, error });
      return null;
    }
  }

  /**
   * Cleanup stale and invalid tokens
   * Run this periodically (e.g., daily cron job)
   */
  async cleanupStaleTokens(options: {
    inactiveDays?: number; // Deactivate tokens not seen for this many days
    deleteAfterDays?: number; // Hard delete deactivated tokens after this many days
  } = {}): Promise<TokenCleanupStats> {
    const {
      inactiveDays = 30,
      deleteAfterDays = 90,
    } = options;

    const stats: TokenCleanupStats = {
      deactivated: 0,
      deleted: 0,
      errors: 0,
    };

    const now = new Date();

    try {
      // 1. Deactivate tokens not seen for inactiveDays
      const inactiveCutoff = new Date(now);
      inactiveCutoff.setDate(inactiveCutoff.getDate() - inactiveDays);

      const deactivateResult = await Device.updateMany(
        {
          isActive: true,
          lastSeen: { $lt: inactiveCutoff },
        },
        {
          $set: {
            isActive: false,
            'metadata.deactivatedAt': now,
            'metadata.deactivationReason': 'inactivity',
          },
        }
      );
      stats.deactivated = deactivateResult.modifiedCount;

      logger.info(`Deactivated ${stats.deactivated} inactive tokens`, {
        cutoffDate: inactiveCutoff,
      });

      // 2. Delete tokens that have been deactivated for deleteAfterDays
      const deleteCutoff = new Date(now);
      deleteCutoff.setDate(deleteCutoff.getDate() - deleteAfterDays);

      const deleteResult = await Device.deleteMany({
        isActive: false,
        $or: [
          { 'metadata.deactivatedAt': { $lt: deleteCutoff } },
          { lastFailure: { $lt: deleteCutoff } },
          { lastSeen: { $lt: deleteCutoff } },
        ],
      });
      stats.deleted = deleteResult.deletedCount;

      logger.info(`Deleted ${stats.deleted} old deactivated tokens`, {
        cutoffDate: deleteCutoff,
      });

    } catch (error) {
      stats.errors++;
      logger.error(`Error during token cleanup`, { error });
    }

    return stats;
  }

  /**
   * Get health statistics for device tokens
   */
  async getHealthStats(): Promise<TokenHealthStats> {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalTokens,
      activeTokens,
      androidActive,
      androidInactive,
      iosActive,
      iosInactive,
      noFailures,
      oneToThree,
      fourPlus,
      within24Hours,
      within7Days,
      within30Days,
    ] = await Promise.all([
      Device.countDocuments(),
      Device.countDocuments({ isActive: true }),
      Device.countDocuments({ platform: 'android', isActive: true }),
      Device.countDocuments({ platform: 'android', isActive: false }),
      Device.countDocuments({ platform: 'ios', isActive: true }),
      Device.countDocuments({ platform: 'ios', isActive: false }),
      Device.countDocuments({ failureCount: 0, isActive: true }),
      Device.countDocuments({ failureCount: { $gte: 1, $lte: 3 }, isActive: true }),
      Device.countDocuments({ failureCount: { $gte: 4 } }),
      Device.countDocuments({ lastSeen: { $gte: twentyFourHoursAgo }, isActive: true }),
      Device.countDocuments({ lastSeen: { $gte: sevenDaysAgo, $lt: twentyFourHoursAgo }, isActive: true }),
      Device.countDocuments({ lastSeen: { $gte: thirtyDaysAgo, $lt: sevenDaysAgo }, isActive: true }),
    ]);

    return {
      totalTokens,
      activeTokens,
      inactiveTokens: totalTokens - activeTokens,
      byPlatform: {
        android: { active: androidActive, inactive: androidInactive },
        ios: { active: iosActive, inactive: iosInactive },
      },
      failureDistribution: {
        noFailures,
        oneToThree,
        fourPlus,
      },
      lastSeenDistribution: {
        within24Hours,
        within7Days,
        within30Days,
        older: activeTokens - within24Hours - within7Days - within30Days,
      },
    };
  }

  /**
   * Find devices with high failure counts for investigation
   */
  async getProblematicDevices(limit: number = 100): Promise<any[]> {
    return Device.find({
      failureCount: { $gte: 3 },
      isActive: true,
    })
      .sort({ failureCount: -1 })
      .limit(limit)
      .lean()
      .exec();
  }
}

// Export singleton instance
export const deviceTokenService = DeviceTokenService.getInstance();
