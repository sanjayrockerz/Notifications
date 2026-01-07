# 🚀 Deployment Guide - Horizontal Scaling

Quick start guide for deploying the notification service with multiple worker instances.

## Prerequisites

- Docker 20.10+
- Docker Compose 2.0+
- Node.js 20+ (for load testing)
- 8GB RAM minimum
- 4 CPU cores minimum

## Quick Start

### 1. Clone and Setup

```bash
cd Notifications/
npm install
npm run build
```

### 2. Start All Services

```bash
docker-compose -f docker-compose.scale.yml up -d
```

This starts:
- 2 API instances (ports 3001, 3002)
- 5 worker instances (ports 9091-9095)
- Nginx load balancer (port 80)
- MongoDB (port 27017)
- Redis (port 6379)
- RabbitMQ (port 5672, management UI on 15672)
- Prometheus (port 9090)
- Grafana (port 3000)

### 3. Verify Deployment

```bash
# Check all services are running
docker-compose -f docker-compose.scale.yml ps

# Should show:
# api-1        running
# api-2        running
# worker-1     running
# worker-2     running
# worker-3     running
# worker-4     running
# worker-5     running
# nginx        running
# mongodb      running
# redis        running
# rabbitmq     running
# prometheus   running
# grafana      running
```

### 4. Health Checks

```bash
# Check load balancer
curl http://localhost/health

# Check individual workers
for i in {1..5}; do
  echo "Worker-$i:"
  curl http://localhost:909$i/health
  echo ""
done
```

### 5. Access Monitoring

- **Grafana**: http://localhost:3000 (admin/admin)
- **Prometheus**: http://localhost:9090
- **RabbitMQ Management**: http://localhost:15672 (guest/guest)

## Load Testing

### Run 1M/day Load Test

```bash
# Terminal 1: Watch worker logs
docker-compose -f docker-compose.scale.yml logs -f worker-1

# Terminal 2: Run load test (1 hour)
npm run load-test -- --duration=3600 --rate=12

# Terminal 3: Monitor resources
watch -n 5 'curl -s http://localhost:9091/resources | jq'
```

### Expected Results

```
📊 Load Test Results
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Duration:            3600 seconds
Target Rate:         12 notifications/sec
Actual Throughput:   11.87 notifications/sec

Total Sent:          42,732
Total Success:       42,680 (99.88%)
Total Failed:        52 (0.12%)
Total Duplicates:    0 (0.00%) ✅

Latency:
  Average:           145 ms
  P95:               280 ms
  P99:               420 ms
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Scaling

### Scale Workers

```bash
# Scale to 10 workers
docker-compose -f docker-compose.scale.yml up -d --scale worker=10

# Scale down to 3 workers
docker-compose -f docker-compose.scale.yml up -d --scale worker=3

# Check new worker count
docker-compose ps | grep worker
```

### Scale API Instances

Edit `docker-compose.scale.yml`:

```yaml
services:
  api-3:
    build: .
    environment:
      - NUM_API_INSTANCES=3
    ports:
      - "3003:3000"
```

Update `nginx.conf`:

```nginx
upstream notification_api {
  server api-1:3000;
  server api-2:3000;
  server api-3:3000;
}
```

Restart:

```bash
docker-compose -f docker-compose.scale.yml up -d
```

## Monitoring

### Import Grafana Dashboard

1. Open http://localhost:3000
2. Login (admin/admin)
3. Go to Dashboards → Import
4. Upload `grafana-dashboard.json`
5. Select Prometheus data source
6. Click Import

### Key Metrics to Watch

- **Worker CPU**: Should be < 70%
- **Worker Memory**: Should be < 512MB
- **Queue Depth**: Should be < 10,000
- **Database Connections**: Should be < 50
- **Success Rate**: Should be > 99%
- **Duplicate Rate**: Should be 0%

## Troubleshooting

### Workers Not Starting

```bash
# Check logs
docker-compose -f docker-compose.scale.yml logs worker-1

# Common issues:
# - Database not ready: Wait 30 seconds, try again
# - Port conflict: Check if ports 9091-9095 are available
# - Memory limit: Increase Docker memory to 8GB
```

### High CPU Usage

```bash
# Check worker statistics
curl http://localhost:9091/stats

# If CPU > 70%:
# Option 1: Reduce WORKER_BATCH_SIZE
docker-compose -f docker-compose.scale.yml exec worker-1 \
  env WORKER_BATCH_SIZE=25 npm run worker

# Option 2: Add more workers
docker-compose -f docker-compose.scale.yml up -d --scale worker=8
```

### Queue Backlog

```bash
# Check queue depth
curl http://localhost:9091/resources | jq '.queue'

# If pending > 10,000:
# Scale workers
docker-compose -f docker-compose.scale.yml up -d --scale worker=10

# OR increase batch size (process more per poll)
# Edit docker-compose.scale.yml:
environment:
  - WORKER_BATCH_SIZE=100
```

### Database Connection Exhaustion

```bash
# Check pool statistics
curl http://localhost:9091/stats | jq '.database'

# If activeConnections >= poolSize:
# Option 1: Increase pool size
# Edit src/config/connectionPool.ts:
private maxPoolSize = 100;

# Option 2: Reduce worker count
docker-compose -f docker-compose.scale.yml up -d --scale worker=3

# Rebuild and restart
npm run build
docker-compose -f docker-compose.scale.yml restart
```

## Shutdown

### Graceful Shutdown

```bash
# Stop all services (workers release locks)
docker-compose -f docker-compose.scale.yml down

# Stop specific worker
docker-compose -f docker-compose.scale.yml stop worker-1
```

### Force Shutdown

```bash
# Kill all services immediately
docker-compose -f docker-compose.scale.yml down --volumes

# Remove all data
docker-compose -f docker-compose.scale.yml down --volumes --remove-orphans
```

## Production Checklist

- [ ] Configure environment variables (.env file)
- [ ] Set up SSL certificates for Nginx
- [ ] Configure firewall rules (only expose port 80/443)
- [ ] Set up log rotation (Docker logging driver)
- [ ] Configure backup strategy (MongoDB, Redis)
- [ ] Set up alerts (Prometheus Alertmanager)
- [ ] Test disaster recovery (worker crashes)
- [ ] Load test with expected traffic (3x peak)
- [ ] Document runbook for on-call engineers
- [ ] Set up CI/CD pipeline (GitHub Actions)

## Next Steps

1. **Phase 6.1**: Message Prioritization
   - High/medium/low priority queues
   - Priority-based worker assignment

2. **Phase 6.2**: Dead Letter Queue
   - Failed notification handling
   - Retry policy configuration

3. **Phase 6.3**: Dynamic Auto-scaling
   - Scale based on queue depth
   - Scale down during low traffic

4. **Phase 6.4**: Multi-Region Deployment
   - Regional workers (US, EU, APAC)
   - Geo-based routing

## Support

- Documentation: `docs/14-horizontal-scaling-workers.md`
- Troubleshooting: See "Troubleshooting" section above
- Monitoring: http://localhost:3000 (Grafana)

**Deployment complete!** 🎉
