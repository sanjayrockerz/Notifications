// Manual test instructions for full FCM flow

/**
 * 1. Register a device token via Notification service:
 *    - POST /devices/register with { userId, deviceId, platform, fcmToken }
 *    - Confirm response includes unreadCount and deviceId
 *
 * 2. Follow a user via the app (or call Feature service endpoint):
 *    - POST /feature/follow with { followerId, followedId }
 *    - Confirm 200 OK
 *
 * 3. Wait for event to propagate (a few seconds)
 *
 * 4. Trigger delivery worker (if not automatic):
 *    - POST /internal/trigger-delivery or wait for scheduled worker
 *
 * 5. Check Firebase console or device:
 *    - Confirm push notification received
 *    - If not, check Notification and DeliveryLog DB tables for status
 *
 * 6. Error cases:
 *    - Try registering invalid token, duplicate follow, or device offline
 *    - Confirm errors are handled gracefully, no duplicate notifications
 */
