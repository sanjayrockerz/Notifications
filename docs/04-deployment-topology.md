# Deployment Topology

## 1. Local Development - Docker Compose Setup

```yaml
# docker-compose.yml
version: '3.8'

services:
  notification-service:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
      - PORT=3000
      - MONGODB_URI=mongodb://mongodb:27017/notifications
      - REDIS_URL=redis://redis:6379
      - RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
    depends_on:
      - mongodb
      - redis
      - rabbitmq
    volumes:
      - ./src:/app/src
      - ./logs:/app/logs
    networks:
      - notification-network

  mongodb:
    image: mongo:7.0
    ports:
      - "27017:27017"
    volumes:
      - mongodb_data:/data/db
      - ./scripts/mongo-init.js:/docker-entrypoint-initdb.d/init.js
    environment:
      - MONGO_INITDB_DATABASE=notifications
    networks:
      - notification-network

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    networks:
      - notification-network

  rabbitmq:
    image: rabbitmq:3.12-management
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      - RABBITMQ_DEFAULT_USER=admin
      - RABBITMQ_DEFAULT_PASS=admin123
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq
    networks:
      - notification-network

  # Development tools
  mongo-express:
    image: mongo-express:latest
    ports:
      - "8081:8081"
    environment:
      - ME_CONFIG_MONGODB_URL=mongodb://mongodb:27017/notifications
    depends_on:
      - mongodb
    networks:
      - notification-network

  redis-commander:
    image: rediscommander/redis-commander:latest
    ports:
      - "8082:8081"
    environment:
      - REDIS_HOSTS=local:redis:6379
    depends_on:
      - redis
    networks:
      - notification-network

volumes:
  mongodb_data:
  redis_data:
  rabbitmq_data:

networks:
  notification-network:
    driver: bridge
```

### Development Docker Compose Commands

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f notification-service

# Scale notification service
docker-compose up -d --scale notification-service=3

# Run tests
docker-compose exec notification-service npm test

# Database migration
docker-compose exec notification-service npm run migrate

# Cleanup
docker-compose down -v
```

## 2. Kubernetes Production Deployment

### Namespace Configuration

```yaml
# k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: notifications
  labels:
    name: notifications
    environment: production
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: notifications-quota
  namespace: notifications
spec:
  hard:
    requests.cpu: "8"
    requests.memory: 16Gi
    limits.cpu: "16"
    limits.memory: 32Gi
    pods: "50"
    services: "20"
    persistentvolumeclaims: "10"
```

### ConfigMap & Secrets

```yaml
# k8s/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: notification-config
  namespace: notifications
data:
  NODE_ENV: "production"
  PORT: "3000"
  LOG_LEVEL: "info"
  RATE_LIMIT_WINDOW_MS: "900000"
  RATE_LIMIT_MAX_REQUESTS: "100"
  NOTIFICATION_RETRY_ATTEMPTS: "3"
  DEVICE_TOKEN_CLEANUP_DAYS: "30"
  NOTIFICATION_RETENTION_DAYS: "30"
---
apiVersion: v1
kind: Secret
metadata:
  name: notification-secrets
  namespace: notifications
type: Opaque
data:
  MONGODB_URI: bW9uZ29kYjovL21vbmdvZGItc2VydmljZToyNzAxNy9ub3RpZmljYXRpb25z # base64 encoded
  REDIS_URL: cmVkaXM6Ly9yZWRpcy1zZXJ2aWNlOjYzNzk= # base64 encoded
  RABBITMQ_URL: YW1xcDovL2d1ZXN0Omd1ZXN0QHJhYmJpdG1xLXNlcnZpY2U6NTY3Mg== # base64 encoded
  JWT_SECRET: eW91ci1qd3Qtc2VjcmV0LWtleS1jaGFuZ2UtaW4tcHJvZHVjdGlvbg== # base64 encoded
  FIREBASE_PRIVATE_KEY: LS0tLS1CRUdJTi... # base64 encoded Firebase key
  APNS_PRIVATE_KEY: LS0tLS1CRUdJTi... # base64 encoded APNs key
```

### API Service Deployment

```yaml
# k8s/api-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: notification-api
  namespace: notifications
  labels:
    app: notification-api
    tier: api
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  selector:
    matchLabels:
      app: notification-api
  template:
    metadata:
      labels:
        app: notification-api
        tier: api
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3000"
        prometheus.io/path: "/metrics"
    spec:
      containers:
      - name: notification-api
        image: notification-service:v1.2.3
        ports:
        - containerPort: 3000
          name: http
        env:
        - name: SERVICE_TYPE
          value: "api"
        envFrom:
        - configMapRef:
            name: notification-config
        - secretRef:
            name: notification-secrets
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health/live
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 2
        volumeMounts:
        - name: logs
          mountPath: /app/logs
      volumes:
      - name: logs
        emptyDir: {}
      restartPolicy: Always
      terminationGracePeriodSeconds: 30
---
apiVersion: v1
kind: Service
metadata:
  name: notification-api-service
  namespace: notifications
  labels:
    app: notification-api
spec:
  selector:
    app: notification-api
  ports:
  - port: 80
    targetPort: 3000
    protocol: TCP
    name: http
  type: ClusterIP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: notification-api-ingress
  namespace: notifications
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/rate-limit: "100"
    nginx.ingress.kubernetes.io/rate-limit-window: "1m"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  tls:
  - hosts:
    - api.notifications.company.com
    secretName: notification-api-tls
  rules:
  - host: api.notifications.company.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: notification-api-service
            port:
              number: 80
```

### Consumer Service Deployment

```yaml
# k8s/consumer-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: notification-consumer
  namespace: notifications
  labels:
    app: notification-consumer
    tier: consumer
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 0 # Prevent duplicate message processing
  selector:
    matchLabels:
      app: notification-consumer
  template:
    metadata:
      labels:
        app: notification-consumer
        tier: consumer
    spec:
      containers:
      - name: notification-consumer
        image: notification-service:v1.2.3
        env:
        - name: SERVICE_TYPE
          value: "consumer"
        - name: CONSUMER_CONCURRENCY
          value: "10"
        envFrom:
        - configMapRef:
            name: notification-config
        - secretRef:
            name: notification-secrets
        resources:
          requests:
            memory: "256Mi"
            cpu: "200m"
          limits:
            memory: "512Mi"
            cpu: "400m"
        livenessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - "pgrep -f consumer"
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - "netstat -an | grep 5672 | grep ESTABLISHED"
          initialDelaySeconds: 10
          periodSeconds: 5
      restartPolicy: Always
      terminationGracePeriodSeconds: 60 # Allow graceful message processing
```

### Delivery Worker Deployment

```yaml
# k8s/worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: notification-worker
  namespace: notifications
  labels:
    app: notification-worker
    tier: worker
spec:
  replicas: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 2 # Allow scaling up during deployments
  selector:
    matchLabels:
      app: notification-worker
  template:
    metadata:
      labels:
        app: notification-worker
        tier: worker
    spec:
      containers:
      - name: notification-worker
        image: notification-service:v1.2.3
        env:
        - name: SERVICE_TYPE
          value: "worker"
        - name: WORKER_BATCH_SIZE
          value: "100"
        - name: WORKER_POLL_INTERVAL
          value: "1000"
        envFrom:
        - configMapRef:
            name: notification-config
        - secretRef:
            name: notification-secrets
        resources:
          requests:
            memory: "512Mi"
            cpu: "300m"
          limits:
            memory: "1Gi"
            cpu: "600m"
        livenessProbe:
          httpGet:
            path: /health/worker
            port: 3001
          initialDelaySeconds: 30
          periodSeconds: 15
        readinessProbe:
          httpGet:
            path: /health/worker/ready
            port: 3001
          initialDelaySeconds: 10
          periodSeconds: 10
      restartPolicy: Always
      terminationGracePeriodSeconds: 45
```

### Database StatefulSet

```yaml
# k8s/mongodb-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mongodb
  namespace: notifications
spec:
  serviceName: mongodb-service
  replicas: 3
  selector:
    matchLabels:
      app: mongodb
  template:
    metadata:
      labels:
        app: mongodb
    spec:
      containers:
      - name: mongodb
        image: mongo:7.0
        ports:
        - containerPort: 27017
        env:
        - name: MONGO_INITDB_ROOT_USERNAME
          value: "admin"
        - name: MONGO_INITDB_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mongodb-secret
              key: root-password
        - name: MONGO_INITDB_DATABASE
          value: "notifications"
        resources:
          requests:
            memory: "1Gi"
            cpu: "500m"
          limits:
            memory: "4Gi"
            cpu: "2"
        volumeMounts:
        - name: mongodb-data
          mountPath: /data/db
        - name: mongodb-config
          mountPath: /etc/mongo
        livenessProbe:
          exec:
            command:
            - mongosh
            - --eval
            - "db.adminCommand('ping')"
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          exec:
            command:
            - mongosh
            - --eval
            - "db.adminCommand('ping')"
          initialDelaySeconds: 10
          periodSeconds: 5
      volumes:
      - name: mongodb-config
        configMap:
          name: mongodb-config
  volumeClaimTemplates:
  - metadata:
      name: mongodb-data
    spec:
      accessModes:
      - ReadWriteOnce
      resources:
        requests:
          storage: 100Gi
      storageClassName: ssd-retain
---
apiVersion: v1
kind: Service
metadata:
  name: mongodb-service
  namespace: notifications
spec:
  clusterIP: None
  selector:
    app: mongodb
  ports:
  - port: 27017
    targetPort: 27017
```

## 3. Network Diagram

```mermaid
graph TB
    subgraph "External Traffic"
        INTERNET[Internet]
        MOBILE[Mobile Apps]
        SERVICES[External Services]
    end

    subgraph "Load Balancer Layer"
        ALB[Application Load Balancer]
        NLB[Network Load Balancer]
    end

    subgraph "Kubernetes Cluster"
        subgraph "Ingress Layer"
            NGINX[NGINX Ingress]
            CERT[Cert Manager]
        end
        
        subgraph "Application Pods"
            API1[API Pod 1]
            API2[API Pod 2]
            API3[API Pod 3]
            CONSUMER1[Consumer Pod 1]
            CONSUMER2[Consumer Pod 2]
            WORKER1[Worker Pod 1]
            WORKER2[Worker Pod 2]
            WORKER3[Worker Pod 3]
        end
        
        subgraph "Service Mesh"
            ISTIO[Istio Service Mesh]
            ENVOY[Envoy Proxies]
        end
    end

    subgraph "Data Layer"
        subgraph "Database Cluster"
            MONGO1[(MongoDB Primary)]
            MONGO2[(MongoDB Secondary)]
            MONGO3[(MongoDB Secondary)]
        end
        
        subgraph "Cache Cluster"
            REDIS1[(Redis Master)]
            REDIS2[(Redis Replica)]
            SENTINEL[Redis Sentinel]
        end
        
        subgraph "Message Queue"
            RMQ1[RabbitMQ Node 1]
            RMQ2[RabbitMQ Node 2]
            RMQ3[RabbitMQ Node 3]
        end
    end

    subgraph "External APIs"
        FCM[Firebase FCM]
        APNS[Apple APNs]
    end

    subgraph "Monitoring"
        PROMETHEUS[Prometheus]
        GRAFANA[Grafana]
        JAEGER[Jaeger Tracing]
    end

    %% Traffic Flow
    INTERNET --> ALB
    MOBILE --> NLB
    SERVICES --> ALB
    
    ALB --> NGINX
    NLB --> NGINX
    NGINX --> CERT
    
    NGINX --> API1
    NGINX --> API2
    NGINX --> API3
    
    API1 --> ISTIO
    API2 --> ISTIO
    API3 --> ISTIO
    
    CONSUMER1 --> RMQ1
    CONSUMER2 --> RMQ2
    
    API1 --> MONGO1
    API2 --> MONGO1
    API3 --> MONGO1
    
    API1 --> REDIS1
    API2 --> REDIS1
    API3 --> REDIS1
    
    WORKER1 --> FCM
    WORKER2 --> APNS
    WORKER3 --> FCM
    
    %% Database Replication
    MONGO1 --> MONGO2
    MONGO1 --> MONGO3
    REDIS1 --> REDIS2
    SENTINEL --> REDIS1
    SENTINEL --> REDIS2
    
    %% RabbitMQ Clustering
    RMQ1 --> RMQ2
    RMQ2 --> RMQ3
    RMQ3 --> RMQ1
    
    %% Monitoring
    API1 --> PROMETHEUS
    WORKER1 --> PROMETHEUS
    PROMETHEUS --> GRAFANA
    ISTIO --> JAEGER
```

## 4. Scaling Configuration

### Horizontal Pod Autoscaler

```yaml
# k8s/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: notification-api-hpa
  namespace: notifications
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: notification-api
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  - type: Pods
    pods:
      metric:
        name: requests_per_second
      target:
        type: AverageValue
        averageValue: "100"
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
      - type: Pods
        value: 2
        periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 60
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: notification-worker-hpa
  namespace: notifications
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: notification-worker
  minReplicas: 5
  maxReplicas: 15
  metrics:
  - type: External
    external:
      metric:
        name: rabbitmq_queue_messages
        selector:
          matchLabels:
            queue: "notification_queue"
      target:
        type: AverageValue
        averageValue: "100"
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 75
```

### Cluster Autoscaler Configuration

```yaml
# k8s/cluster-autoscaler.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - image: k8s.gcr.io/autoscaling/cluster-autoscaler:v1.21.0
        name: cluster-autoscaler
        command:
        - ./cluster-autoscaler
        - --v=4
        - --stderrthreshold=info
        - --cloud-provider=aws
        - --skip-nodes-with-local-storage=false
        - --expander=least-waste
        - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/notifications-cluster
        - --balance-similar-node-groups
        - --scale-down-enabled=true
        - --scale-down-delay-after-add=10m
        - --scale-down-unneeded-time=10m
        - --max-node-provision-time=15m
```

## 5. Service Mesh Configuration (Istio)

```yaml
# k8s/service-mesh.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: notification-api
  namespace: notifications
spec:
  hosts:
  - api.notifications.company.com
  gateways:
  - notification-gateway
  http:
  - match:
    - uri:
        prefix: "/api/notifications"
    route:
    - destination:
        host: notification-api-service
        port:
          number: 80
    retries:
      attempts: 3
      perTryTimeout: 2s
    timeout: 10s
  - match:
    - uri:
        prefix: "/health"
    route:
    - destination:
        host: notification-api-service
        port:
          number: 80
    timeout: 5s
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: notification-api
  namespace: notifications
spec:
  host: notification-api-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 100
        maxRequestsPerConnection: 10
    outlierDetection:
      consecutiveErrors: 3
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
    loadBalancer:
      simple: LEAST_CONN
```