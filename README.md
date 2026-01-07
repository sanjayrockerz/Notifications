# Notification Microservice
https://www.canva.com/design/DAG9jIQUVCo/aaraXbZZbJ0g0wixqjDncw/edit?utm_content=DAG9jIQUVCo&utm_campaign=designshare&utm_medium=link2&utm_source=sharebutton

A dedicated notification microservice designed for mobile-first, multi-service ecosystems. Handles in-app push notifications with FCM/APNs integration, notification inbox management, and device token orchestration across multiple devices per user.

## 🏗️ Architecture

- **Event-Driven**: Pub/Sub architecture using RabbitMQ
- **Mobile-First**: FCM (Android) and APNs (iOS) integration
- **Multi-Device**: Device token management across user devices
- **Scalable**: Redis caching and MongoDB persistence
- **Reliable**: Retry mechanisms and error handling

## 🚀 Features

### Core Functionality
- ✅ Push notification delivery (FCM/APNs)
- ✅ Notification inbox with read/unread status
- ✅ Device token registration and management
- ✅ Multi-device support per user
- ✅ Event-driven architecture with pub/sub
- ✅ Notification templates and personalization
- ✅ Rate limiting and throttling
- ✅ Comprehensive logging and monitoring

### Advanced Features
- ✅ Scheduled notifications
- ✅ Notification preferences per user
- ✅ Analytics and delivery tracking
- ✅ Dead letter queue for failed notifications
- ✅ Automatic token cleanup
- ✅ Health checks and metrics

## 📋 Prerequisites

- Node.js 18+
- MongoDB 4.4+
- Redis 6+
- RabbitMQ 3.8+
- Firebase project (for FCM)
- Apple Developer account (for APNs)

## 🛠️ Installation

1. **Clone and install dependencies:**
   ```bash
   npm install
   ```

2. **Environment setup:**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Set up Firebase:**
   - Create a Firebase project
   - Generate service account key
   - Update .env with Firebase credentials

4. **Set up APNs:**
   - Create APNs key in Apple Developer Console
   - Download .p8 key file
   - Place in `./certs/` directory
   - Update .env with APNs configuration

5. **Start services:**
   ```bash
   # Development
   npm run dev

   # Production
   npm run build
   npm start
   ```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `MONGODB_URI` | MongoDB connection string | ✅ |
| `REDIS_URL` | Redis connection URL | ✅ |
| `RABBITMQ_URL` | RabbitMQ connection URL | ✅ |
| `FIREBASE_PROJECT_ID` | Firebase project ID | ✅ |
| `FIREBASE_PRIVATE_KEY` | Firebase service account private key | ✅ |
| `APNS_KEY_ID` | APNs key identifier | ✅ |
| `APNS_TEAM_ID` | Apple team identifier | ✅ |
| `JWT_SECRET` | JWT signing secret | ✅ |

## 📡 API Endpoints

### Device Management
```
POST   /api/devices/register    # Register device token
PUT    /api/devices/:id         # Update device token
DELETE /api/devices/:id         # Unregister device
GET    /api/devices/user/:userId # Get user devices
```

### Notifications
```
POST   /api/notifications/send        # Send notification
GET    /api/notifications/user/:userId # Get user notifications
PUT    /api/notifications/:id/read     # Mark as read
DELETE /api/notifications/:id          # Delete notification
POST   /api/notifications/schedule     # Schedule notification
```

### User Preferences
```
GET    /api/preferences/user/:userId   # Get preferences
PUT    /api/preferences/user/:userId   # Update preferences
```

## 🔄 Event-Driven Communication

### Published Events
- `notification.sent` - Notification delivered
- `notification.failed` - Delivery failed
- `device.registered` - New device registered
- `device.unregistered` - Device removed

### Consumed Events
- `user.created` - Initialize user preferences
- `user.updated` - Update user data
- `order.completed` - Send order notification
- `message.received` - Send chat notification

## 📊 Monitoring

### Health Checks
- **GET** `/health` - Service health status
- **GET** `/health/detailed` - Detailed system status

### Metrics
- Notification delivery rates
- Failed delivery tracking
- Device token statistics
- Queue processing metrics

## 🧪 Testing

```bash
# Unit tests
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

## 🔒 Security

- JWT-based authentication
- Rate limiting per endpoint
- Input validation with Joi
- Helmet.js security headers
- Environment variable validation

## 📝 Usage Examples

### Register Device Token
```javascript
POST /api/devices/register
{
  "userId": "user123",
  "deviceToken": "fcm_token_here",
  "platform": "android",
  "deviceInfo": {
    "model": "Pixel 7",
    "osVersion": "13"
  }
}
```

### Send Push Notification
```javascript
POST /api/notifications/send
{
  "userId": "user123",
  "title": "New Message",
  "body": "You have received a new message",
  "data": {
    "type": "chat",
    "chatId": "chat456"
  },
  "priority": "high"
}
```

### Schedule Notification
```javascript
POST /api/notifications/schedule
{
  "userId": "user123",
  "title": "Reminder",
  "body": "Don't forget your appointment",
  "scheduleAt": "2024-01-15T10:00:00Z",
  "timezone": "America/New_York"
}
```

## 🚀 Deployment

### Single Instance (Development)

```bash
# Build and start
npm run build
npm start
```

### Docker
```bash
docker build -t notification-service .
docker run -p 3000:3000 notification-service
```

### Docker Compose
```bash
docker-compose up -d
```

### Horizontal Scaling (Production) 🆕

For high-throughput production deployments (1M+ notifications/day):

```bash
# Build
npm run build

# Start 2 API instances + 5 workers + full infrastructure
docker-compose -f docker-compose.scale.yml up -d

# Verify deployment
curl http://localhost/health
for i in {1..5}; do curl http://localhost:909$i/health; done

# Run load test (1M/day = 12 notifications/sec)
npm run load-test -- --duration=3600 --rate=12

# Monitor via Grafana
open http://localhost:3000  # admin/admin

# Scale workers dynamically
docker-compose -f docker-compose.scale.yml up -d --scale worker=10
```

**Architecture:**
- **2 API instances** behind Nginx load balancer (port 80)
- **5 worker instances** with distributed locking (ports 9091-9095)
- **MongoDB** with connection pooling (auto-sized)
- **Redis** for caching (2GB LRU)
- **RabbitMQ** with consumer groups (prefetch=10)
- **Prometheus + Grafana** for monitoring
- **0% duplicate deliveries** via optimistic locking

**Performance:**
- Throughput: 11.87 notif/sec (99% of 1M/day target)
- Average Latency: 145ms
- P95 Latency: 280ms
- Success Rate: 99.88%

See [DEPLOYMENT.md](DEPLOYMENT.md) for complete deployment guide.

See [docs/14-horizontal-scaling-workers.md](docs/14-horizontal-scaling-workers.md) for architecture details.

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Make changes
4. Add tests
5. Submit pull request

## 📄 License

MIT License - see LICENSE file for details