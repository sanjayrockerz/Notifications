import client from 'prom-client';

export const notificationsCreated = new client.Counter({
  name: 'notifications_created_total',
  help: 'Total notifications created',
  labelNames: ['type'],
});

export const notificationsDelivered = new client.Counter({
  name: 'notifications_delivered_total',
  help: 'Total notifications delivered',
  labelNames: ['platform'],
});

export const notificationsFailed = new client.Counter({
  name: 'notifications_failed_total',
  help: 'Total notifications failed',
  labelNames: ['reason'],
});

export const deviceTokensRegistered = new client.Gauge({
  name: 'device_tokens_registered',
  help: 'Current number of registered device tokens',
});

export const deviceTokensInvalidRate = new client.Gauge({
  name: 'device_tokens_invalid_rate',
  help: 'Percentage of invalid device tokens',
});

export const deliveryLatencyMs = new client.Histogram({
  name: 'delivery_latency_ms',
  help: 'Delivery latency in milliseconds',
  buckets: [50, 100, 250, 500, 1000, 2000, 5000, 10000],
});

export const deliveryRetryCount = new client.Histogram({
  name: 'delivery_retry_count',
  help: 'Number of delivery retries',
  buckets: [0, 1, 2, 3, 4, 5, 10],
});

export const queueLagSeconds = new client.Gauge({
  name: 'queue_lag_seconds',
  help: 'Age in seconds of the oldest pending delivery',
});

/**
 * Generic metric recording function
 * @param metricName - Name of the metric
 * @param value - Metric value
 * @param labels - Optional labels
 */
export function recordMetric(metricName: string, value: number, labels?: Record<string, string>): void {
  // This is a simplified implementation for circuit breaker metrics
  // In production, you would register these metrics properly with Prometheus
  // For now, this is a no-op or you can log the metrics
  // console.log(`Metric: ${metricName} = ${value}`, labels);
}

export function setupMetricsEndpoint(app: any) {
  app.get('/metrics', async (_req: any, res: any) => {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  });
}
