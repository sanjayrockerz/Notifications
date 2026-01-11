/**
 * Circuit Breaker Pattern for Redis and External Services
 * 
 * FAIL-OPEN BEHAVIOR: When the circuit is open (Redis is failing),
 * we allow requests through rather than blocking them. This is the correct
 * choice for rate limiting because:
 * 
 * 1. Availability > strict rate limiting during Redis outages
 * 2. Better user experience - requests proceed without artificial delays
 * 3. Redis failures are typically transient (< 30 seconds)
 * 4. Other defenses (API gateway, load balancer) can handle load
 * 
 * States:
 * - CLOSED: Normal operation, Redis is working
 * - OPEN: Redis is failing, bypass rate limiting (fail-open)
 * - HALF_OPEN: Testing if Redis has recovered
 */

import { logger } from './logger';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Time in ms to wait before attempting to close the circuit */
  recoveryTimeout: number;
  /** Number of successful requests needed to close circuit from half-open */
  successThreshold: number;
  /** Optional name for logging */
  name: string;
  /** Whether to fail open (allow requests) or fail closed (reject requests) when circuit is open */
  failOpen: boolean;
  /** Callback when circuit state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
  totalFailures: number;
  totalSuccesses: number;
  circuitOpenCount: number;
}

const defaultConfig: Partial<CircuitBreakerConfig> = {
  failureThreshold: 5,
  recoveryTimeout: 30000, // 30 seconds
  successThreshold: 2,
  failOpen: true, // Default to fail-open for rate limiting
};

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private lastFailure: Date | null = null;
  private lastSuccess: Date | null = null;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private circuitOpenCount = 0;
  private nextAttempt: Date | null = null;
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> & { name: string }) {
    this.config = { ...defaultConfig, ...config } as CircuitBreakerConfig;
  }

  /**
   * Execute a function with circuit breaker protection
   * @param fn - The function to execute (e.g., Redis operation)
   * @param fallback - Optional fallback function when circuit is open
   * @returns Result of fn or fallback
   */
  async execute<T>(
    fn: () => Promise<T>,
    fallback?: () => T | Promise<T>
  ): Promise<{ result: T; circuitOpen: boolean }> {
    // Check if circuit should be tested
    if (this.state === CircuitState.OPEN) {
      if (this.shouldAttemptRecovery()) {
        this.transitionTo(CircuitState.HALF_OPEN);
      } else {
        // Circuit is open, use fallback
        logger.debug(`Circuit ${this.config.name} is OPEN, using fallback`, {
          nextAttempt: this.nextAttempt,
        });
        
        if (this.config.failOpen && fallback) {
          return { result: await fallback(), circuitOpen: true };
        }
        throw new Error(`Circuit ${this.config.name} is OPEN`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return { result, circuitOpen: false };
    } catch (error) {
      this.onFailure(error);
      
      // If circuit just opened and we have a fallback, use it
      if (this.state === CircuitState.OPEN && fallback) {
        return { result: await fallback(), circuitOpen: true };
      }
      
      throw error;
    }
  }

  /**
   * Check if operation is allowed (useful for quick checks without executing)
   */
  isAllowed(): boolean {
    if (this.state === CircuitState.CLOSED) return true;
    if (this.state === CircuitState.HALF_OPEN) return true;
    return this.shouldAttemptRecovery();
  }

  /**
   * Get current circuit stats
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      circuitOpenCount: this.circuitOpenCount,
    };
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Force close the circuit (for testing or manual recovery)
   */
  forceClose(): void {
    this.transitionTo(CircuitState.CLOSED);
    this.failures = 0;
    this.successes = 0;
    logger.info(`Circuit ${this.config.name} force closed`);
  }

  /**
   * Force open the circuit (for testing or manual intervention)
   */
  forceOpen(): void {
    this.transitionTo(CircuitState.OPEN);
    this.nextAttempt = new Date(Date.now() + this.config.recoveryTimeout);
    logger.info(`Circuit ${this.config.name} force opened`);
  }

  private onSuccess(): void {
    this.lastSuccess = new Date();
    this.totalSuccesses++;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.config.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
        this.failures = 0;
        this.successes = 0;
      }
    } else {
      // Reset failure count on success in closed state
      this.failures = 0;
    }
  }

  private onFailure(error: unknown): void {
    this.lastFailure = new Date();
    this.totalFailures++;
    this.failures++;

    logger.warn(`Circuit ${this.config.name} failure #${this.failures}`, {
      error: error instanceof Error ? error.message : String(error),
      threshold: this.config.failureThreshold,
    });

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open state opens the circuit again
      this.transitionTo(CircuitState.OPEN);
      this.nextAttempt = new Date(Date.now() + this.config.recoveryTimeout);
      this.circuitOpenCount++;
    } else if (this.failures >= this.config.failureThreshold) {
      this.transitionTo(CircuitState.OPEN);
      this.nextAttempt = new Date(Date.now() + this.config.recoveryTimeout);
      this.circuitOpenCount++;
    }
  }

  private shouldAttemptRecovery(): boolean {
    if (!this.nextAttempt) return false;
    return Date.now() >= this.nextAttempt.getTime();
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      
      logger.info(`Circuit ${this.config.name} state change: ${oldState} -> ${newState}`, {
        failures: this.failures,
        totalFailures: this.totalFailures,
        circuitOpenCount: this.circuitOpenCount,
      });

      if (this.config.onStateChange) {
        this.config.onStateChange(oldState, newState);
      }
    }
  }
}

// Singleton circuit breakers for common services
const circuitBreakers = new Map<string, CircuitBreaker>();

/**
 * Get or create a circuit breaker for a named service
 */
export function getCircuitBreaker(
  name: string,
  config?: Partial<CircuitBreakerConfig>
): CircuitBreaker {
  if (!circuitBreakers.has(name)) {
    circuitBreakers.set(
      name,
      new CircuitBreaker({ name, ...config })
    );
  }
  return circuitBreakers.get(name)!;
}

/**
 * Pre-configured circuit breaker for Redis operations
 * Fail-open behavior: when Redis fails, we allow requests through
 */
export const redisCircuitBreaker = new CircuitBreaker({
  name: 'redis',
  failureThreshold: 5,
  recoveryTimeout: 30000, // 30 seconds
  successThreshold: 2,
  failOpen: true,
  onStateChange: (from, to) => {
    if (to === CircuitState.OPEN) {
      logger.warn('🔴 Redis circuit breaker OPENED - rate limiting bypassed (fail-open mode)');
    } else if (to === CircuitState.CLOSED) {
      logger.info('🟢 Redis circuit breaker CLOSED - rate limiting active');
    } else if (to === CircuitState.HALF_OPEN) {
      logger.info('🟡 Redis circuit breaker HALF-OPEN - testing recovery');
    }
  },
});

/**
 * Pre-configured circuit breaker for cache operations (less critical)
 */
export const cacheCircuitBreaker = new CircuitBreaker({
  name: 'cache',
  failureThreshold: 3,
  recoveryTimeout: 10000, // 10 seconds
  successThreshold: 1,
  failOpen: true,
});
