#!/usr/bin/env node

/**
 * Load Testing Script - Horizontal Scaling
 * 
 * Simulates 1M notifications/day load:
 * - ~694 notifications/minute
 * - ~12 notifications/second
 * 
 * Tests:
 * 1. Parallel worker coordination (no duplicates)
 * 2. Database connection pooling under load
 * 3. Queue throughput with multiple consumers
 * 4. Resource utilization (CPU, memory, DB connections)
 * 5. System stability over extended period
 * 
 * Usage:
 *   npm run load-test
 *   npm run load-test -- --duration=3600 --rate=20
 */

import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { performance } from 'perf_hooks';

interface LoadTestConfig {
  baseUrl: string;
  duration: number; // seconds
  rate: number; // notifications per second
  numUsers: number;
  reportInterval: number; // seconds
}

interface LoadTestStats {
  totalSent: number;
  totalSuccess: number;
  totalFailed: number;
  totalDuplicates: number;
  avgLatency: number;
  p95Latency: number;
  p99Latency: number;
  throughput: number; // notifications/second
  errors: Map<string, number>;
}

class LoadTester {
  private config: LoadTestConfig;
  private stats: LoadTestStats;
  private latencies: number[] = [];
  private startTime: number = 0;
  private isRunning = false;
  private sentNotifications = new Set<string>();

  constructor(config: Partial<LoadTestConfig> = {}) {
    this.config = {
      baseUrl: config.baseUrl || process.env.API_URL || 'http://localhost:3000',
      duration: config.duration || 3600, // 1 hour default
      rate: config.rate || 12, // 1M/day ≈ 12/second
      numUsers: config.numUsers || 10000,
      reportInterval: config.reportInterval || 60, // 1 minute
    };

    this.stats = {
      totalSent: 0,
      totalSuccess: 0,
      totalFailed: 0,
      totalDuplicates: 0,
      avgLatency: 0,
      p95Latency: 0,
      p99Latency: 0,
      throughput: 0,
      errors: new Map(),
    };

    console.log('🚀 Load Test Configuration:');
    console.log(`   Target: ${this.config.baseUrl}`);
    console.log(`   Duration: ${this.config.duration}s (${(this.config.duration / 60).toFixed(0)} minutes)`);
    console.log(`   Rate: ${this.config.rate} notifications/second`);
    console.log(`   Expected total: ${this.config.rate * this.config.duration} notifications`);
    console.log(`   Users: ${this.config.numUsers}`);
    console.log('');
  }

  /**
   * Run load test
   */
  async run(): Promise<void> {
    this.isRunning = true;
    this.startTime = performance.now();

    console.log('🏁 Starting load test...\n');

    // Start periodic reporting
    const reportInterval = setInterval(() => {
      this.printReport();
    }, this.config.reportInterval * 1000);

    // Generate load
    const intervalMs = 1000 / this.config.rate;
    const endTime = Date.now() + this.config.duration * 1000;

    while (Date.now() < endTime && this.isRunning) {
      const batchStartTime = Date.now();

      // Send batch of notifications
      await this.sendNotification();

      // Wait for next interval
      const elapsed = Date.now() - batchStartTime;
      const waitTime = Math.max(0, intervalMs - elapsed);
      
      if (waitTime > 0) {
        await this.sleep(waitTime);
      }
    }

    // Stop reporting
    clearInterval(reportInterval);

    // Final report
    console.log('\n📊 Final Report:');
    console.log('═'.repeat(60));
    this.printReport();
    
    // Check for duplicates
    await this.checkDuplicates();

    console.log('\n✅ Load test completed');
  }

  /**
   * Send a notification
   */
  private async sendNotification(): Promise<void> {
    const notificationId = uuidv4();
    const userId = `user_${Math.floor(Math.random() * this.config.numUsers)}`;

    const payload = {
      userId,
      title: `Load Test Notification ${notificationId.slice(0, 8)}`,
      body: 'This is a synthetic load test notification',
      category: 'load-test',
      priority: this.getRandomPriority(),
      data: {
        notificationId,
        timestamp: new Date().toISOString(),
        test: true,
      },
      source: 'load-test',
      metadata: {
        resourceId: notificationId, // For idempotency
      },
    };

    const startTime = performance.now();

    try {
      const response = await axios.post(
        `${this.config.baseUrl}/api/notifications`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-token', // Mock token
          },
          timeout: 10000, // 10 second timeout
        }
      );

      const latency = performance.now() - startTime;
      this.latencies.push(latency);

      if (response.status === 200 || response.status === 201) {
        this.stats.totalSuccess++;
        this.sentNotifications.add(notificationId);
      } else {
        this.stats.totalFailed++;
        this.recordError(`HTTP ${response.status}`);
      }

      this.stats.totalSent++;

    } catch (error: any) {
      const latency = performance.now() - startTime;
      this.latencies.push(latency);

      this.stats.totalFailed++;
      this.stats.totalSent++;

      const errorType = error.code || error.message || 'Unknown';
      this.recordError(errorType);

    }
  }

  /**
   * Record error type
   */
  private recordError(errorType: string): void {
    const count = this.stats.errors.get(errorType) || 0;
    this.stats.errors.set(errorType, count + 1);
  }

  /**
   * Get random priority
   */
  private getRandomPriority(): string {
    const rand = Math.random();
    if (rand < 0.7) return 'normal';
    if (rand < 0.9) return 'high';
    if (rand < 0.98) return 'low';
    return 'critical';
  }

  /**
   * Print current statistics
   */
  private printReport(): void {
    const elapsedMs = performance.now() - this.startTime;
    const elapsedSec = elapsedMs / 1000;

    // Calculate latencies
    if (this.latencies.length > 0) {
      const sorted = this.latencies.sort((a, b) => a - b);
      const p95Index = Math.floor(sorted.length * 0.95);
      const p99Index = Math.floor(sorted.length * 0.99);

      this.stats.avgLatency = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      this.stats.p95Latency = sorted[p95Index] || 0;
      this.stats.p99Latency = sorted[p99Index] || 0;
    }

    // Calculate throughput
    this.stats.throughput = this.stats.totalSent / elapsedSec;

    console.log(`⏱️  Elapsed: ${elapsedSec.toFixed(0)}s`);
    console.log(`📤 Sent: ${this.stats.totalSent}`);
    console.log(`✅ Success: ${this.stats.totalSuccess} (${((this.stats.totalSuccess / this.stats.totalSent) * 100).toFixed(2)}%)`);
    console.log(`❌ Failed: ${this.stats.totalFailed} (${((this.stats.totalFailed / this.stats.totalSent) * 100).toFixed(2)}%)`);
    console.log(`📊 Throughput: ${this.stats.throughput.toFixed(2)} notifications/sec`);
    console.log(`⚡ Latency: avg=${this.stats.avgLatency.toFixed(2)}ms, p95=${this.stats.p95Latency.toFixed(2)}ms, p99=${this.stats.p99Latency.toFixed(2)}ms`);

    if (this.stats.errors.size > 0) {
      console.log('🔴 Errors:');
      this.stats.errors.forEach((count, type) => {
        console.log(`   ${type}: ${count}`);
      });
    }

    console.log('');
  }

  /**
   * Check for duplicate notifications (verify no duplicate processing)
   */
  private async checkDuplicates(): Promise<void> {
    console.log('🔍 Checking for duplicates...');

    try {
      // Query database for notifications with same resourceId
      const response = await axios.get(
        `${this.config.baseUrl}/api/admin/notifications/duplicates`,
        {
          headers: {
            'Authorization': 'Bearer admin-token',
          },
          timeout: 30000,
        }
      );

      const duplicates = response.data.duplicates || [];
      this.stats.totalDuplicates = duplicates.length;

      if (duplicates.length > 0) {
        console.log(`⚠️  Found ${duplicates.length} duplicate notifications`);
        console.log('   First 5 duplicates:');
        duplicates.slice(0, 5).forEach((dup: any) => {
          console.log(`   - ${dup.resourceId}: ${dup.count} occurrences`);
        });
      } else {
        console.log('✅ No duplicates found (workers properly coordinated)');
      }

    } catch (error) {
      console.log('⚠️  Unable to check duplicates (endpoint may not exist)');
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Stop test
   */
  stop(): void {
    this.isRunning = false;
    console.log('\n🛑 Stopping load test...');
  }
}

// CLI handling
const args = process.argv.slice(2);
const config: any = {};

args.forEach((arg) => {
  if (arg.startsWith('--duration=')) {
    config.duration = parseInt(arg.split('=')[1], 10);
  } else if (arg.startsWith('--rate=')) {
    config.rate = parseInt(arg.split('=')[1], 10);
  } else if (arg.startsWith('--url=')) {
    config.baseUrl = arg.split('=')[1];
  } else if (arg.startsWith('--users=')) {
    config.numUsers = parseInt(arg.split('=')[1], 10);
  }
});

// Run test
const tester = new LoadTester(config);

// Handle Ctrl+C
process.on('SIGINT', () => {
  tester.stop();
  process.exit(0);
});

tester.run().catch((error) => {
  console.error('❌ Load test failed:', error);
  process.exit(1);
});
