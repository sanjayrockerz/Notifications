# Data Flow Diagrams

## 1. Happy Path: Follow Event → Notification → Push

```mermaid
sequenceDiagram
    participant US as User Service
    participant RMQ as RabbitMQ
    participant EC as Event Consumer
    participant Redis as Redis Cache
    participant NS as Notification Service
    participant MongoDB as MongoDB
    participant DW as Delivery Worker
    participant FCM as Firebase FCM
    participant Device as Mobile Device

    Note over US, Device: Timeline: 0-10 seconds end-to-end
    
    %% Event Publishing (0-100ms)
    US->>RMQ: Publish UserFollowed Event
    Note right of US: t=0ms: User A follows User B
    RMQ->>EC: Consume Event
    
    %% Event Processing (100-500ms)
    EC->>EC: Validate Event Schema
    Note right of EC: t=50ms: Zod validation
    
    EC->>Redis: Check Idempotency Key
    Redis-->>EC: Key Not Found
    Note right of EC: t=100ms: First occurrence
    
    EC->>NS: Create Notification
    Note right of EC: t=150ms: Process UserFollowed
    
    %% Notification Creation (500-1000ms)
    NS->>MongoDB: Save Notification Record
    Note right of NS: t=200ms: Persist notification
    
    NS->>MongoDB: Get User Devices
    MongoDB-->>NS: Active Device Tokens
    Note right of NS: t=300ms: 3 active devices found
    
    NS->>MongoDB: Check User Preferences
    MongoDB-->>NS: Preferences Allow
    Note right of NS: t=400ms: Social notifications enabled
    
    NS->>Redis: Mark Event Processed
    Note right of NS: t=450ms: Set 7-day TTL
    
    %% Delivery Processing (1-3 seconds)
    NS->>DW: Queue for Delivery
    Note right of NS: t=500ms: Add to delivery queue
    
    DW->>DW: Batch Notifications
    Note right of DW: t=1000ms: Batch of 50 notifications
    
    DW->>FCM: Send Batch Request
    Note right of DW: t=1500ms: FCM batch API call
    
    FCM-->>DW: Batch Response
    Note right of FCM: t=2000ms: 3 success, 0 failures
    
    %% Device Delivery (3-10 seconds)
    DW->>MongoDB: Update Delivery Status
    Note right of DW: t=2100ms: Mark as 'sent'
    
    FCM->>Device: Push Notification
    Note right of FCM: t=2500ms: Network delivery
    
    Device-->>FCM: Delivery Confirmation
    Note right of Device: t=8000ms: User device receives
    
    FCM->>DW: Delivery Receipt (Webhook)
    DW->>MongoDB: Update to 'delivered'
    Note right of DW: t=8500ms: Final status update
    
    %% User Interaction (Variable)
    Device->>NS: Notification Opened
    Note right of Device: t=30000ms: User clicks notification
    NS->>MongoDB: Record Interaction
```

### Performance Breakdown
| Phase | Duration | Components | Key Operations |
|-------|----------|------------|----------------|
| **Event Ingestion** | 0-100ms | RabbitMQ → Consumer | Message routing, consumption |
| **Event Validation** | 50-150ms | Event Consumer | Schema validation, idempotency check |
| **Notification Creation** | 150-500ms | Notification Service | DB queries, preference checks |
| **Delivery Queuing** | 500-1000ms | Delivery Worker | Batching, queue management |
| **Push Transmission** | 1.5-3s | FCM/APNs | External API calls |
| **Device Delivery** | 3-10s | Mobile Network | Network latency, device processing |

## 2. Duplicate Event Handling (Idempotency)

```mermaid
sequenceDiagram
    participant US as User Service
    participant RMQ as RabbitMQ
    participant EC1 as Event Consumer 1
    participant EC2 as Event Consumer 2
    participant Redis as Redis Cache
    participant NS as Notification Service
    participant MongoDB as MongoDB

    Note over US, MongoDB: Same Event ID Processed Twice
    
    %% First Event Processing
    US->>RMQ: UserFollowed Event (ID: uuid-123)
    RMQ->>EC1: Consume Event #1
    
    %% Concurrent Second Event
    US->>RMQ: UserFollowed Event (ID: uuid-123)
    Note right of US: Duplicate due to retry/network issue
    RMQ->>EC2: Consume Event #2 (Same ID)
    
    %% Parallel Processing
    par Event Consumer 1
        EC1->>Redis: SET event:uuid-123 NX
        Redis-->>EC1: OK (Lock Acquired)
        EC1->>NS: Process Event
        NS->>MongoDB: Create Notification
        EC1->>Redis: SETEX processed:uuid-123 (7 days TTL)
        Note right of EC1: Event processed successfully
    and Event Consumer 2
        EC2->>Redis: SET event:uuid-123 NX
        Redis-->>EC2: NIL (Lock Exists)
        EC2->>EC2: Wait 100ms
        EC2->>Redis: EXISTS processed:uuid-123
        Redis-->>EC2: 1 (Already Processed)
        EC2->>EC2: Skip Processing
        Note right of EC2: Idempotency check prevents duplicate
    end
    
    EC1-->>RMQ: ACK Message #1
    EC2-->>RMQ: ACK Message #2
    
    Note over US, MongoDB: Result: Single notification created
```

### Idempotency Implementation Details

```typescript
// Redis-based distributed locking for idempotency
class IdempotencyHandler {
  async processWithIdempotency(eventId: string, processor: () => Promise<void>): Promise<boolean> {
    const lockKey = `lock:event:${eventId}`;
    const processedKey = `processed:event:${eventId}`;
    
    // 1. Try to acquire processing lock (30 second TTL)
    const lockAcquired = await redis.set(lockKey, Date.now(), 'PX', 30000, 'NX');
    
    if (!lockAcquired) {
      // Another instance is processing, wait and check if completed
      await this.waitForCompletion(processedKey);
      return false; // Event processed by another instance
    }
    
    try {
      // 2. Check if already processed
      const alreadyProcessed = await redis.exists(processedKey);
      if (alreadyProcessed) {
        return false;
      }
      
      // 3. Process the event
      await processor();
      
      // 4. Mark as processed (7-day retention)
      await redis.setex(processedKey, 7 * 24 * 60 * 60, JSON.stringify({
        eventId,
        processedAt: new Date().toISOString(),
        processedBy: process.env.HOSTNAME || 'unknown'
      }));
      
      return true; // Successfully processed
      
    } finally {
      // 5. Release lock
      await redis.del(lockKey);
    }
  }
}
```

## 3. Invalid Token Detection & Cleanup Flow

```mermaid
sequenceDiagram
    participant DW as Delivery Worker
    participant FCM as Firebase FCM
    participant APNS as Apple APNs
    participant MongoDB as MongoDB
    participant TLM as Token Lifecycle Manager
    participant CLS as Cleanup Service

    Note over DW, CLS: Invalid Token Lifecycle Management
    
    %% Delivery Attempt
    DW->>FCM: Send Notification (Token: invalid-fcm-token)
    FCM-->>DW: Error: InvalidRegistration
    Note right of FCM: Token is invalid/expired
    
    DW->>APNS: Send Notification (Token: expired-apns-token)
    APNS-->>DW: Error: 410 Gone
    Note right of APNS: Device token no longer valid
    
    %% Error Handling
    DW->>MongoDB: Increment Failure Count
    Note right of DW: failureCount += 1
    
    DW->>TLM: Report Invalid Token
    TLM->>MongoDB: Update Device Status
    Note right of TLM: Mark device as inactive
    
    alt Failure Count < 5
        TLM->>MongoDB: Keep Device (Temporary Issue)
        Note right of TLM: Wait for token refresh
    else Failure Count >= 5
        TLM->>MongoDB: Deactivate Device
        Note right of TLM: isActive = false
    end
    
    %% Scheduled Cleanup
    Note over CLS: Daily Cleanup Job (2 AM UTC)
    CLS->>MongoDB: Find Inactive Devices
    MongoDB-->>CLS: 1,500 devices (30+ days inactive)
    
    loop Batch Processing (100 devices/batch)
        CLS->>MongoDB: Delete Batch
        CLS->>CLS: Log Cleanup Stats
        Note right of CLS: Batch 1/15 processed
    end
    
    CLS->>MongoDB: Update Cleanup Metrics
    Note right of CLS: 1,500 devices cleaned up
```

### Token Validation Logic

```typescript
class TokenValidator {
  async handleDeliveryError(deviceId: string, error: PushError): Promise<void> {
    const device = await Device.findById(deviceId);
    if (!device) return;
    
    // Categorize error types
    const isTokenInvalid = this.isTokenInvalidError(error);
    const isTemporary = this.isTemporaryError(error);
    
    if (isTokenInvalid) {
      // Immediately deactivate invalid tokens
      device.isActive = false;
      device.failureCount = 10; // Mark for cleanup
      device.lastFailure = new Date();
      
      logger.warn('Invalid token detected', {
        deviceId: device._id,
        userId: device.userId,
        platform: device.platform,
        errorCode: error.code
      });
      
    } else if (isTemporary) {
      // Increment failure count for temporary issues
      device.failureCount += 1;
      device.lastFailure = new Date();
      
      // Deactivate after 5 consecutive failures
      if (device.failureCount >= 5) {
        device.isActive = false;
      }
      
    } else {
      // Unknown error - treat as temporary
      device.failureCount += 1;
    }
    
    await device.save();
  }
  
  private isTokenInvalidError(error: PushError): boolean {
    const invalidCodes = [
      'messaging/registration-token-not-registered',
      'messaging/invalid-registration-token',
      'BadDeviceToken',
      'Unregistered',
      'DeviceTokenNotForTopic'
    ];
    
    return invalidCodes.includes(error.code) || 
           error.statusCode === 410; // APNs Gone
  }
  
  private isTemporaryError(error: PushError): boolean {
    const temporaryCodes = [
      'messaging/server-unavailable',
      'messaging/internal-error',
      'ServiceUnavailable',
      'TooManyRequests'
    ];
    
    return temporaryCodes.includes(error.code) ||
           error.statusCode === 429 || // Rate limited
           error.statusCode === 503;   // Service unavailable
  }
}
```

## 4. Batch Processing & Delivery Optimization

```mermaid
graph TB
    subgraph "Batch Collection"
        POLL[Poll Database]
        COLLECT[Collect Pending]
        GROUP[Group by Platform]
    end
    
    subgraph "Batch Optimization"
        DEDUPE[Deduplicate Recipients]
        PRIORITY[Priority Sorting]
        SIZE[Batch Sizing]
    end
    
    subgraph "Platform Delivery"
        FCM_BATCH[FCM Batch<br/>Max 500/request]
        APNS_BATCH[APNs Batch<br/>Max 100/connection]
        PARALLEL[Parallel Sending]
    end
    
    subgraph "Result Processing"
        SUCCESS[Success Tracking]
        FAILURE[Failure Handling]
        RETRY[Retry Queue]
        DLQ[Dead Letter Queue]
    end
    
    POLL --> COLLECT
    COLLECT --> GROUP
    GROUP --> DEDUPE
    DEDUPE --> PRIORITY
    PRIORITY --> SIZE
    
    SIZE --> FCM_BATCH
    SIZE --> APNS_BATCH
    
    FCM_BATCH --> PARALLEL
    APNS_BATCH --> PARALLEL
    
    PARALLEL --> SUCCESS
    PARALLEL --> FAILURE
    
    FAILURE --> RETRY
    RETRY --> DLQ
    
    SUCCESS --> POLL
    DLQ --> POLL
```

### Batch Processing Implementation

```typescript
class BatchProcessor {
  private readonly FCM_BATCH_SIZE = 500;
  private readonly APNS_BATCH_SIZE = 100;
  private readonly MAX_CONCURRENT_BATCHES = 10;
  
  async processBatch(): Promise<void> {
    // 1. Collect pending notifications
    const pending = await this.collectPendingNotifications(1000);
    if (pending.length === 0) return;
    
    // 2. Group and optimize
    const optimized = this.optimizeBatch(pending);
    
    // 3. Create platform-specific batches
    const fcmBatches = this.createBatches(optimized.fcm, this.FCM_BATCH_SIZE);
    const apnsBatches = this.createBatches(optimized.apns, this.APNS_BATCH_SIZE);
    
    // 4. Process batches concurrently with limit
    await this.processConcurrentBatches([
      ...fcmBatches.map(batch => () => this.sendFCMBatch(batch)),
      ...apnsBatches.map(batch => () => this.sendAPNsBatch(batch))
    ]);
  }
  
  private optimizeBatch(notifications: Notification[]): OptimizedBatch {
    const grouped = this.groupByPlatform(notifications);
    
    return {
      fcm: this.deduplicateAndPrioritize(grouped.android),
      apns: this.deduplicateAndPrioritize(grouped.ios)
    };
  }
  
  private async processConcurrentBatches(batches: (() => Promise<void>)[]): Promise<void> {
    // Process batches with concurrency limit
    for (let i = 0; i < batches.length; i += this.MAX_CONCURRENT_BATCHES) {
      const chunk = batches.slice(i, i + this.MAX_CONCURRENT_BATCHES);
      await Promise.all(chunk.map(batch => batch()));
    }
  }
}
```

## 5. Real-time Metrics & Monitoring Flow

```mermaid
sequenceDiagram
    participant App as Application
    participant Metrics as Metrics Collector
    participant Prometheus as Prometheus
    participant Grafana as Grafana
    participant Alert as AlertManager
    participant PagerDuty as PagerDuty

    Note over App, PagerDuty: Real-time Monitoring Pipeline
    
    loop Every Request/Event
        App->>Metrics: Emit Metrics
        Note right of App: Counter, Histogram, Gauge
    end
    
    loop Every 15 seconds
        Prometheus->>Metrics: Scrape /metrics
        Metrics-->>Prometheus: Metrics Data
    end
    
    loop Every 5 minutes
        Grafana->>Prometheus: Query Metrics
        Prometheus-->>Grafana: Time Series Data
    end
    
    alt Alert Condition Met
        Prometheus->>Alert: Fire Alert
        Note right of Prometheus: Error Rate > 5%
        Alert->>PagerDuty: Critical Alert
        PagerDuty-->>Alert: Incident Created
        
        Note over Alert, PagerDuty: On-call engineer paged
    else Normal Operation
        Note over Prometheus, Grafana: Dashboards updated
    end
```

### Key Metrics Tracked

```typescript
// Prometheus metrics definitions
const metrics = {
  // Counters
  notificationsSent: new Counter({
    name: 'notifications_sent_total',
    help: 'Total number of notifications sent',
    labelNames: ['platform', 'status', 'priority']
  }),
  
  eventsProcessed: new Counter({
    name: 'events_processed_total', 
    help: 'Total events processed',
    labelNames: ['event_type', 'status']
  }),
  
  // Histograms
  deliveryLatency: new Histogram({
    name: 'notification_delivery_duration_seconds',
    help: 'Time from event to delivery',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60]
  }),
  
  // Gauges
  queueDepth: new Gauge({
    name: 'notification_queue_depth',
    help: 'Current queue depth',
    labelNames: ['queue_type']
  }),
  
  activeDevices: new Gauge({
    name: 'devices_active_count',
    help: 'Number of active devices',
    labelNames: ['platform']
  })
};
```