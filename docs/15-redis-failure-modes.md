# Redis Failure Modes and Behavior

This document describes how the Notifications microservice behaves when Redis is unavailable or experiencing issues. Understanding these failure modes is critical for operations and incident response.

## Overview

The Notifications service uses Redis for:
1. **Rate Limiting** - Tracking request rates per user/IP
2. **Caching** - Notification feeds, follower data, user preferences
3. **Idempotency** - Preventing duplicate event processing
4. **Session/Locks** - Distributed locks for concurrent operations

## Failure Mode: FAIL-OPEN vs FAIL-CLOSED

| Feature | Failure Mode | Behavior When Redis Down | Justification |
|---------|--------------|--------------------------|---------------|
| Rate Limiting | **FAIL-OPEN** | Requests allowed through | Availability > strict rate limiting |
| Caching | **FAIL-OPEN** | Falls back to database | User experience maintained |
| Idempotency | **FAIL-OPEN** | Falls back to MongoDB | Processing continues, duplicates possible |
| Distributed Locks | **FAIL-OPEN** | Proceed without lock | May cause duplicate work |

### Why Fail-Open for Rate Limiting?

We chose **fail-open** behavior for rate limiting because:

1. **Availability Priority**: User-facing operations should not fail due to Redis issues
2. **Transient Failures**: Redis issues are typically short-lived (< 30 seconds)
3. **Defense in Depth**: Other layers (API Gateway, Load Balancer, Cloud WAF) provide backup rate limiting
4. **User Experience**: Better to serve requests than to return 503 errors

**Trade-off**: During Redis outages, malicious actors could potentially exceed rate limits. This is mitigated by:
- Circuit breaker limiting the blast radius
- API Gateway rate limiting as backup
- Monitoring and alerting on Redis health

## Circuit Breaker Configuration

```typescript
// src/utils/circuitBreaker.ts
{
  name: 'redis',
  failureThreshold: 5,      // Open after 5 consecutive failures
  recoveryTimeout: 30000,   // Try to recover after 30 seconds
  successThreshold: 2,      // Close after 2 successful requests
  failOpen: true,           // Allow requests when circuit is open
}
```

### Circuit Breaker States

| State | Description | Rate Limiting Behavior |
|-------|-------------|------------------------|
| **CLOSED** | Normal operation | Enforced via Redis |
| **HALF-OPEN** | Testing recovery | Enforced, testing Redis |
| **OPEN** | Redis failing | **Bypassed** (fail-open) |

## Monitoring & Alerting

### Key Metrics to Monitor

```
# Prometheus metrics
redis_circuit_breaker_state{service="redis"} # 0=closed, 1=half-open, 2=open
redis_circuit_breaker_failures_total
redis_operations_fallback_total
rate_limit_bypass_total
```

### Alert Thresholds

| Alert | Threshold | Severity |
|-------|-----------|----------|
| Redis Circuit Open | State = OPEN for > 1 min | **Critical** |
| High Failure Rate | > 10 failures/min | Warning |
| Fallback Usage High | > 100 fallbacks/min | Warning |
| Redis Disconnected | Connection lost | Critical |

## Failure Scenarios

### Scenario 1: Redis Network Partition

**Symptoms:**
- Connection timeouts
- Circuit breaker opens
- Rate limit bypass logs appear

**Behavior:**
1. First 5 requests fail (circuit closed)
2. Circuit opens after failure threshold
3. Subsequent requests bypass rate limiting
4. After 30s, circuit enters half-open
5. If Redis responds, circuit closes

**User Impact:** None (requests continue)

**Response Headers:**
```http
X-RateLimit-Status: bypassed-fail-open
```

### Scenario 2: Redis OOM (Out of Memory)

**Symptoms:**
- Redis rejects writes
- Cache updates fail
- Idempotency checks may miss

**Behavior:**
1. Writes to Redis fail
2. Idempotency falls back to MongoDB
3. Cache operations return fallback values
4. Service continues with degraded performance

**User Impact:** Slightly slower responses

### Scenario 3: Redis Slow Responses

**Symptoms:**
- High latency on Redis operations
- Timeout errors
- Circuit breaker may trip

**Behavior:**
1. Operations timeout after 5s
2. Recorded as failures
3. If sustained, circuit opens
4. Falls back to MongoDB/memory cache

**User Impact:** Initial requests slow, then normal after fallback

## Idempotency Fallback

When Redis is unavailable, idempotency checking falls back to MongoDB:

```
Priority Order:
1. In-memory cache (fastest, process-local)
2. Redis cache (fast, distributed)
3. MongoDB collection (slower, durable)
```

**Trade-offs:**
- MongoDB is slower than Redis for key checks
- In-memory cache is not shared across pods
- Small window for duplicates during failover

## Configuration

### Environment Variables

```bash
# Redis connection
REDIS_URL=redis://localhost:6379

# Circuit breaker tuning
REDIS_CIRCUIT_FAILURE_THRESHOLD=5
REDIS_CIRCUIT_RECOVERY_TIMEOUT=30000
REDIS_CIRCUIT_SUCCESS_THRESHOLD=2

# Fallback behavior
REDIS_FAIL_OPEN=true  # Set to false for fail-closed behavior
```

### Changing to Fail-Closed

If you need strict rate limiting enforcement (security-critical scenarios):

```typescript
// src/utils/circuitBreaker.ts
export const redisCircuitBreaker = new CircuitBreaker({
  name: 'redis',
  failOpen: false,  // Change to fail-closed
  // ...
});
```

**Warning:** Fail-closed means requests will be rejected (503) when Redis is down.

## Recovery Procedures

### 1. Redis Recovery
When Redis comes back online:
1. Circuit breaker enters half-open state
2. Test requests verify Redis is healthy
3. After 2 successful requests, circuit closes
4. Normal operation resumes

### 2. Manual Circuit Reset
If circuit is stuck open:
```typescript
import { redisCircuitBreaker } from './utils/circuitBreaker';
redisCircuitBreaker.forceClose();
```

Or via admin API (if exposed):
```bash
curl -X POST /admin/circuit-breaker/redis/reset
```

## Testing Failure Modes

### Local Testing

```bash
# Stop Redis to simulate failure
docker stop redis

# Watch logs for circuit breaker activity
docker logs -f notifications-api

# Observe behavior:
# - First 5 requests: Redis errors logged
# - After 5 failures: "Circuit breaker OPENED" log
# - Requests continue with "bypassed-fail-open" header

# Restart Redis
docker start redis

# Watch for recovery:
# - "Circuit breaker HALF-OPEN" log
# - "Circuit breaker CLOSED" after successful tests
```

### Chaos Testing

Use chaos engineering tools to simulate:
- Network partitions
- Latency injection
- Memory pressure

## FAQ

**Q: Why not use a local fallback rate limiter?**
A: We do! When Redis is unavailable, we fall back to in-memory rate limiting, but this is per-pod and doesn't provide distributed rate limiting.

**Q: What happens if MongoDB is also down?**
A: The service will fail on notification creation (primary storage). Health checks will fail and pods will be marked unhealthy.

**Q: How long can Redis be down?**
A: Indefinitely for rate limiting (fail-open). For idempotency, extended outages increase duplicate risk.

**Q: Can I change the recovery timeout?**
A: Yes, via `REDIS_CIRCUIT_RECOVERY_TIMEOUT` environment variable (milliseconds).

---

## Summary

| Component | Redis Down Behavior | MongoDB Fallback | User Impact |
|-----------|---------------------|------------------|-------------|
| Rate Limiting | ⚠️ Bypassed | N/A | None |
| Feed Caching | ✅ Database fetch | Yes | Slower |
| Idempotency | ✅ MongoDB check | Yes | None |
| Session Locks | ⚠️ Proceed unlocked | N/A | Potential duplicates |

**Legend:**
- ✅ Gracefully handled
- ⚠️ Degraded functionality
