# Phase 4: Reliability Upgrades - Implementation Guide

## Overview
This document describes the implementation of Phase 4 reliability upgrades, including the Transactional Outbox pattern and strengthened idempotency mechanisms.

## Task 4.1: Transactional Outbox Pattern

### Architecture

The Transactional Outbox pattern ensures **at-least-once delivery** of events by:
1. Persisting events to a database table (outbox) in the same transaction as business logic
2. Using a separate relay worker to publish events from the outbox to the message broker
3. Marking events as published after successful delivery

```
┌─────────────────┐
│ Business Logic  │
│   (e.g., User   │
│    Follows)     │
└────────┬────────┘
         │
         ↓ (Same Transaction)
┌─────────────────┐
│  Outbox Table   │
│  - eventId      │
│  - payload      │
│  - published=F  │
└────────┬────────┘
         │
         ↓ (Polling)
┌─────────────────┐
│  Relay Worker   │
│  - Reads events │
│  - Publishes    │
│  - Marks done   │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│ Message Broker  │
│  (RabbitMQ)     │
└─────────────────┘
```

### Components Implemented

#### 1. Database Migration (`migrations/006_create_outbox.sql`)
Creates the outbox table with:
- `id`: Primary key
- `event_id`: Unique event identifier
- `event_type`: Type of event (UserFollowed, CommentCreated, etc.)
- `payload`: JSON event data
- `published`: Boolean flag
- `created_at`: When event was created
- `published_at`: When event was published
- `retry_count`: Number of publish attempts
- `last_error`: Last error message (for debugging)

Indexes:
- Compound index on `(published, created_at)` for efficient querying
- Index on `event_type` for filtering
- Index on `published_at` for analytics

#### 2. Outbox Model (`src/models/OutboxEvent.ts`)
Mongoose model for the outbox table with:
- Schema definition matching the database table
- Static methods:
  - `findUnpublished(limit)`: Get unpublished events
  - `markAsPublished(outboxId)`: Mark event as successfully published
  - `incrementRetryCount(outboxId, error)`: Track failed attempts

#### 3. Outbox Relay Service (`src/services/OutboxRelayService.ts`)
Background worker that:
- **Polls** the outbox table every 5 seconds (configurable)
- **Batch processes** up to 100 events at a time
- **Publishes** events to RabbitMQ
- **Updates** published status on success
- **Implements exponential backoff** for failures:
  - Base delay: 1 second
  - Max delay: 5 minutes
  - Jitter: ±20% to prevent thundering herd
  - Max retries: 10 (configurable)

**Exponential Backoff Formula:**
```
delay = min(baseDelay * 2^retryCount, maxDelay) ± jitter
```

#### 4. Event Publisher Service Updates (`src/services/EventPublisherService.ts`)
Enhanced with:
- **New method**: `publishEventWithOutbox(event, session?)`
  - Accepts optional MongoDB session for transactional consistency
  - Inserts event into outbox table
  - Returns eventId
- **Deprecated**: Direct `publishEvent()` method
  - Still available for non-critical events
  - Logs warning when used

### Usage Example

#### In Producer Service (e.g., User Service):
```typescript
// Start a MongoDB session for transaction
const session = await mongoose.startSession();
session.startTransaction();

try {
  // 1. Execute business logic
  const follow = new Follow({
    followerId: 'user-1',
    followeeId: 'user-2',
  });
  await follow.save({ session });

  // 2. Write to outbox (same transaction!)
  await eventPublisher.publishEventWithOutbox(
    {
      eventType: 'UserFollowed',
      followerId: 'user-1',
      followeeId: 'user-2',
      timestamp: new Date(),
    },
    session
  );

  // 3. Commit transaction
  await session.commitTransaction();
  
  // ✅ Both follow and outbox entry are persisted atomically
} catch (error) {
  await session.abortTransaction();
  // ❌ Neither follow nor outbox entry is persisted
} finally {
  session.endSession();
}
```

#### Starting the Relay Worker:
```typescript
import { outboxRelayService } from './services/OutboxRelayService';

// Start the relay worker
await outboxRelayService.start();

// Get stats
const stats = await outboxRelayService.getStats();
console.log(stats);
// {
//   unpublished: 5,
//   published: 1240,
//   failed: 2,
//   oldestUnpublished: 2026-01-06T10:30:00Z
// }

// Stop the relay worker (graceful shutdown)
await outboxRelayService.stop();
```

### Benefits

1. **Atomicity**: Business logic and event publishing succeed/fail together
2. **Reliability**: Events are never lost, even if broker is down
3. **Audit Trail**: All events are logged with timestamps and retry counts
4. **Resilience**: Automatic retries with exponential backoff
5. **Monitoring**: Easy to track unpublished events and identify issues

### Trade-offs

1. **Eventual Consistency**: Events are published with a delay (5s default)
2. **Database Load**: Additional writes to outbox table
3. **Storage**: Need to manage outbox table size (cleanup old published events)
4. **Complexity**: Additional service to manage and monitor

## Task 4.2: Strengthened Idempotency

### Architecture

Idempotency ensures that processing the same event multiple times has the same effect as processing it once.

**Two-layer defense:**
1. **Database constraint**: Unique index prevents duplicate rows
2. **Application check**: Explicit duplicate detection before insert

### Components Implemented

#### 1. Database Migration (`migrations/006_create_outbox.sql`)
Adds unique constraints to notifications table:
```sql
ALTER TABLE notifications 
ADD CONSTRAINT unique_user_resource_notification 
UNIQUE (user_id, category, resource_id);
```

**Note**: In MongoDB, this is implemented as a partial unique index:
```javascript
NotificationSchema.index(
  { userId: 1, category: 1, resourceId: 1 },
  { 
    unique: true,
    partialFilterExpression: { resourceId: { $exists: true, $ne: null } }
  }
);
```

#### 2. Notification Model Updates (`src/models/Notification.ts`)
Added:
- **New field**: `resourceId` - Identifier of the resource that triggered the notification
  - For UserFollowed: `followerId`
  - For CommentCreated: `postId` or `commentId`
  - For LikeCreated: `likerId-targetId` combination
  - For MentionCreated: `contextId`

- **New static methods**:
  - `findDuplicate(userId, category, resourceId)`: Check for existing notification
  - `findByEventId(eventId)`: Find notification by event ID in metadata

#### 3. NotificationService Updates (`src/services/NotificationService.ts`)
Enhanced `sendNotification()` method:

**Before creating notification:**
```typescript
// 1. Extract resourceId from metadata
const resourceId = request.metadata?.resourceId || 
                   request.metadata?.followerId || 
                   request.metadata?.postId;

// 2. Check for duplicate
if (resourceId) {
  const duplicate = await Notification.findDuplicate(
    request.userId,
    request.category,
    resourceId
  );
  
  if (duplicate) {
    // Return existing notification
    return {
      notificationId: duplicate.notificationId,
      status: 'success',
      message: 'Notification already exists (idempotent)',
      deliveryDetails: { /* ... */ }
    };
  }
}
```

**After save attempt:**
```typescript
try {
  await notification.save();
} catch (saveError) {
  // Handle duplicate key error (race condition)
  if (saveError.code === 11000) {
    const existing = await Notification.findDuplicate(
      userId, category, resourceId
    );
    // Return existing notification
  }
  throw saveError;
}
```

#### 4. EventHandlerService Updates (`src/services/EventHandlerService.ts`)
All event handlers now include `resourceId` in metadata:

**Example - UserFollowedEvent:**
```typescript
metadata: {
  originalEvent: event,
  eventId: event.eventId,
  resourceId: event.followerId // Unique per follower
}
```

**Example - LikeCreatedEvent:**
```typescript
metadata: {
  originalEvent: event,
  eventId: event.eventId,
  resourceId: `${event.likerId}-${event.targetId}` // Unique per like
}
```

### Idempotency Scenarios

#### Scenario 1: Normal Duplicate Event
```
Event 1 (eventId: abc123) → Create Notification (✅)
Event 2 (eventId: abc456, same resourceId) → Skip (Application Check)
```

#### Scenario 2: Race Condition
```
Event 1 → Check duplicate (none) → Save (✅)
Event 2 → Check duplicate (none) → Save (❌ Unique constraint violation)
         → Catch error → Find existing → Return existing (✅)
```

#### Scenario 3: Retry After Failure
```
Event 1 → Create Notification (✅)
Event 1 (retry) → Check duplicate (found) → Return existing (✅)
```

### Testing Idempotency

```typescript
// Test duplicate prevention
const event = {
  eventId: 'test-event-1',
  eventType: 'UserFollowed',
  followerId: 'user-1',
  followeeId: 'user-2',
};

// First call creates notification
const result1 = await handleUserFollowedEvent(event);
// notificationId: notif-1

// Second call returns existing notification
const result2 = await handleUserFollowedEvent(event);
// notificationId: notif-1 (same!)

// Verify only one notification in database
const count = await Notification.countDocuments({
  userId: 'user-2',
  category: 'social',
  resourceId: 'user-1'
});
// count === 1 ✅
```

## Monitoring & Operations

### Outbox Health Checks

```typescript
// Add to health check endpoint
app.get('/health/outbox', async (req, res) => {
  const stats = await outboxRelayService.getStats();
  
  const health = {
    status: stats.unpublished < 1000 ? 'healthy' : 'degraded',
    unpublished: stats.unpublished,
    published: stats.published,
    failed: stats.failed,
    oldestUnpublished: stats.oldestUnpublished,
    lagMinutes: stats.oldestUnpublished 
      ? (Date.now() - stats.oldestUnpublished.getTime()) / 60000
      : 0
  };
  
  res.json(health);
});
```

### Metrics to Track

1. **Outbox metrics**:
   - Unpublished event count
   - Publishing lag (time between create and publish)
   - Retry count distribution
   - Failed event count

2. **Idempotency metrics**:
   - Duplicate detection rate
   - Unique constraint violations caught
   - Application-level duplicates prevented

3. **Performance metrics**:
   - Outbox poll duration
   - Batch processing time
   - Event publishing latency

### Cleanup Strategy

**Outbox table growth management:**

```typescript
// Periodic cleanup job (run daily)
async function cleanupOutbox() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 7); // Keep 7 days
  
  const result = await OutboxEvent.deleteMany({
    published: true,
    publishedAt: { $lt: cutoffDate }
  });
  
  logger.info(`Cleaned up ${result.deletedCount} old outbox entries`);
}
```

## Deployment Considerations

### Rolling Deployment
1. Deploy notification service first (consumers)
2. Deploy outbox relay worker
3. Deploy producer services with outbox integration
4. Gradually migrate producers to use outbox pattern

### Rollback Strategy
- Old code can still publish directly to broker
- New code writes to outbox (relay publishes)
- Both approaches work simultaneously
- Gradual migration reduces risk

### Database Migrations
```bash
# Run migration before deployment
npm run migrate:up

# Rollback if needed
npm run migrate:down
```

## Performance Characteristics

### Outbox Pattern
- **Write latency**: +5-10ms (one additional DB write)
- **Publish latency**: +5s average (polling interval)
- **Throughput**: Limited by DB write capacity and relay worker batch size
- **Scalability**: Relay worker can be horizontally scaled

### Idempotency Checks
- **Application check**: +1-2ms (indexed query)
- **Constraint check**: 0ms (database enforces)
- **Space overhead**: ~50 bytes per notification (resourceId + index)

## Troubleshooting

### Issue: Events not being published
**Check:**
1. Is relay worker running? `outboxRelayService.start()`
2. Check unpublished count: `outboxRelayService.getStats()`
3. Check relay worker logs for errors
4. Verify RabbitMQ connection

### Issue: Duplicate notifications still created
**Check:**
1. Is resourceId being set correctly in metadata?
2. Check unique index exists: `db.notifications.getIndexes()`
3. Verify application-level check is running
4. Check logs for duplicate detection

### Issue: High outbox lag
**Possible causes:**
1. Message broker slow/down → Increase relay workers
2. High event volume → Decrease polling interval or increase batch size
3. Many retries → Investigate root cause of publish failures

## Future Enhancements

1. **Dead Letter Queue**: Move failed events (max retries exceeded) to DLQ
2. **Priority Publishing**: Publish high-priority events first
3. **Monitoring Dashboard**: Real-time view of outbox health
4. **Automatic Cleanup**: TTL-based cleanup of old events
5. **Multi-region Support**: Replicate outbox across regions
6. **Event Replay**: Ability to replay events from outbox for debugging

## References

- [Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html)
- [Idempotency Patterns](https://blog.pragmaticengineer.com/idempotency-patterns/)
- [At-Least-Once Delivery](https://www.cloudamqp.com/blog/part4-rabbitmq-for-beginners-exchanges-routing-keys-bindings.html)
