import { getMessaging } from '../config/firebase';
import { getAPNsProvider, createAPNsNotification } from '../config/apns';
import { IDevice } from '../models/Device';
import { logger } from '../utils/logger';
import Device from '../models/Device';
import {
  apnsCircuitBreaker,
  fcmCircuitBreaker,
  CircuitState,
} from './CircuitBreakerService';

export interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, any>;
  imageUrl?: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
}

export interface DeliveryResult {
  deviceId: string;
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface BatchDeliveryResult {
  successCount: number;
  failureCount: number;
  results?: DeliveryResult[];
  errors?: string[];
}

export class PushNotificationService {
  private isInitialized = false;

  async initialize(): Promise<void> {
    this.isInitialized = true;
    logger.info('✅ PushNotificationService initialized');
  }

  async sendToAndroidDevices(
    devices: IDevice[],
    payload: NotificationPayload
  ): Promise<BatchDeliveryResult> {
    const result: BatchDeliveryResult = {
      successCount: 0,
      failureCount: 0,
      results: [],
      errors: [],
    };

    if (devices.length === 0) {
      return result;
    }

    // Check circuit breaker
    if (!fcmCircuitBreaker.allowRequest()) {
      logger.warn('⚡ FCM circuit breaker is OPEN, blocking request', {
        state: fcmCircuitBreaker.getState(),
        stats: fcmCircuitBreaker.getStats(),
      });
      result.failureCount = devices.length;
      result.errors!.push('Circuit breaker is OPEN - service unavailable');
      devices.forEach(device => {
        result.results!.push({
          deviceId: device?._id ? device._id.toString() : '',
          success: false,
          error: 'Circuit breaker OPEN',
        });
      });
      return result;
    }

    try {
      const messaging = getMessaging();
      const tokens = devices.map(d => d.deviceToken);
      
      // Prepare FCM message
      const message = {
        notification: {
          title: payload.title,
          body: payload.body,
          ...(payload.imageUrl && { image: payload.imageUrl }),
        },
        data: {
          ...payload.data,
          priority: payload.priority,
          timestamp: Date.now().toString(),
        },
        android: {
          priority: this.mapPriorityToFCM(payload.priority),
          notification: {
            channelId: this.getAndroidChannelId(payload.priority),
            priority: this.mapPriorityToAndroidNotification(payload.priority),
            defaultSound: true,
            defaultVibrateTimings: true,
            defaultLightSettings: true,
            ...(payload.imageUrl && { imageUrl: payload.imageUrl }),
          },
          ttl: this.getTTL(payload.priority),
        },
        tokens,
      };

      logger.info(`📤 Sending FCM message to ${tokens.length} devices`);
      
      const response = await messaging.sendEachForMulticast(message);
      
      // Process individual results
      response.responses.forEach((resp, index) => {
        const device = devices[index];
        const deviceResult: DeliveryResult = {
          deviceId: device?._id ? device._id.toString() : '',
          success: resp.success,
        };
        
        if (resp.success && device) {
          result.successCount++;
          deviceResult.messageId = resp.messageId ?? '';
          // Record success in circuit breaker
          fcmCircuitBreaker.recordSuccess();
          // Update device last seen
          if (typeof device.markAsSeen === 'function') {
            device.markAsSeen().catch((err: any) => 
              logger.error('Error updating device last seen:', err)
            );
          }
        } else {
          result.failureCount++;
          deviceResult.error = resp.error?.message ?? '';
          // Record failure in circuit breaker
          fcmCircuitBreaker.recordFailure();
          // Handle specific FCM errors
          if (device) {
            this.handleFCMError(device, resp.error);
          }
        }
        result.results!.push(deviceResult);
      });
      
      logger.info(`✅ FCM delivery complete: ${result.successCount} success, ${result.failureCount} failures`);
      
    } catch (error) {
      logger.error('❌ FCM batch send error:', error);
      result.failureCount = devices.length;
      result.errors!.push(`FCM error: ${error}`);
      // Record batch failure
      fcmCircuitBreaker.recordFailure();
    }

    return result;
  }

  async sendToiOSDevices(
    devices: IDevice[],
    payload: NotificationPayload
  ): Promise<BatchDeliveryResult> {
    const result: BatchDeliveryResult = {
      successCount: 0,
      failureCount: 0,
      results: [],
      errors: [],
    };

    if (devices.length === 0) {
      return result;
    }

    // Check circuit breaker
    if (!apnsCircuitBreaker.allowRequest()) {
      logger.warn('⚡ APNs circuit breaker is OPEN, blocking request', {
        state: apnsCircuitBreaker.getState(),
        stats: apnsCircuitBreaker.getStats(),
      });
      result.failureCount = devices.length;
      result.errors!.push('Circuit breaker is OPEN - service unavailable');
      devices.forEach(device => {
        result.results!.push({
          deviceId: device?._id ? device._id.toString() : '',
          success: false,
          error: 'Circuit breaker OPEN',
        });
      });
      return result;
    }

    try {
      const apnProvider = getAPNsProvider();
      const notification = createAPNsNotification(
        payload.title,
        payload.body,
        payload.data
      );
      
      // Set priority and expiry
      notification.priority = this.mapPriorityToAPNs(payload.priority);
      notification.expiry = Math.floor(Date.now() / 1000) + this.getTTL(payload.priority);
      
      // Add custom data
      if (payload.data) {
        notification.payload = {
          ...notification.payload,
          ...payload.data,
          priority: payload.priority,
          timestamp: Date.now(),
        };
      }
      
      logger.info(`📤 Sending APNs notification to ${devices.length} devices`);
      
      // Send to each device
      for (const device of devices) {
        try {
          const apnResult = await apnProvider.send(notification, device.deviceToken);
          const deviceResult: DeliveryResult = {
            deviceId: device?._id ? device._id.toString() : '',
            success: apnResult.sent.length > 0,
          };
          if (apnResult.sent.length > 0) {
            result.successCount++;
            deviceResult.messageId = (apnResult.sent[0] && 'id' in apnResult.sent[0]) ? (apnResult.sent[0] as any).id ?? '' : '';
            // Record success in circuit breaker
            apnsCircuitBreaker.recordSuccess();
            // Update device last seen
            if (typeof device.markAsSeen === 'function') {
              device.markAsSeen().catch((err: any) => 
                logger.error('Error updating device last seen:', err)
              );
            }
          } else {
            result.failureCount++;
            // Record failure in circuit breaker
            apnsCircuitBreaker.recordFailure();
            if (apnResult.failed.length > 0) {
              const failure = apnResult.failed[0];
              if (failure) {
                deviceResult.error = `${failure.status ?? ''}: ${failure.response?.reason ?? ''}`;
                // Handle specific APNs errors
                if (device && typeof failure.status === 'number') {
                  this.handleAPNsError(device, failure.status, failure.response?.reason ?? '');
                }
              }
            }
          }
          result.results!.push(deviceResult);
        } catch (error) {
          result.failureCount++;
          // Record failure in circuit breaker
          apnsCircuitBreaker.recordFailure();
          result.results!.push({
            deviceId: device?._id ? device._id.toString() : '',
            success: false,
            error: `APNs send error: ${error}`,
          });
          logger.error(`Error sending to device ${device.deviceToken}:`, error);
        }
      }
      
      logger.info(`✅ APNs delivery complete: ${result.successCount} success, ${result.failureCount} failures`);
      
    } catch (error) {
      logger.error('❌ APNs batch send error:', error);
      result.failureCount = devices.length;
      result.errors!.push(`APNs error: ${error}`);
      // Record batch failure
      apnsCircuitBreaker.recordFailure();
    }

    return result;
  }

  private async handleFCMError(device: IDevice, error: any): Promise<void> {
    const errorCode = error?.code;
    switch (errorCode) {
      case 'messaging/registration-token-not-registered':
      case 'messaging/invalid-registration-token':
        logger.warn(`🗑️ Deactivating invalid FCM token for device ${device._id}`);
        device.isActive = false;
        await device.save();
        break;
      case 'messaging/mismatched-credential':
      case 'messaging/invalid-package-name':
        logger.error(`🚫 FCM credential error for device ${device._id}: ${errorCode}`);
        break;
      default:
        if (typeof device.incrementFailureCount === 'function') {
          await device.incrementFailureCount();
        }
        logger.warn(`⚠️ FCM error for device ${device._id}: ${errorCode}`);
    }
  }

  private async handleAPNsError(device: IDevice, status: number, reason: string): Promise<void> {
    switch (status) {
      case 400:
        if (reason === 'BadDeviceToken' || reason === 'Unregistered') {
          logger.warn(`🗑️ Deactivating invalid APNs token for device ${device._id}`);
          device.isActive = false;
          await device.save();
        }
        break;
      case 410:
        logger.warn(`🗑️ APNs token expired for device ${device._id}`);
        device.isActive = false;
        await device.save();
        break;
      case 413:
        logger.error(`📏 APNs payload too large for device ${device._id}`);
        break;
      case 429:
        logger.warn(`🚦 APNs rate limit for device ${device._id}`);
        if (typeof device.incrementFailureCount === 'function') {
          await device.incrementFailureCount();
        }
        break;
      default:
        if (typeof device.incrementFailureCount === 'function') {
          await device.incrementFailureCount();
        }
        logger.warn(`⚠️ APNs error ${status} for device ${device._id}: ${reason}`);
    }
  }

  private mapPriorityToFCM(priority: string): 'normal' | 'high' {
    return ['high', 'critical'].includes(priority) ? 'high' : 'normal';
  }

  private mapPriorityToAPNs(priority: string): number {
    switch (priority) {
      case 'critical': return 10;
      case 'high': return 10;
      case 'normal': return 5;
      case 'low': return 1;
      default: return 5;
    }
  }

  private mapPriorityToAndroidNotification(priority: string): 'default' | 'low' | 'high' | 'max' {
    switch (priority) {
      case 'critical': return 'max';
      case 'high': return 'high';
      case 'normal': return 'default';
      case 'low': return 'low';
      default: return 'default';
    }
  }

  private getAndroidChannelId(priority: string): string {
    switch (priority) {
      case 'critical': return 'critical_notifications';
      case 'high': return 'important_notifications';
      case 'normal': return 'default_notifications';
      case 'low': return 'low_priority_notifications';
      default: return 'default_notifications';
    }
  }

  private getTTL(priority: string): number {
    const ttlSeconds = {
      critical: 86400 * 3, // 3 days
      high: 86400 * 2,     // 2 days
      normal: 86400,       // 1 day
      low: 43200,          // 12 hours
    };
    
    return ttlSeconds[priority as keyof typeof ttlSeconds] || ttlSeconds.normal;
  }

  /**
   * Send notification to Firebase topic (for broadcasting to many users)
   */
  async sendToTopic(
    topic: string,
    notification: { title: string; body: string; imageUrl?: string },
    data: Record<string, string>,
    priority: string = 'normal'
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    // Check circuit breaker
    if (!fcmCircuitBreaker.allowRequest()) {
      logger.warn('⚡ FCM circuit breaker is OPEN, blocking topic request', {
        topic,
        state: fcmCircuitBreaker.getState(),
      });
      return {
        success: false,
        error: 'Circuit breaker is OPEN - service unavailable',
      };
    }

    try {
      const messaging = getMessaging();

      const message = {
        topic,
        notification: {
          title: notification.title,
          body: notification.body,
          ...(notification.imageUrl && { imageUrl: notification.imageUrl }),
        },
        data,
        android: {
          priority: priority === 'critical' || priority === 'high' ? 'high' : 'normal',
          ttl: this.getTTL(priority) * 1000, // Convert to milliseconds
        },
        apns: {
          headers: {
            'apns-priority': priority === 'critical' || priority === 'high' ? '10' : '5',
          },
          payload: {
            aps: {
              'content-available': 1,
              sound: 'default',
            },
          },
        },
      };

      const messageId = await messaging.send(message as any);

      // Record success
      fcmCircuitBreaker.recordSuccess();

      logger.info(`✅ Topic push sent successfully: ${topic}`, { messageId });

      return {
        success: true,
        messageId,
      };
    } catch (error) {
      // Record failure
      fcmCircuitBreaker.recordFailure();

      logger.error(`❌ Failed to send topic push: ${topic}`, error);

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async shutdown(): Promise<void> {
    this.isInitialized = false;
    logger.info('✅ PushNotificationService shut down');
  }
}