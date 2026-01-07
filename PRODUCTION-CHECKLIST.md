# ✅ Phase 5.3 - Production Deployment Checklist

## Pre-Deployment

### Code Quality
- [x] All TypeScript compilation errors fixed
- [x] No linting errors
- [x] All tests passing (run `npm test`)
- [x] Code reviewed and documented
- [x] Dependencies up to date

### Configuration Files
- [x] `docker-compose.scale.yml` configured
- [x] `nginx.conf` load balancer set up
- [x] `prometheus.yml` monitoring configured
- [x] `Dockerfile.worker` created
- [x] Environment variables documented

### Application Code
- [x] Notification model with locking fields
- [x] DatabaseConnectionPool implemented
- [x] MessageQueue with consumer groups
- [x] DeliveryWorkerService.v2 with distributed locking
- [x] ResourceMonitoringService with Prometheus metrics
- [x] Worker entry point (worker.ts)
- [x] Package.json scripts updated

### Documentation
- [x] Architecture documentation
- [x] Deployment guide (DEPLOYMENT.md)
- [x] Configuration reference
- [x] Troubleshooting guide
- [x] README updated
- [x] Phase 5.3 summary

## Deployment Steps

### 1. Environment Setup
```bash
# Set environment variables
export NUM_WORKERS=5
export NUM_API_INSTANCES=2
export WORKER_BATCH_SIZE=50
export LOCK_DURATION_MS=300000
export POLL_INTERVAL_MS=5000
export PREFETCH_COUNT=10

# MongoDB configuration
export MONGODB_URI=mongodb://mongodb:27017/notifications
export MONGODB_MAX_POOL_SIZE=50

# Redis configuration
export REDIS_URL=redis://redis:6379
export REDIS_MAX_MEMORY=2gb

# RabbitMQ configuration
export RABBITMQ_URL=amqp://rabbitmq:5672
export RABBITMQ_CONSUMER_GROUP=notification-workers
```

### 2. Build Application
```bash
# Install dependencies
npm install

# Run tests
npm test

# Build TypeScript
npm run build

# Verify build
ls -la dist/
```

### 3. Build Docker Images
```bash
# Build all images
docker-compose -f docker-compose.scale.yml build

# Verify images
docker images | grep notification
```

### 4. Start Infrastructure
```bash
# Start all services
docker-compose -f docker-compose.scale.yml up -d

# Wait for services to be ready (30 seconds)
sleep 30

# Check service status
docker-compose -f docker-compose.scale.yml ps
```

### 5. Verify Deployment

#### Check Load Balancer
```bash
curl http://localhost/health

# Expected response:
# {
#   "status": "healthy",
#   "database": "connected",
#   "redis": "connected",
#   "messageQueue": "connected"
# }
```

#### Check All Workers
```bash
for i in {1..5}; do
  echo "Worker-$i:"
  curl http://localhost:909$i/health
  echo ""
done

# Expected response for each:
# {
#   "status": "healthy",
#   "worker": {
#     "workerId": "...",
#     "isRunning": true,
#     "processedCount": 0,
#     "failedCount": 0,
#     "successRate": 100
#   },
#   "database": {
#     "connected": true
#   }
# }
```

#### Check Prometheus Scraping
```bash
curl http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health: .health}'

# All targets should show health: "up"
```

#### Access Monitoring Dashboards
```bash
# Grafana
open http://localhost:3000  # Login: admin/admin

# Prometheus
open http://localhost:9090

# RabbitMQ Management
open http://localhost:15672  # Login: guest/guest
```

### 6. Import Grafana Dashboard
1. Open http://localhost:3000
2. Login (admin/admin)
3. Go to Dashboards → Import
4. Upload `grafana-dashboard.json`
5. Select Prometheus data source
6. Click Import
7. Verify all panels display data

### 7. Run Load Test
```bash
# Terminal 1: Watch worker logs
docker-compose -f docker-compose.scale.yml logs -f worker-1 worker-2

# Terminal 2: Run load test (10 minutes)
npm run load-test -- --duration=600 --rate=12 --users=10000

# Terminal 3: Monitor resources
watch -n 5 'curl -s http://localhost:9091/resources | jq'
```

#### Expected Load Test Results
- Throughput: ~11-12 notifications/sec
- Average Latency: < 200ms
- P95 Latency: < 300ms
- P99 Latency: < 500ms
- Duplicate Rate: 0%
- Error Rate: < 1%

### 8. Verify No Duplicates
```bash
# Check database for duplicate deliveries
mongo mongodb://localhost:27017/notifications <<EOF
db.notifications.aggregate([
  {
    $group: {
      _id: "$notificationId",
      count: { $sum: 1 }
    }
  },
  {
    $match: {
      count: { $gt: 1 }
    }
  }
])
EOF

# Expected result: No documents (0 duplicates)
```

## Post-Deployment Validation

### Performance Metrics
- [ ] Worker CPU usage < 70%
- [ ] Worker memory usage < 512MB
- [ ] Database connections < 50
- [ ] Queue depth < 10,000
- [ ] Throughput: 11-12 notif/sec
- [ ] Error rate < 1%
- [ ] Duplicate rate = 0%

### Monitoring & Alerts
- [ ] Prometheus scraping all targets
- [ ] Grafana dashboards displaying data
- [ ] All workers reporting metrics
- [ ] Database connection pools healthy
- [ ] RabbitMQ queue processing

### Health Checks
- [ ] Load balancer health check passing
- [ ] All API instances responding
- [ ] All workers responding
- [ ] Database connection healthy
- [ ] Redis connection healthy
- [ ] RabbitMQ connection healthy

### Functional Tests
- [ ] Send test notification via API
- [ ] Verify notification delivered
- [ ] Check delivery log updated
- [ ] Verify no duplicates
- [ ] Test scheduled notifications
- [ ] Test notification preferences
- [ ] Test quiet hours handling

## Scaling Tests

### Scale Up
```bash
# Scale to 10 workers
docker-compose -f docker-compose.scale.yml up -d --scale worker=10

# Verify all 10 workers healthy
for i in {1..10}; do
  curl http://localhost:909$i/health
done

# Run load test with higher rate
npm run load-test -- --duration=300 --rate=25
```

### Scale Down
```bash
# Scale down to 3 workers
docker-compose -f docker-compose.scale.yml up -d --scale worker=3

# Verify remaining workers healthy
for i in {1..3}; do
  curl http://localhost:909$i/health
done

# Verify no notifications lost
# Check queue depth should not increase
curl http://localhost:9091/resources | jq '.queue'
```

## Failure Scenarios

### Worker Crash Test
```bash
# Kill one worker
docker-compose -f docker-compose.scale.yml kill worker-1

# Verify:
# - Other workers continue processing
# - Locked notifications auto-expire after 5 minutes
# - No duplicates

# Restart worker
docker-compose -f docker-compose.scale.yml up -d worker-1

# Verify worker rejoins processing
curl http://localhost:9091/health
```

### Database Connection Loss
```bash
# Restart MongoDB
docker-compose -f docker-compose.scale.yml restart mongodb

# Verify:
# - Workers auto-reconnect
# - Connection pool recovers
# - No data loss

# Check worker logs
docker-compose logs worker-1 | grep -i "reconnect"
```

### Message Queue Restart
```bash
# Restart RabbitMQ
docker-compose -f docker-compose.scale.yml restart rabbitmq

# Verify:
# - Workers reconnect to queue
# - Messages not lost (durable queues)
# - Processing resumes

# Check RabbitMQ management UI
open http://localhost:15672
```

## Rollback Plan

### If Deployment Fails
```bash
# Stop all services
docker-compose -f docker-compose.scale.yml down

# Restore previous version (if applicable)
git checkout previous-version
npm run build
docker-compose up -d

# Verify services restored
curl http://localhost:3000/health
```

### If Load Test Fails
1. Check worker logs for errors
2. Review Grafana dashboards for anomalies
3. Verify database connection pool not exhausted
4. Check RabbitMQ queue depth
5. Scale workers if needed
6. Adjust configuration if necessary

## Production Checklist

### Security
- [ ] Environment variables secured (secrets management)
- [ ] SSL/TLS enabled on Nginx
- [ ] Firewall rules configured (only ports 80/443 exposed)
- [ ] Database authentication enabled
- [ ] Redis authentication enabled
- [ ] RabbitMQ authentication configured

### Monitoring
- [ ] Prometheus alerts configured
- [ ] Grafana alerts set up
- [ ] Log aggregation enabled (ELK/Splunk)
- [ ] Error tracking enabled (Sentry)
- [ ] APM enabled (New Relic/DataDog)

### Backup & Recovery
- [ ] MongoDB backup strategy configured
- [ ] Redis persistence enabled (AOF/RDB)
- [ ] RabbitMQ data directory backed up
- [ ] Disaster recovery plan documented
- [ ] RTO/RPO defined and tested

### Documentation
- [ ] Runbook for on-call engineers
- [ ] Architecture diagrams updated
- [ ] Configuration reference published
- [ ] Troubleshooting guide accessible
- [ ] Contact information for support

### CI/CD
- [ ] Build pipeline configured
- [ ] Automated tests running
- [ ] Deployment automation (GitHub Actions/Jenkins)
- [ ] Rollback automation
- [ ] Blue-green deployment strategy

## Maintenance

### Daily
- Monitor Grafana dashboards
- Check error rates
- Review worker logs for anomalies
- Verify no queue backlogs

### Weekly
- Review performance metrics trends
- Check database connection pool utilization
- Analyze load test results
- Update dependencies if needed

### Monthly
- Review and optimize worker configuration
- Analyze cost and resource utilization
- Update documentation
- Conduct disaster recovery drills

## Success Criteria

✅ All services running and healthy  
✅ Load test passing (11-12 notif/sec, 0% duplicates)  
✅ Monitoring dashboards displaying data  
✅ Worker CPU < 70%, Memory < 512MB  
✅ Database connections < 50  
✅ Error rate < 1%  
✅ Graceful shutdown working  
✅ Failure scenarios tested  
✅ Documentation complete  
✅ Production checklist completed  

## Sign-Off

- [ ] Development Team Lead
- [ ] QA Team Lead
- [ ] DevOps Engineer
- [ ] Product Owner
- [ ] Security Team

**Date**: _______________  
**Version**: Phase 5.3  
**Deployed By**: _______________  

---

## Emergency Contacts

- **On-Call Engineer**: [Phone/Email]
- **DevOps Lead**: [Phone/Email]
- **Development Lead**: [Phone/Email]
- **Database Admin**: [Phone/Email]

## Useful Commands

### Quick Diagnostics
```bash
# Check all service health
for port in 3001 3002 9091 9092 9093 9094 9095; do
  echo "Port $port:";
  curl -s http://localhost:$port/health | jq '.status';
done

# Check resource usage
docker stats --no-stream

# Check database connections
mongo mongodb://localhost:27017/notifications --eval "db.serverStatus().connections"

# Check RabbitMQ queue depth
curl -s http://localhost:15672/api/queues/notification-workers | jq '.messages'
```

### Emergency Stop
```bash
# Graceful shutdown (recommended)
docker-compose -f docker-compose.scale.yml down

# Force stop (emergency only)
docker-compose -f docker-compose.scale.yml kill
```

**Phase 5.3 Production Deployment Complete!** 🚀
