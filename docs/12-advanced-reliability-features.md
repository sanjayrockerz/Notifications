# Phase 4: Tasks 4.3, 4.4, 4.5 - Advanced Reliability Features

## Overview
This document describes the implementation of three advanced reliability features added in Phase 4:
- **Task 4.3**: Circuit Breaker for Push Providers
- **Task 4.4**: Notification Preferences API
- **Task 4.5**: Quiet Hours / Time-based Delivery

## Task 4.3: Circuit Breaker for Push Providers

### Architecture

The Circuit Breaker pattern prevents cascading failures when push providers (APNs/FCM) experience issues by temporarily blocking requests when error rates exceed thresholds.

**State Machine:**
```
CLOSED (Normal) ──error rate > 5% for 2min──> OPEN (Blocked)
                                                    │
                                          wait 10 minutes
                                                    │
                                                    ↓
HALF_OPEN (Testing) ──10 successes──> CLOSED (Recovered)
         │
         │ error persists
         └──────────────────────────> OPEN
```

### Components Implemented

#### 1. CircuitBreakerService ([src/services/CircuitBreakerService.ts](src/services/CircuitBreakerService.ts))

**Configuration:**
```typescript
{
  errorThreshold: 0.05,        // 5% error rate to open
  windowSize: 60 * 60 * 1000,  // 1 hour rolling window
  minimumRequests: 10,         // Min requests before checking threshold
  openTimeout: 10 * 60 * 1000, // 10 minutes before HALF_OPEN
  halfOpenSuccessThreshold: 10,// 10 successes to close
  halfOpenMaxRequests: 10,     // Max test requests in HALF_OPEN
  errorDuration: 2 * 60 * 1000 // 2 minutes above threshold to open
}
```

**Key Methods:**
- `allowRequest()`: Check if request should be allowed based on current state
- `recordSuccess()`: Record successful push delivery
- `recordFailure()`: Record failed push delivery
- `getState()`: Get current circuit state (CLOSED/OPEN/HALF_OPEN)
- `getStats()`: Get circuit statistics (error rate, request counts, etc.)
- `forceState()`: Manually force circuit to specific state (admin intervention)
- `reset()`: Reset circuit to initial CLOSED state

**State Transitions:**

1. **CLOSED → OPEN:**
   - Error rate > 5% for at least 10 requests
   - Condition persists for 2 minutes
   - Log: `⚡ Circuit breaker {name}: CLOSED -> OPEN`

2. **OPEN → HALF_OPEN:**
   - After 10 minutes in OPEN state
   - Log: `⚡ Circuit breaker {name}: OPEN -> HALF_OPEN`

3. **HALF_OPEN → CLOSED:**
   - 10 consecutive successful test requests
   - Log: `⚡ Circuit breaker {name}: HALF_OPEN -> CLOSED`

4. **HALF_OPEN → OPEN:**
   - Any failed test request
   - Log: `⚡ Circuit breaker {name}: HALF_OPEN -> OPEN`

#### 2. Integration with PushNotificationService

**Before sending:**
```typescript
if (!fcmCircuitBreaker.allowRequest()) {
  logger.warn('⚡ FCM circuit breaker is OPEN, blocking request');
  return { 
    successCount: 0, 
    failureCount: devices.length,
    errors: ['Circuit breaker is OPEN - service unavailable']
  };
}
```

**After sending:**
```typescript
if (success) {
  fcmCircuitBreaker.recordSuccess();
} else {
  fcmCircuitBreaker.recordFailure();
}
```

#### 3. Integration with DeliveryWorkerService

When circuit is OPEN, deliveries are rescheduled:
```typescript
if (!fcmCircuitBreaker.allowRequest()) {
  logger.warn('⚡ FCM circuit breaker is OPEN, rescheduling deliveries');
  const nextRetry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
  await DeliveryLog.updateOne(
    { _id: delivery._id },
    { $set: { nextRetryAt: nextRetry, lastError: 'Circuit breaker OPEN' } }
  );
  return;
}
```

### Monitoring

**Metrics emitted:**
```typescript
circuit_breaker.state_transition: 1 (name, from, to)
circuit_breaker.state: 1 (name, state)
circuit_breaker.error_rate: 0.05 (name)
circuit_breaker.total_requests: 150 (name)
circuit_breaker.success_count: 142 (name)
circuit_breaker.failure_count: 8 (name)
```

**Health check endpoint:**
```typescript
GET /health/circuit-breaker
{
  "fcm": {
    "state": "CLOSED",
    "errorRate": 0.023,
    "totalRequests": 347,
    "successCount": 339,
    "failureCount": 8,
    "timeSinceStateChange": 3600000
  },
  "apns": {
    "state": "OPEN",
    "errorRate": 0.087,
    "totalRequests": 230,
    "successCount": 210,
    "failureCount": 20,
    "timeSinceStateChange": 420000
  }
}
```

### Benefits

1. **Prevents cascading failures**: Stops overwhelming failing services
2. **Fast failure**: Immediate response when circuit OPEN (no waiting for timeouts)
3. **Self-healing**: Automatically tests recovery and closes circuit
4. **Visibility**: State transitions logged and metrics emitted
5. **Configurable**: Thresholds tunable per environment

### Configuration

Environment variables (optional):
```bash
CIRCUIT_BREAKER_ERROR_THRESHOLD=0.05      # 5%
CIRCUIT_BREAKER_WINDOW_SIZE_MS=3600000    # 1 hour
CIRCUIT_BREAKER_OPEN_TIMEOUT_MS=600000    # 10 minutes
CIRCUIT_BREAKER_ERROR_DURATION_MS=120000  # 2 minutes
```

## Task 4.4: Notification Preferences API

### Architecture

Users can control which notification types they receive through a preferences system.

**Supported notification types:**
- `follow`: New follower notifications
- `like`: Content like notifications
- `comment`: Comment notifications
- `mention`: Mention notifications
- `message`: Direct message notifications

### Components Implemented

#### 1. PreferencesController ([src/controllers/PreferencesController.ts](src/controllers/PreferencesController.ts))

**API Endpoints:**

**GET /users/:userId/notification-preferences**
Get user's notification preferences.

Response:
```json
{
  "userId": "user-123",
  "notificationTypes": {
    "follow": { "isEnabled": true },
    "like": { "isEnabled": false },
    "comment": { "isEnabled": true },
    "mention": { "isEnabled": true },
    "message": { "isEnabled": true }
  },
  "quietHours": {
    "enabled": false,
    "start": "22:00",
    "end": "09:00",
    "timezone": "UTC"
  },
  "updatedAt": "2026-01-06T10:30:00Z"
}
```

**POST /users/:userId/notification-preferences**
Update single notification type preference.

Request:
```json
{
  "notificationType": "like",
  "isEnabled": false
}
```

Response:
```json
{
  "userId": "user-123",
  "notificationTypes": {
    "follow": { "isEnabled": true },
    "like": { "isEnabled": false },
    "comment": { "isEnabled": true },
    "mention": { "isEnabled": true },
    "message": { "isEnabled": true }
  },
  "updatedAt": "2026-01-06T10:35:00Z"
}
```

**PUT /users/:userId/notification-preferences/bulk**
Bulk update multiple notification types.

Request:
```json
{
  "notificationTypes": {
    "follow": true,
    "like": false,
    "comment": false,
    "mention": true,
    "message": true
  }
}
```

#### 2. UserPreferences Model Updates

Added fields to [src/models/UserPreferences.ts](src/models/UserPreferences.ts):

```typescript
{
  notificationTypes: {
    follow: { isEnabled: true },
    like: { isEnabled: true },
    comment: { isEnabled: true },
    mention: { isEnabled: true },
    message: { isEnabled: true }
  },
  quietHours: {
    enabled: false,
    start: "22:00",
    end: "09:00",
    timezone: "UTC"
  }
}
```

#### 3. EventHandlerService Integration

Before creating notification, preferences are checked:

```typescript
const shouldSend = await this.checkUserPreferences(userId, 'follow');
if (!shouldSend) {
  logger.info('🔕 Notification skipped due to user preference');
  return {
    success: true,
    notificationId: 'skipped-by-preference',
    error: '',
    retryable: false
  };
}
```

**Preference checking logic:**
```typescript
private async checkUserPreferences(userId: string, notificationType: string): Promise<boolean> {
  const preferences = await UserPreferences.findOne({ userId });
  
  if (!preferences) {
    return true; // No preferences = allow all
  }

  if (preferences.notificationTypes?.[notificationType]?.isEnabled === false) {
    logger.info(`🔕 Notification skipped: userId=${userId}, type=${notificationType}`);
    return false;
  }

  return true;
}
```

### Usage Examples

**Disable like notifications:**
```bash
curl -X POST http://localhost:3000/users/user-123/notification-preferences \
  -H "Content-Type: application/json" \
  -d '{
    "notificationType": "like",
    "isEnabled": false
  }'
```

**Bulk update preferences:**
```bash
curl -X PUT http://localhost:3000/users/user-123/notification-preferences/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "notificationTypes": {
      "follow": true,
      "like": false,
      "comment": false
    }
  }'
```

**Get current preferences:**
```bash
curl http://localhost:3000/users/user-123/notification-preferences
```

### Benefits

1. **User control**: Users can opt out of unwanted notifications
2. **Reduced noise**: Fewer notifications = higher engagement
3. **Privacy**: Users control what they're notified about
4. **Compliance**: GDPR/privacy law requirement
5. **Performance**: Skip processing for disabled types

## Task 4.5: Quiet Hours / Time-based Delivery

### Architecture

Quiet hours prevent notifications from disturbing users during sleep or focus time. Urgent notifications bypass quiet hours.

**Quiet hours flow:**
```
Notification Ready
      │
      ↓
  Check Quiet Hours
      │
      ├─ Not in quiet hours ──> Deliver immediately
      │
      ├─ In quiet hours + urgent ──> Deliver immediately
      │
      └─ In quiet hours + not urgent ──> Reschedule to end time
```

### Components Implemented

#### 1. Quiet Hours Utility ([src/utils/quietHours.ts](src/utils/quietHours.ts))

**Key Functions:**

**checkQuietHours(userId, currentTime?):**
```typescript
{
  isQuietHours: true,
  nextAvailableTime: Date('2026-01-07T09:00:00Z'),
  quietHoursConfig: {
    enabled: true,
    start: "22:00",
    end: "09:00",
    timezone: "America/New_York"
  }
}
```

**isUrgentNotification(category, priority, urgent?):**
```typescript
// Returns true for:
- urgent === true (explicit flag)
- priority === 'critical' or 'high'
- category in ['mention', 'message', 'alert', 'security']
```

**Timezone handling:**
- User timezone stored in preferences
- Current time converted to user's timezone
- Quiet hours checked in user's local time
- Handles quiet hours spanning midnight (e.g., 22:00-09:00)

#### 2. Notification Model Updates

Added `urgent` field to [src/models/Notification.ts](src/models/Notification.ts):

```typescript
{
  urgent: Boolean, // If true, bypass quiet hours
  priority: 'low' | 'normal' | 'high' | 'critical',
  category: String
}
```

#### 3. DeliveryWorkerService Integration

Before sending each delivery:

```typescript
// Get notification details
const notification = await Notification.findOne({ _id: delivery.notificationId });

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
    logger.info(`🔇 Delaying delivery until after quiet hours`);
    await DeliveryLog.updateOne(
      { _id: delivery._id },
      { 
        $set: { 
          nextRetryAt: quietHoursCheck.nextAvailableTime,
          lastError: 'Delayed due to quiet hours'
        } 
      }
    );
    continue;
  } else {
    logger.info(`⚡ Urgent notification, delivering despite quiet hours`);
  }
}
```

### Usage Examples

**Set quiet hours:**
```bash
curl -X POST http://localhost:3000/users/user-123/notification-preferences \
  -H "Content-Type: application/json" \
  -d '{
    "quietHours": {
      "enabled": true,
      "start": "22:00",
      "end": "09:00",
      "timezone": "America/New_York"
    }
  }'
```

**Create urgent notification:**
```typescript
await notificationService.sendNotification({
  userId: 'user-123',
  title: 'Security Alert',
  body: 'Suspicious login detected',
  category: 'security',
  priority: 'critical',
  urgent: true, // Explicit urgent flag
  data: { /* ... */ }
});
```

### Quiet Hours Scenarios

#### Scenario 1: Normal notification during quiet hours
```
Current time: 23:30 (user's timezone)
Quiet hours: 22:00 - 09:00
Notification: Like notification (not urgent)
Result: Delayed until 09:00 next morning
```

#### Scenario 2: Urgent notification during quiet hours
```
Current time: 23:30
Quiet hours: 22:00 - 09:00
Notification: Security alert (urgent)
Result: Delivered immediately
```

#### Scenario 3: Quiet hours spanning midnight
```
Current time: 01:00
Quiet hours: 22:00 - 09:00
Check: Is 01:00 between 22:00 and 09:00? YES
Result: Delayed until 09:00 (same day)
```

#### Scenario 4: Different timezone
```
Server time: 10:00 UTC
User timezone: America/Los_Angeles (UTC-8)
User local time: 02:00
Quiet hours: 22:00 - 09:00
Result: Delayed until 09:00 PST (17:00 UTC)
```

### Benefits

1. **Better UX**: No sleep disruptions
2. **Higher engagement**: Users check notifications when ready
3. **Respect boundaries**: Users control when they receive notifications
4. **Urgent exceptions**: Critical notifications still delivered
5. **Timezone aware**: Works globally

### Configuration

User preferences (via API):
```json
{
  "quietHours": {
    "enabled": true,
    "start": "22:00",        // HH:MM format, 24-hour
    "end": "09:00",          // HH:MM format, 24-hour
    "timezone": "America/New_York"  // IANA timezone
  }
}
```

## Database Migrations

**Migration 007:** [migrations/007_add_preferences_quiet_hours.sql](migrations/007_add_preferences_quiet_hours.sql)

Adds:
- `notification_types` JSONB column to `user_preferences`
- `quiet_hours_enabled`, `quiet_hours_start`, `quiet_hours_end`, `quiet_hours_timezone` to `user_preferences`
- `urgent` Boolean to `notifications`
- Indexes for performance

## Monitoring & Operations

### Circuit Breaker Monitoring

**Metrics to track:**
- Circuit state changes (CLOSED/OPEN/HALF_OPEN transitions)
- Error rates per provider (FCM/APNs)
- Request counts (success/failure)
- Time in OPEN state
- Requests blocked by circuit

**Alerts:**
- Alert when circuit opens (indicates provider issues)
- Alert if circuit stays OPEN > 30 minutes (manual intervention needed)
- Alert on high error rates (5%+)

### Preferences Monitoring

**Metrics to track:**
- Number of users with preferences set
- Most disabled notification types
- Preference update rate
- Notifications skipped due to preferences

### Quiet Hours Monitoring

**Metrics to track:**
- Number of users with quiet hours enabled
- Deliveries delayed due to quiet hours
- Urgent notifications during quiet hours
- Timezone distribution

## Testing

### Circuit Breaker Tests

```typescript
// Test state transitions
it('should open circuit when error rate exceeds threshold', async () => {
  // Record 10 failures out of 20 requests (50% error rate)
  for (let i = 0; i < 10; i++) {
    circuitBreaker.recordFailure();
    circuitBreaker.recordSuccess();
  }
  
  await wait(2 * 60 * 1000); // Wait for error duration
  
  expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
});

// Test HALF_OPEN recovery
it('should close circuit after successful test requests', async () => {
  circuitBreaker.forceState(CircuitState.HALF_OPEN);
  
  for (let i = 0; i < 10; i++) {
    circuitBreaker.recordSuccess();
  }
  
  expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
});
```

### Preferences Tests

```typescript
it('should skip notification when type disabled', async () => {
  await UserPreferences.create({
    userId: 'user-123',
    notificationTypes: {
      like: { isEnabled: false }
    }
  });

  const result = await eventHandler.handleLikeCreatedEvent({
    eventType: 'LikeCreated',
    eventId: 'event-1',
    likerId: 'user-456',
    targetOwnerId: 'user-123',
    // ...
  });

  expect(result.notificationId).toBe('skipped-by-preference');
});
```

### Quiet Hours Tests

```typescript
it('should delay notification during quiet hours', async () => {
  await UserPreferences.create({
    userId: 'user-123',
    quietHours: {
      enabled: true,
      start: '22:00',
      end: '09:00',
      timezone: 'UTC'
    }
  });

  const currentTime = new Date('2026-01-06T23:30:00Z'); // 11:30 PM
  
  const check = await checkQuietHours('user-123', currentTime);
  
  expect(check.isQuietHours).toBe(true);
  expect(check.nextAvailableTime.getHours()).toBe(9); // 9:00 AM next day
});

it('should deliver urgent notification during quiet hours', async () => {
  const urgent = isUrgentNotification('security', 'critical', true);
  expect(urgent).toBe(true);
});
```

## Troubleshooting

### Circuit Breaker Issues

**Issue: Circuit stays OPEN**
- Check provider health (FCM/APNs)
- Review error logs for root cause
- Manually reset circuit: `circuitBreaker.reset()`
- Check configuration thresholds

**Issue: Circuit opens too frequently**
- Increase error threshold (5% → 10%)
- Increase error duration (2min → 5min)
- Check for network issues

### Preferences Issues

**Issue: Preferences not being applied**
- Verify preferences saved: Check MongoDB `user_preferences` collection
- Check EventHandlerService logs for preference checks
- Verify notification type name matches (case-sensitive)

**Issue: Default preferences not created**
- PreferencesController auto-creates on first GET
- Check POST /users/:userId/notification-preferences response

### Quiet Hours Issues

**Issue: Notifications delivered during quiet hours**
- Verify notification is not marked as urgent
- Check user's timezone setting
- Review DeliveryWorkerService logs
- Test quiet hours check: `checkQuietHours(userId, testTime)`

**Issue: Wrong timezone calculation**
- Verify IANA timezone identifier (e.g., 'America/New_York')
- Test with: `new Date().toLocaleTimeString('en-US', { timeZone: timezone })`
- Check server timezone vs user timezone

## Performance Impact

### Circuit Breaker
- **Overhead**: ~1-2ms per request (in-memory state check)
- **Memory**: ~100KB per circuit instance (request history)
- **Benefit**: Prevents 30s+ timeouts when provider down

### Preferences
- **Overhead**: +1 MongoDB query per event (~5ms)
- **Optimization**: Cache preferences in Redis (TTL 5min)
- **Benefit**: Reduces unnecessary notification processing

### Quiet Hours
- **Overhead**: +1 MongoDB query + timezone calculation (~10ms)
- **Optimization**: Cache preferences + calculate quiet hours locally
- **Benefit**: Better user experience, higher engagement

## Future Enhancements

1. **Circuit Breaker**:
   - Per-endpoint circuit breakers (separate FCM/APNs circuits per region)
   - Adaptive thresholds based on historical data
   - Predictive circuit opening (ML-based)

2. **Preferences**:
   - Per-app preferences (multi-tenant)
   - Category preferences (group notification types)
   - Schedule-based preferences (weekday vs weekend)
   - Snooze feature (temporary disable)

3. **Quiet Hours**:
   - Multiple quiet hour windows per day
   - Day-of-week specific quiet hours (weekday vs weekend)
   - Focus mode integration
   - Smart quiet hours (learn from user behavior)

## References

- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Notification Preferences Best Practices](https://www.nngroup.com/articles/notifications/)
- [Timezone Handling in Node.js](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl)
