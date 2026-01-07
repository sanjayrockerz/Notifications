
import apn from 'apn';
import Device from '../models/Device';
import DeliveryLog from '../models/DeliveryLog';
import Notification from '../models/Notification';
import logger from '../utils/logger';
import { setTimeout as sleep } from 'timers/promises';
import admin from 'firebase-admin';
import {
  apnsCircuitBreaker,
  fcmCircuitBreaker,
  CircuitState,
} from './CircuitBreakerService';
import { checkQuietHours, isUrgentNotification } from '../utils/quietHours';

const MAX_BATCH = 100;
const POLL_INTERVAL = 15000; // 15 seconds
const MAX_RETRIES = 5;
const BASE_BACKOFF = 60000; // 1 minute

function getBackoff(attempt: number) {
  const base = Math.min(BASE_BACKOFF * Math.pow(2, attempt - 1), 60 * 60 * 1000);
  const jitter = Math.floor(Math.random() * (base / 2));
  return base + jitter;
}

export class DeliveryWorkerService {
  private running = false;

  async start() {
    this.running = true;
    logger.info('DeliveryWorkerService started');
    while (this.running) {
      try {
        await this.processBatch();
      } catch (err) {
        logger.error('Delivery worker error', err);
      }
      await sleep(POLL_INTERVAL);
    }
  }

  async stop() {
    this.running = false;
    logger.info('DeliveryWorkerService stopping (will finish current batch)');
  }

  async processBatch() {
    const now = new Date();
    const deliveries = await DeliveryLog.find({ status: 'pending', nextRetryAt: { $lte: now } }).limit(MAX_BATCH);
    if (!deliveries.length) return;
    logger.info(`Processing ${deliveries.length} pending deliveries`);
    
    // Group by platform
    const fcmBatch = [];
    const apnsBatch = [];
    const quietHoursDelayed = [];
    
    for (const delivery of deliveries) {
      const device = await Device.findOne({ deviceToken: delivery.deviceId, isActive: true });
      if (!device) {
        // Device uninstalled, mark as sent
        await DeliveryLog.updateOne({ _id: delivery._id }, { $set: { status: 'sent', sentAt: now } });
        continue;
      }

      // Get notification details
      const notification = await Notification.findOne({ _id: delivery.notificationId });
      if (!notification) {
        await DeliveryLog.updateOne({ _id: delivery._id }, { $set: { status: 'failed', lastError: 'Notification not found' } });
        continue;
      }

      // Check quiet hours for this user
      const quietHoursCheck = await checkQuietHours(notification.userId);
      if (quietHoursCheck.isQuietHours) {
        // Check if notification is urgent
        const urgent = isUrgentNotification(
          notification.category,
          notification.priority,
          notification.urgent
        );

        if (!urgent) {
          // Reschedule to after quiet hours
          logger.info(`\ud83d\udd07 Delaying delivery for user ${notification.userId} until after quiet hours`);
          await DeliveryLog.updateOne(
            { _id: delivery._id },
            { 
              $set: { 
                nextRetryAt: quietHoursCheck.nextAvailableTime,
                lastError: 'Delayed due to quiet hours'
              } 
            }
          );
          quietHoursDelayed.push(delivery);
          continue;
        } else {
          logger.info(`\u26a1 Urgent notification for user ${notification.userId}, delivering despite quiet hours`);
        }
      }

      // Add to appropriate batch
      if (device.platform === 'android') {
        fcmBatch.push({ delivery, device });
      } else if (device.platform === 'ios') {
        apnsBatch.push({ delivery, device });
      }
    }

    if (quietHoursDelayed.length > 0) {
      logger.info(`\u23f0 Delayed ${quietHoursDelayed.length} deliveries due to quiet hours`);
    }

    await this.sendFcmBatch(fcmBatch);
    await this.sendApnsBatch(apnsBatch);
  }

  async sendApnsBatch(batch: any[]) {
    if (!batch.length) return;

    // Check circuit breaker before sending
    if (!apnsCircuitBreaker.allowRequest()) {
      logger.warn('⚡ APNs circuit breaker is OPEN, rescheduling deliveries', {
        batchSize: batch.length,
        state: apnsCircuitBreaker.getState(),
      });
      // Reschedule all deliveries
      const nextRetry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
      for (const { delivery } of batch) {
        await DeliveryLog.updateOne(
          { _id: delivery._id },
          { $set: { nextRetryAt: nextRetry, lastError: 'Circuit breaker OPEN' } }
        );
      }
      return;
    }

    // Configure APNs provider (should be singleton in production)
    const apnProvider = new apn.Provider({
      token: {
        key: process.env.APNS_KEY_PATH || './certs/AuthKey.p8',
        keyId: process.env.APNS_KEY_ID || '',
        teamId: process.env.APNS_TEAM_ID || '',
      },
      production: process.env.NODE_ENV === 'production',
    });
    const notificationIds = batch.map((b: any) => b.delivery.notificationId);
    const notifications = await Notification.find({ _id: { $in: notificationIds } });
    const notificationMap = new Map(notifications.map((n: any) => [String(n._id), n]));
    for (const { delivery, device } of batch) {
      const notif = notificationMap.get(String(delivery.notificationId));
      const note = new apn.Notification();
      note.alert = {
        title: notif?.title || '',
        body: notif?.body || '',
      };
      note.payload = notif?.data || {};
      note.topic = process.env.APNS_BUNDLE_ID || '';
      try {
        const result = await apnProvider.send(note, device.fcmToken);
        if (result.sent && result.sent.length > 0) {
          await DeliveryLog.updateOne({ _id: delivery._id }, { $set: { status: 'sent', sentAt: new Date() } });
        } else if (result.failed && result.failed.length > 0) {
          const error = result.failed[0]?.response?.reason || 'unknown';
          if (error === 'Unregistered' || error === 'BadDeviceToken') {
            await Device.updateOne({ deviceToken: device.deviceToken }, { $set: { isActive: false } });
            await DeliveryLog.updateOne({ _id: delivery._id }, { $set: { status: 'invalid_token', lastError: error } });
          } else {
            // Retry with backoff
            const nextRetry = new Date(Date.now() + getBackoff(delivery.attemptCount + 1));
            const update: any = {
              $set: { nextRetryAt: nextRetry, lastError: error },
              $inc: { attemptCount: 1 },
            };
            if (delivery.attemptCount + 1 >= MAX_RETRIES) {
              update.$set.status = 'failed';
            }
            await DeliveryLog.updateOne({ _id: delivery._id }, update);
          }
        }
      } catch (err: any) {
        logger.error('APNs send error', err);
        // Retry with backoff
        const nextRetry = new Date(Date.now() + getBackoff(delivery.attemptCount + 1));
        const update: any = {
          $set: { nextRetryAt: nextRetry, lastError: err.message || 'apns_error' },
          $inc: { attemptCount: 1 },
        };
        if (delivery.attemptCount + 1 >= MAX_RETRIES) {
          update.$set.status = 'failed';
        }
        await DeliveryLog.updateOne({ _id: delivery._id }, update);
      }
    }
    apnProvider.shutdown();
  }

  async sendFcmBatch(batch: any[]) {
    if (!batch.length) return;

    // Check circuit breaker before sending
    if (!fcmCircuitBreaker.allowRequest()) {
      logger.warn('⚡ FCM circuit breaker is OPEN, rescheduling deliveries', {
        batchSize: batch.length,
        state: fcmCircuitBreaker.getState(),
      });
      // Reschedule all deliveries
      const nextRetry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
      for (const { delivery } of batch) {
        await DeliveryLog.updateOne(
          { _id: delivery._id },
          { $set: { nextRetryAt: nextRetry, lastError: 'Circuit breaker OPEN' } }
        );
      }
      return;
    }

    const tokens = batch.map((b: any) => b.device.fcmToken);
    const notificationIds = batch.map((b: any) => b.delivery.notificationId);
    const notifications = await Notification.find({ _id: { $in: notificationIds } });
    const notificationMap = new Map(notifications.map((n: any) => [String(n._id), n]));
    const messages = batch.map(({ delivery, device }: any) => {
      const notif = notificationMap.get(String(delivery.notificationId));
      return {
        token: device.fcmToken,
        notification: {
          title: notif?.title || '',
          body: notif?.body || '',
        },
        data: notif?.data || {},
      };
    });
    const response = await admin.messaging().sendEach(messages);
    for (let i = 0; i < batch.length; i++) {
      const { delivery, device } = batch[i];
      const res = response.responses[i];
      if (res && res.success) {
        await DeliveryLog.updateOne({ _id: delivery._id }, { $set: { status: 'sent', sentAt: new Date() } });
      } else if (res) {
        const error = res.error?.code || 'unknown';
        if (error === 'messaging/registration-token-not-registered' || error === 'messaging/invalid-registration-token') {
          await Device.updateOne({ deviceToken: device.deviceToken }, { $set: { isActive: false } });
          await DeliveryLog.updateOne({ _id: delivery._id }, { $set: { status: 'invalid_token', lastError: error } });
        } else {
          // Retry with backoff
          const nextRetry = new Date(Date.now() + getBackoff(delivery.attemptCount + 1));
          const update: any = {
            $set: { nextRetryAt: nextRetry, lastError: error },
            $inc: { attemptCount: 1 },
          };
          if (delivery.attemptCount + 1 >= MAX_RETRIES) {
            update.$set.status = 'failed';
          }
          await DeliveryLog.updateOne({ _id: delivery._id }, update);
        }
      }
    }
  }
}
