import os from 'os';
import { logger } from '../utils/logger';
import mongoose from 'mongoose';
import { RedisCache } from '../config/redis';
import { register, Gauge, Counter } from 'prom-client';

/**
 * ResourceMonitoringService
 * 
 * Monitors system resources for horizontal scaling:
 * - CPU usage per worker
 * - Memory usage (heap + RSS)
 * - Database connections (active + idle)
 * - Queue depth (pending messages)
 * - Worker health (uptime + throughput)
 * 
 * Exposes Prometheus metrics for Grafana dashboards
 */

export class ResourceMonitoringService {
  private isRunning = false;
  private monitoringInterval?: NodeJS.Timeout;
  private monitorIntervalMs = 15000; // 15 seconds

  // Prometheus metrics
  private cpuUsageGauge: Gauge<string>;
  private memoryUsageGauge: Gauge<string>;
  private heapUsageGauge: Gauge<string>;
  private dbConnectionsGauge: Gauge<string>;
  private queueDepthGauge: Gauge<string>;
  private workerUptimeGauge: Gauge<string>;
  private errorCounter: Counter<string>;

  constructor() {
    // CPU Usage (percentage)
    this.cpuUsageGauge = new Gauge({
      name: 'worker_cpu_usage_percent',
      help: 'CPU usage percentage per worker',
      labelNames: ['worker_id', 'hostname'],
    });

    // Memory Usage (bytes)
    this.memoryUsageGauge = new Gauge({
      name: 'worker_memory_usage_bytes',
      help: 'Memory usage (RSS) in bytes',
      labelNames: ['worker_id', 'hostname', 'type'],
    });

    // Heap Usage (bytes)
    this.heapUsageGauge = new Gauge({
      name: 'worker_heap_usage_bytes',
      help: 'Heap memory usage in bytes',
      labelNames: ['worker_id', 'hostname', 'type'],
    });

    // Database Connections
    this.dbConnectionsGauge = new Gauge({
      name: 'database_connections_total',
      help: 'Number of database connections',
      labelNames: ['state'],
    });

    // Queue Depth
    this.queueDepthGauge = new Gauge({
      name: 'notification_queue_depth',
      help: 'Number of pending notifications in queue',
      labelNames: ['status'],
    });

    // Worker Uptime (seconds)
    this.workerUptimeGauge = new Gauge({
      name: 'worker_uptime_seconds',
      help: 'Worker uptime in seconds',
      labelNames: ['worker_id'],
    });

    // Errors
    this.errorCounter = new Counter({
      name: 'monitoring_errors_total',
      help: 'Total monitoring errors',
      labelNames: ['type'],
    });
  }

  /**
   * Start monitoring
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('⚠️ Resource monitoring already running');
      return;
    }

    this.isRunning = true;
    logger.info('📊 Resource monitoring started');

    // Collect metrics immediately
    await this.collectMetrics();

    // Start periodic collection
    this.monitoringInterval = setInterval(async () => {
      await this.collectMetrics();
    }, this.monitorIntervalMs);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined as any;
    }

    logger.info('✅ Resource monitoring stopped');
  }

  /**
   * Collect all metrics
   */
  private async collectMetrics(): Promise<void> {
    try {
      await Promise.all([
        this.collectCPUMetrics(),
        this.collectMemoryMetrics(),
        this.collectDatabaseMetrics(),
        this.collectQueueMetrics(),
      ]);
    } catch (error) {
      logger.error('❌ Error collecting metrics:', error);
      this.errorCounter.inc({ type: 'collection' });
    }
  }

  /**
   * Collect CPU metrics
   */
  private async collectCPUMetrics(): Promise<void> {
    try {
      const cpus = os.cpus();
      const workerId = process.env.WORKER_ID || 'unknown';
      const hostname = os.hostname();

      // Calculate average CPU usage
      let totalIdle = 0;
      let totalTick = 0;

      cpus.forEach((cpu) => {
        for (const type in cpu.times) {
          totalTick += cpu.times[type as keyof typeof cpu.times];
        }
        totalIdle += cpu.times.idle;
      });

      const idle = totalIdle / cpus.length;
      const total = totalTick / cpus.length;
      const cpuUsagePercent = 100 - Math.floor((idle / total) * 100);

      this.cpuUsageGauge.set(
        { worker_id: workerId, hostname },
        cpuUsagePercent
      );

    } catch (error) {
      logger.error('❌ Error collecting CPU metrics:', error);
      this.errorCounter.inc({ type: 'cpu' });
    }
  }

  /**
   * Collect memory metrics
   */
  private async collectMemoryMetrics(): Promise<void> {
    try {
      const workerId = process.env.WORKER_ID || 'unknown';
      const hostname = os.hostname();

      // Process memory usage
      const memUsage = process.memoryUsage();

      this.memoryUsageGauge.set(
        { worker_id: workerId, hostname, type: 'rss' },
        memUsage.rss
      );

      this.memoryUsageGauge.set(
        { worker_id: workerId, hostname, type: 'external' },
        memUsage.external
      );

      this.heapUsageGauge.set(
        { worker_id: workerId, hostname, type: 'used' },
        memUsage.heapUsed
      );

      this.heapUsageGauge.set(
        { worker_id: workerId, hostname, type: 'total' },
        memUsage.heapTotal
      );

      // System memory
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memUsagePercent = (usedMem / totalMem) * 100;

      logger.debug('💾 Memory usage:', {
        heap: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        rss: `${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`,
        system: `${memUsagePercent.toFixed(2)}%`,
      });

    } catch (error) {
      logger.error('❌ Error collecting memory metrics:', error);
      this.errorCounter.inc({ type: 'memory' });
    }
  }

  /**
   * Collect database metrics
   */
  private async collectDatabaseMetrics(): Promise<void> {
    try {
      // MongoDB connection state
      const readyState = mongoose.connection.readyState;
      
      // States: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
      this.dbConnectionsGauge.set({ state: 'connected' }, readyState === 1 ? 1 : 0);
      this.dbConnectionsGauge.set({ state: 'connecting' }, readyState === 2 ? 1 : 0);
      this.dbConnectionsGauge.set({ state: 'disconnected' }, readyState === 0 ? 1 : 0);

      logger.debug('🗄️ Database state:', {
        readyState,
        connected: readyState === 1,
      });

    } catch (error) {
      logger.error('❌ Error collecting database metrics:', error);
      this.errorCounter.inc({ type: 'database' });
    }
  }

  /**
   * Collect queue metrics
   */
  private async collectQueueMetrics(): Promise<void> {
    try {
      // Import here to avoid circular dependency
      const Notification = (await import('../models/Notification')).default;

      // Count pending notifications
      const pendingCount = await Notification.countDocuments({ status: 'pending' });
      const scheduledCount = await Notification.countDocuments({ status: 'scheduled' });
      const lockedCount = await Notification.countDocuments({ 
        lockedBy: { $exists: true, $ne: null },
        lockExpiry: { $gt: new Date() }
      });

      this.queueDepthGauge.set({ status: 'pending' }, pendingCount);
      this.queueDepthGauge.set({ status: 'scheduled' }, scheduledCount);
      this.queueDepthGauge.set({ status: 'locked' }, lockedCount);

      logger.debug('📬 Queue depth:', {
        pending: pendingCount,
        scheduled: scheduledCount,
        locked: lockedCount,
      });

    } catch (error) {
      logger.error('❌ Error collecting queue metrics:', error);
      this.errorCounter.inc({ type: 'queue' });
    }
  }

  /**
   * Get current resource snapshot
   */
  async getSnapshot(): Promise<{
    cpu: {
      usage: number;
      cores: number;
    };
    memory: {
      heapUsed: number;
      heapTotal: number;
      rss: number;
      external: number;
      systemTotal: number;
      systemFree: number;
    };
    database: {
      connected: boolean;
      readyState: number;
    };
    queue: {
      pending: number;
      scheduled: number;
      locked: number;
    };
    system: {
      hostname: string;
      platform: string;
      uptime: number;
    };
  }> {
    const cpus = os.cpus();
    const memUsage = process.memoryUsage();
    const Notification = (await import('../models/Notification')).default;

    const [pendingCount, scheduledCount, lockedCount] = await Promise.all([
      Notification.countDocuments({ status: 'pending' }),
      Notification.countDocuments({ status: 'scheduled' }),
      Notification.countDocuments({ 
        lockedBy: { $exists: true, $ne: null },
        lockExpiry: { $gt: new Date() }
      }),
    ]);

    return {
      cpu: {
        usage: 0, // Calculated over time
        cores: cpus.length,
      },
      memory: {
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        rss: memUsage.rss,
        external: memUsage.external,
        systemTotal: os.totalmem(),
        systemFree: os.freemem(),
      },
      database: {
        connected: mongoose.connection.readyState === 1,
        readyState: mongoose.connection.readyState,
      },
      queue: {
        pending: pendingCount,
        scheduled: scheduledCount,
        locked: lockedCount,
      },
      system: {
        hostname: os.hostname(),
        platform: os.platform(),
        uptime: os.uptime(),
      },
    };
  }

  /**
   * Get Prometheus metrics
   */
  async getMetrics(): Promise<string> {
    return await register.metrics();
  }
}

// Export singleton instance
export const resourceMonitor = new ResourceMonitoringService();
