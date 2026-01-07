import { logger } from '../utils/logger';
import { recordMetric } from '../utils/metrics';

/**
 * Circuit Breaker States
 * - CLOSED: Normal operation, all requests allowed
 * - OPEN: Error threshold exceeded, requests blocked
 * - HALF_OPEN: Testing recovery, limited requests allowed
 */
export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

/**
 * Circuit Breaker Configuration
 */
export interface CircuitBreakerConfig {
  /** Error rate threshold to open circuit (0-1, e.g., 0.05 = 5%) */
  errorThreshold: number;
  /** Time window for calculating error rate (milliseconds) */
  windowSize: number;
  /** Minimum requests in window before checking threshold */
  minimumRequests: number;
  /** Time to wait before transitioning from OPEN to HALF_OPEN (milliseconds) */
  openTimeout: number;
  /** Number of successful test requests to close circuit from HALF_OPEN */
  halfOpenSuccessThreshold: number;
  /** Maximum number of requests allowed in HALF_OPEN state */
  halfOpenMaxRequests: number;
  /** Time to stay above threshold before opening (milliseconds) */
  errorDuration: number;
}

/**
 * Request result tracking
 */
interface RequestRecord {
  timestamp: number;
  success: boolean;
}

/**
 * Circuit Breaker Service
 * Protects external services (APNS, FCM) from cascading failures
 * by tracking error rates and temporarily blocking requests when threshold exceeded.
 */
export class CircuitBreakerService {
  private state: CircuitState = CircuitState.CLOSED;
  private requests: RequestRecord[] = [];
  private stateChangedAt: number = Date.now();
  private errorThresholdExceededSince: number | null = null;
  private halfOpenRequestCount: number = 0;
  private halfOpenSuccessCount: number = 0;

  constructor(
    private readonly name: string,
    private readonly config: CircuitBreakerConfig
  ) {
    logger.info(`Circuit breaker initialized: ${name}`, { config });
  }

  /**
   * Check if request should be allowed
   */
  public allowRequest(): boolean {
    this.cleanupOldRequests();
    this.checkStateTransitions();

    switch (this.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        return false;

      case CircuitState.HALF_OPEN:
        if (this.halfOpenRequestCount < this.config.halfOpenMaxRequests) {
          this.halfOpenRequestCount++;
          return true;
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Record successful request
   */
  public recordSuccess(): void {
    this.requests.push({
      timestamp: Date.now(),
      success: true,
    });

    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenSuccessCount++;
      this.checkHalfOpenTransition();
    }

    this.emitMetrics();
  }

  /**
   * Record failed request
   */
  public recordFailure(): void {
    this.requests.push({
      timestamp: Date.now(),
      success: false,
    });

    if (this.state === CircuitState.HALF_OPEN) {
      // Failure in HALF_OPEN -> back to OPEN
      this.transitionTo(CircuitState.OPEN);
    }

    this.emitMetrics();
  }

  /**
   * Get current circuit state
   */
  public getState(): CircuitState {
    return this.state;
  }

  /**
   * Get circuit breaker statistics
   */
  public getStats(): {
    state: CircuitState;
    errorRate: number;
    totalRequests: number;
    successCount: number;
    failureCount: number;
    stateChangedAt: Date;
    timeSinceStateChange: number;
  } {
    this.cleanupOldRequests();

    const successCount = this.requests.filter((r) => r.success).length;
    const failureCount = this.requests.filter((r) => !r.success).length;
    const totalRequests = this.requests.length;
    const errorRate = totalRequests > 0 ? failureCount / totalRequests : 0;

    return {
      state: this.state,
      errorRate,
      totalRequests,
      successCount,
      failureCount,
      stateChangedAt: new Date(this.stateChangedAt),
      timeSinceStateChange: Date.now() - this.stateChangedAt,
    };
  }

  /**
   * Force circuit to specific state (for testing/manual intervention)
   */
  public forceState(newState: CircuitState): void {
    logger.warn(`Circuit breaker ${this.name} forced to state: ${newState}`);
    this.transitionTo(newState);
  }

  /**
   * Reset circuit breaker to initial state
   */
  public reset(): void {
    logger.info(`Circuit breaker ${this.name} reset`);
    this.requests = [];
    this.errorThresholdExceededSince = null;
    this.halfOpenRequestCount = 0;
    this.halfOpenSuccessCount = 0;
    this.transitionTo(CircuitState.CLOSED);
  }

  /**
   * Remove old requests outside the time window
   */
  private cleanupOldRequests(): void {
    const cutoff = Date.now() - this.config.windowSize;
    this.requests = this.requests.filter((r) => r.timestamp > cutoff);
  }

  /**
   * Check if state transitions should occur
   */
  private checkStateTransitions(): void {
    const now = Date.now();

    switch (this.state) {
      case CircuitState.CLOSED:
        this.checkClosedToOpen(now);
        break;

      case CircuitState.OPEN:
        this.checkOpenToHalfOpen(now);
        break;

      case CircuitState.HALF_OPEN:
        // Transitions handled in record methods
        break;
    }
  }

  /**
   * Check transition from CLOSED to OPEN
   */
  private checkClosedToOpen(now: number): void {
    const stats = this.calculateErrorRate();

    // Not enough requests to make decision
    if (stats.totalRequests < this.config.minimumRequests) {
      this.errorThresholdExceededSince = null;
      return;
    }

    // Error rate above threshold
    if (stats.errorRate > this.config.errorThreshold) {
      if (this.errorThresholdExceededSince === null) {
        // Start tracking
        this.errorThresholdExceededSince = now;
        logger.warn(
          `Circuit breaker ${this.name}: error threshold exceeded`,
          { errorRate: stats.errorRate, threshold: this.config.errorThreshold }
        );
      } else {
        // Check if exceeded for long enough
        const duration = now - this.errorThresholdExceededSince;
        if (duration >= this.config.errorDuration) {
          this.transitionTo(CircuitState.OPEN);
        }
      }
    } else {
      // Error rate back to normal
      this.errorThresholdExceededSince = null;
    }
  }

  /**
   * Check transition from OPEN to HALF_OPEN
   */
  private checkOpenToHalfOpen(now: number): void {
    const timeSinceOpen = now - this.stateChangedAt;
    if (timeSinceOpen >= this.config.openTimeout) {
      this.transitionTo(CircuitState.HALF_OPEN);
    }
  }

  /**
   * Check transition from HALF_OPEN to CLOSED
   */
  private checkHalfOpenTransition(): void {
    if (this.halfOpenSuccessCount >= this.config.halfOpenSuccessThreshold) {
      this.transitionTo(CircuitState.CLOSED);
    }
  }

  /**
   * Calculate current error rate
   */
  private calculateErrorRate(): {
    errorRate: number;
    totalRequests: number;
    successCount: number;
    failureCount: number;
  } {
    this.cleanupOldRequests();

    const successCount = this.requests.filter((r) => r.success).length;
    const failureCount = this.requests.filter((r) => !r.success).length;
    const totalRequests = this.requests.length;
    const errorRate = totalRequests > 0 ? failureCount / totalRequests : 0;

    return {
      errorRate,
      totalRequests,
      successCount,
      failureCount,
    };
  }

  /**
   * Transition to new state
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    if (oldState === newState) {
      return;
    }

    this.state = newState;
    this.stateChangedAt = Date.now();

    // Reset counters based on new state
    if (newState === CircuitState.HALF_OPEN) {
      this.halfOpenRequestCount = 0;
      this.halfOpenSuccessCount = 0;
    } else if (newState === CircuitState.CLOSED) {
      this.errorThresholdExceededSince = null;
    }

    logger.info(`Circuit breaker ${this.name}: ${oldState} -> ${newState}`, {
      timeSinceLastTransition: Date.now() - this.stateChangedAt,
      stats: this.getStats(),
    });

    // Emit state transition metric
    recordMetric('circuit_breaker.state_transition', 1, {
      name: this.name,
      from: oldState,
      to: newState,
    });

    this.emitMetrics();
  }

  /**
   * Emit metrics for monitoring
   */
  private emitMetrics(): void {
    const stats = this.getStats();

    recordMetric('circuit_breaker.state', 1, {
      name: this.name,
      state: this.state,
    });

    recordMetric('circuit_breaker.error_rate', stats.errorRate, {
      name: this.name,
    });

    recordMetric('circuit_breaker.total_requests', stats.totalRequests, {
      name: this.name,
    });

    recordMetric('circuit_breaker.success_count', stats.successCount, {
      name: this.name,
    });

    recordMetric('circuit_breaker.failure_count', stats.failureCount, {
      name: this.name,
    });
  }
}

/**
 * Default configuration for push notification services
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  errorThreshold: 0.05, // 5% error rate
  windowSize: 60 * 60 * 1000, // 1 hour
  minimumRequests: 10, // Need at least 10 requests to calculate rate
  openTimeout: 10 * 60 * 1000, // 10 minutes
  halfOpenSuccessThreshold: 10, // 10 successful requests
  halfOpenMaxRequests: 10, // Allow 10 test requests
  errorDuration: 2 * 60 * 1000, // 2 minutes above threshold
};

/**
 * Circuit breaker instances for different push providers
 */
export const apnsCircuitBreaker = new CircuitBreakerService(
  'apns',
  DEFAULT_CIRCUIT_BREAKER_CONFIG
);

export const fcmCircuitBreaker = new CircuitBreakerService(
  'fcm',
  DEFAULT_CIRCUIT_BREAKER_CONFIG
);
