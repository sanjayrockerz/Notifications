/**
 * Load Testing Script
 * 
 * Generates synthetic 1M/day notification load to test horizontal scaling:
 * - 1M notifications per day = ~11.57 notif/sec
 * - Peak load: 50 notif/sec (4.3M/day)
 * - Simulates realistic notification patterns
 * - Tests delivery worker throughput
 * - Monitors system performance
 */

// import axios from 'axios'; // Replaced with native fetch
import { logger } from '../utils/logger';

interface LoadTestConfig {
  targetNotificationsPerDay: number;
  durationMinutes: number;
  peakMultiplier: number; // Peak load multiplier (default: 5x)
  apiUrl: string;
  userCount: number; // Number of unique users
  concurrency: number; // Parallel requests
}

interface LoadTestResults {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  averageLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  throughput: number; // Requests per second
  errorRate: number;
  durationMs: number;
}

export class LoadTestRunner {
  private config: LoadTestConfig;
  private results: {
    requests: number;
    successes: number;
    failures: number;
    latencies: number[];
    errors: Map<string, number>;
  };

  constructor(config?: Partial<LoadTestConfig>) {
    this.config = {
      targetNotificationsPerDay: config?.targetNotificationsPerDay || 1000000, // 1M/day
      durationMinutes: config?.durationMinutes || 10, // 10-minute test
      peakMultiplier: config?.peakMultiplier || 5,
      apiUrl: config?.apiUrl || process.env.API_URL || 'http://localhost:3000',
      userCount: config?.userCount || 10000,
      concurrency: config?.concurrency || 10,
    };

    this.results = {
      requests: 0,
      successes: 0,
      failures: 0,
      latencies: [],
      errors: new Map(),
    };

    logger.info('🔧 LoadTestRunner configured:', this.config);
  }

  /**
   * Generate random notification payload
   */
  private generateNotification(userId: number): any {
    const types = ['follow', 'like', 'comment', 'mention', 'message'];
    const type = types[Math.floor(Math.random() * types.length)];

    return {
      userId: `user_${userId}`,
      title: `Test notification ${type}`,
      body: `This is a load test notification for ${type}`,
      category: type,
      priority: Math.random() > 0.8 ? 'high' : 'normal',
      data: {
        testId: `load_test_${Date.now()}`,
        type,
        timestamp: new Date().toISOString(),
      },
      source: 'load-test',
    };
  }

  /**
   * Send a single notification request
   */
  private async sendNotification(userId: number): Promise<number> {
    const startTime = Date.now();

    try {
      const payload = this.generateNotification(userId);

      const response = await fetch(
        `${this.config.apiUrl}/api/notifications/send`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-token',
          },
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      this.results.successes++;
      const latency = Date.now() - startTime;
      this.results.latencies.push(latency);

      return latency;
    } catch (error: any) {
      this.results.failures++;
      
      const errorType = error.response?.status || error.code || 'unknown';
      const count = this.results.errors.get(String(errorType)) || 0;
      this.results.errors.set(String(errorType), count + 1);

      return Date.now() - startTime;
    } finally {
      this.results.requests++;
    }
  }

  /**
   * Calculate target rate for current time
   * Simulates peak hours with higher load
   */
  private calculateTargetRate(elapsedMinutes: number): number {
    const baseRate = this.config.targetNotificationsPerDay / 86400; // Per second

    // Simulate peak hours (30-70% of duration)
    const durationPercent = elapsedMinutes / this.config.durationMinutes;
    
    if (durationPercent >= 0.3 && durationPercent <= 0.7) {
      // Peak hours: 5x normal load
      return baseRate * this.config.peakMultiplier;
    }

    return baseRate;
  }

  /**
   * Run load test
   */
  async run(): Promise<LoadTestResults> {
    logger.info('🚀 Starting load test...');
    logger.info(`Target: ${this.config.targetNotificationsPerDay.toLocaleString()} notifications/day`);
    logger.info(`Base rate: ${(this.config.targetNotificationsPerDay / 86400).toFixed(2)} notif/sec`);
    logger.info(`Peak rate: ${((this.config.targetNotificationsPerDay / 86400) * this.config.peakMultiplier).toFixed(2)} notif/sec`);
    logger.info(`Duration: ${this.config.durationMinutes} minutes`);

    const startTime = Date.now();
    const endTime = startTime + this.config.durationMinutes * 60 * 1000;

    // Progress tracking
    let lastProgressLog = startTime;
    const progressInterval = 30000; // Log every 30 seconds

    while (Date.now() < endTime) {
      const elapsedMinutes = (Date.now() - startTime) / 60000;
      const targetRate = this.calculateTargetRate(elapsedMinutes);
      const batchSize = Math.ceil(targetRate * 5); // 5-second batches

      // Send batch of notifications concurrently
      const promises: Promise<number>[] = [];
      
      for (let i = 0; i < batchSize; i++) {
        // Random user
        const userId = Math.floor(Math.random() * this.config.userCount);
        
        // Limit concurrency
        if (promises.length >= this.config.concurrency) {
          await Promise.race(promises);
          promises.splice(promises.findIndex(p => p), 1);
        }

        promises.push(this.sendNotification(userId));
      }

      // Wait for all promises to complete
      await Promise.all(promises);

      // Log progress
      if (Date.now() - lastProgressLog >= progressInterval) {
        this.logProgress(startTime);
        lastProgressLog = Date.now();
      }

      // Wait for next batch (5 seconds)
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    logger.info('✅ Load test completed');

    return this.calculateResults(Date.now() - startTime);
  }

  /**
   * Log progress
   */
  private logProgress(startTime: number): void {
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    const throughput = this.results.requests / elapsedSeconds;
    const errorRate = this.results.failures / this.results.requests * 100;

    logger.info('📊 Load Test Progress:', {
      requests: this.results.requests,
      successes: this.results.successes,
      failures: this.results.failures,
      throughput: `${throughput.toFixed(2)} req/sec`,
      errorRate: `${errorRate.toFixed(2)}%`,
    });
  }

  /**
   * Calculate percentile
   */
  private calculatePercentile(percentile: number): number {
    if (this.results.latencies.length === 0) return 0;

    const sorted = [...this.results.latencies].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)] || 0;
  }

  /**
   * Calculate final results
   */
  private calculateResults(durationMs: number): LoadTestResults {
    const avgLatency = this.results.latencies.length > 0
      ? this.results.latencies.reduce((a, b) => a + b, 0) / this.results.latencies.length
      : 0;

    const throughput = this.results.requests / (durationMs / 1000);
    const errorRate = this.results.failures / this.results.requests * 100;

    const results: LoadTestResults = {
      totalRequests: this.results.requests,
      successCount: this.results.successes,
      failureCount: this.results.failures,
      averageLatency: Math.round(avgLatency),
      p50Latency: this.calculatePercentile(50),
      p95Latency: this.calculatePercentile(95),
      p99Latency: this.calculatePercentile(99),
      throughput: Math.round(throughput * 100) / 100,
      errorRate: Math.round(errorRate * 100) / 100,
      durationMs,
    };

    // Log results
    logger.info('📊 Load Test Results:', results);
    logger.info('🔍 Error Breakdown:', Object.fromEntries(this.results.errors));

    return results;
  }

  /**
   * Run continuous load test (for stress testing)
   */
  async runContinuous(): Promise<void> {
    logger.info('🔥 Starting continuous load test (press Ctrl+C to stop)');

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      logger.info('🛑 Stopping continuous load test...');
      const results = this.calculateResults(Date.now() - Date.now());
      logger.info('Final Results:', results);
      process.exit(0);
    });

    // Run forever
    while (true) {
      await this.run();
      logger.info('🔄 Restarting load test...');
    }
  }
}

/**
 * Run load test from command line
 */
async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'standard'; // 'standard' or 'continuous'

  const config: Partial<LoadTestConfig> = {
    targetNotificationsPerDay: parseInt(args[1] || '1000000'),
    durationMinutes: parseInt(args[2] || '10'),
    apiUrl: args[3] || 'http://localhost:3000',
  };

  const runner = new LoadTestRunner(config);

  if (mode === 'continuous') {
    await runner.runContinuous();
  } else {
    const results = await runner.run();
    
    // Exit with error code if error rate > 5%
    if (results.errorRate > 5) {
      logger.error(`❌ Load test failed: error rate ${results.errorRate}% exceeds threshold`);
      process.exit(1);
    }

    logger.info('✅ Load test passed');
    process.exit(0);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    logger.error('❌ Load test failed:', error);
    process.exit(1);
  });
}

export default LoadTestRunner;
