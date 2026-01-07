# System Overview & Architecture

## 1. System Overview Diagram

```mermaid
graph TB
    %% External Producers
    subgraph "External Services"
        US[User Service]
        CS[Content Service]
        OS[Order Service]
        PS[Payment Service]
    end

    %% Message Broker
    subgraph "Message Infrastructure"
        RMQ[RabbitMQ Broker]
        EX1[notifications Exchange]
        Q1[notification_queue]
        DLQ[Dead Letter Queue]
    end

    %% Core Notification Service
    subgraph "Notification Service"
        API[API Gateway]
        AUTH[Auth Middleware]
        EC[Event Consumer]
        NS[Notification Service]
        DS[Delivery Service]
        SCH[Scheduler Service]
        CLS[Cleanup Service]
    end

    %% Workers & Delivery
    subgraph "Delivery Workers"
        DW1[Delivery Worker 1]
        DW2[Delivery Worker 2]
        DW3[Delivery Worker N]
        BATCH[Batch Processor]
        RETRY[Retry Handler]
    end

    %% Push Providers
    subgraph "Push Providers"
        FCM[Firebase FCM]
        APNS[Apple APNs]
    end

    %% Mobile Devices
    subgraph "Mobile Devices"
        AND[Android Devices]
        IOS[iOS Devices]
    end

    %% Data Layer
    subgraph "Data Layer"
        MONGO[(MongoDB)]
        REDIS[(Redis Cache)]
        METRICS[(Metrics Store)]
    end

    %% Flow connections
    US -->|UserFollowed Event| EX1
    CS -->|CommentCreated Event| EX1
    CS -->|MentionCreated Event| EX1
    OS -->|OrderStatus Event| EX1
    PS -->|PaymentStatus Event| EX1

    EX1 --> Q1
    Q1 --> EC
    Q1 --> DLQ

    API --> AUTH
    AUTH --> NS
    EC --> NS

    NS --> DS
    DS --> DW1
    DS --> DW2
    DS --> DW3

    DW1 --> BATCH
    DW2 --> BATCH
    DW3 --> BATCH
    BATCH --> RETRY

    RETRY --> FCM
    RETRY --> APNS

    FCM --> AND
    APNS --> IOS

    NS --> MONGO
    NS --> REDIS
    DS --> MONGO
    EC --> REDIS

    SCH --> MONGO
    CLS --> MONGO
    CLS --> REDIS

    %% Monitoring
    NS --> METRICS
    DS --> METRICS
    DW1 --> METRICS
    DW2 --> METRICS
    DW3 --> METRICS

    classDef service fill:#e1f5fe
    classDef data fill:#f3e5f5
    classDef external fill:#fff3e0
    classDef mobile fill:#e8f5e8

    class US,CS,OS,PS external
    class MONGO,REDIS,METRICS data
    class AND,IOS mobile
    class API,EC,NS,DS,SCH,CLS,DW1,DW2,DW3 service
```

## 2. High-Level Architecture Principles

### Event-Driven Architecture
- **Producers**: External services publish domain events
- **Broker**: RabbitMQ handles reliable message delivery
- **Consumer**: Idempotent event processing with deduplication
- **Workers**: Parallel notification delivery processing

### Key Characteristics
- ✅ **Scalable**: Horizontally scalable workers and consumers
- ✅ **Resilient**: Circuit breakers, retries, dead letter queues
- ✅ **Observable**: Comprehensive metrics and logging
- ✅ **Secure**: JWT auth, rate limiting, TLS encryption
- ✅ **Performant**: Redis caching, connection pooling

## 3. Service Boundaries

### Notification Service Responsibilities
- Event consumption and validation
- Notification creation and scheduling
- Device token management
- User preference management
- Delivery orchestration

### External Dependencies
- **Message Broker**: Event ingestion
- **Push Providers**: FCM/APNs delivery
- **Databases**: State persistence and caching
- **Identity Provider**: Authentication/authorization

## 4. Technology Stack

| Component | Technology | Purpose |
|-----------|------------|----------|
| **Runtime** | Node.js 18+ | High-performance JavaScript runtime |
| **Framework** | Express.js | REST API and middleware |
| **Language** | TypeScript | Type safety and developer experience |
| **Database** | MongoDB | Document storage for notifications |
| **Cache** | Redis | Session state and rate limiting |
| **Messaging** | RabbitMQ | Event-driven communication |
| **Push** | FCM + APNs | Mobile push notification delivery |
| **Monitoring** | Winston + Prometheus | Logging and metrics |
| **Container** | Docker | Containerization and deployment |
| **Orchestration** | Kubernetes | Container orchestration |

## 5. Capacity Planning

### Current Scale Targets
```
API Requests:    10,000 RPM
Event Ingestion: 50,000 events/minute
Push Delivery:   100,000 pushes/minute
Active Devices:  1M+ registered devices
Storage:         100GB+ notifications
Retention:       30 days default
```

### Performance Characteristics
```
API Latency:     P95 < 200ms
Event Processing: P95 < 5s end-to-end
Push Delivery:   P95 < 10s from event
Throughput:      100K+ notifications/second
Availability:    99.5% SLA target
```