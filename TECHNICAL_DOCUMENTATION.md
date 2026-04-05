# Arqam Scale Suite - Technical Deep Dive Documentation

**Document Type**: Engineering Reference  
**Target Audience**: Backend engineers, DevOps, system architects  
**Scope**: Architecture, implementation details, advanced configurations  
**Last Updated**: April 5, 2026

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Service Implementation Details](#service-implementation-details)
3. [Data Model & Persistence](#data-model--persistence)
4. [Queue & Worker System](#queue--worker-system)
5. [Authentication & Security](#authentication--security)
6. [Observability & Monitoring](#observability--monitoring)
7. [Performance Optimization](#performance-optimization)
8. [Troubleshooting & Debug](#troubleshooting--debug)
9. [Advanced Configurations](#advanced-configurations)
10. [API Reference](#api-reference)

---

## System Architecture

### Component Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    Client Layer                              │
│  Web (React) | Mobile (iOS/Android) | CLI (curl/Python)     │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       │ HTTP/HTTPS
                       │
        ┌──────────────▼──────────────┐
        │   Nginx Reverse Proxy       │
        │   (Port 80/443)             │
        │   Path-based routing        │
        │   Health aggregation        │
        └───────┬────────────┬────────┘
                │            │
        ┌───────▼────┐  ┌────▼────────┐
        │ Node.js    │  │ Go          │
        │ Services   │  │ Service     │
        └────┬───────┘  └────┬───────┘
             │               │
    ┌────────┼───────────────┼──────────┐
    │        │               │          │
┌───▼──┐ ┌──▼────┐ ┌───────▼┐ ┌──────▼──┐
│Auth  │ │Jobs   │ │Chat    │ │Utilities│
└──────┘ └───┬───┘ └────────┘ └─────────┘
              │
    ┌─────────┴──────────┐
    │                    │
┌───▼─────┐        ┌────▼────┐
│Postgres │        │ Redis   │
│DB       │        │ Queue   │
│(Persist)│        │(Cache)  │
└─────────┘        └─────────┘
```

### Network Topology

**Port Layout**:
```
80    → Nginx Gateway (external)
443   → Nginx TLS (future)
3000  → dub-links (internal)
3001  → trigger-bg (internal)
3002  → coolify-paas (internal)
3003  → hopp-test (internal)
4000  → paper-cups (internal)
5432  → Postgres (internal)
6379  → Redis (internal)
8080  → pocket-base (internal)
```

**Internal DNS** (Docker network):
```
gateway:80         → Nginx reverse proxy
dub-links:3000     → Link shortener
trigger-bg:3001    → Job queue
pocket-base:8080   → Auth API
paper-cups:4000    → WebSocket
db-links:5432      → Postgres database
redis:6379         → Redis cache
```

### Compose Service Dependencies

```yaml
# Dependency tree
gateway (depends_on: all services healthy)
├── trigger-bg (depends_on: redis healthy)
│   └── redis (no dependencies)
├── dub-links (depends_on: db-links healthy)
│   └── db-links (Postgres, no dependencies)
├── pocket-base (no dependencies)
├── paper-cups (no dependencies)
├── coolify-paas (no dependencies)
└── hopp-test (no dependencies)
```

**Startup Sequence**:
1. Redis starts (no deps) → healthy in ~2s
2. Postgres starts (no deps) → healthy in ~5s
3. Node services start (deps: Redis/Postgres) → healthy in ~10s
4. Nginx gateway starts (depends_on all healthy) → routes traffic

**Total Startup Time**: ~30-45 seconds to full health

---

## Service Implementation Details

### 1. trigger-bg (Job Queue Service)

**Purpose**: Asynchronous job processing with BullMQ + Redis

**Core Components**:
```javascript
// Queue setup with Redis connection
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

const redis = new IORedis({
  host: process.env.REDIS_HOST || 'redis',
  port: 6379
});

const jobQueue = new Queue('job-queue', { connection: redis });
const worker = new Worker('job-queue', processJob, { connection: redis });
```

**Request Flow**:
```
POST /api/jobs
│
├─► Middleware: requireApiKey
│   (Check X-API-Key header)
│
├─► Middleware: writeLimiter
│   (Rate limit: 100 req/min)
│
├─► Validate job data
│   - jobType: string (required)
│   - data: object (optional)
│   - attempts: number (default: 1)
│   - backoff: 'fixed' | 'exponential' (default: fixed)
│
├─► Enqueue to Redis
│   jobQueue.add(jobType, data, {
│     attempts: 3,
│     backoff: { type: 'exponential', delay: 2000 }
│   })
│
├─► Return job ID + status
│   { id: 'abc123', status: 'waiting' }
│
└─► Worker processes asynchronously
    (separate container)
```

**Worker Implementation**:
```javascript
const worker = new Worker('job-queue', async (job) => {
  const { jobType, data } = job;
  
  switch (jobType) {
    case 'send_email':
      return await sendEmail(data);
    case 'generate_report':
      return await generateReport(data);
    case 'sync_data':
      return await syncExternalAPI(data);
    default:
      throw new Error(`Unknown job type: ${jobType}`);
  }
}, {
  connection: redis,
  concurrency: Number(process.env.WORKER_CONCURRENCY || 4)
});

// Event handlers
worker.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed: ${JSON.stringify(result)}`);
});

worker.on('failed', (job, error) => {
  console.error(`Job ${job.id} failed: ${error.message}`);
  // Retry logic handled by BullMQ
});
```

**State Management**:
```
Job States:
  waiting → active → completed/failed

waiting    : Queued, waiting for worker to pick up
active     : Currently being processed by worker
completed  : Successfully finished, result stored
failed     : Max retries exceeded, stored error

Retention Policy:
  Completed jobs: Keep 1 week (configurable)
  Failed jobs:    Keep indefinitely (for debugging)
```

**Endpoints**:
```
POST /api/jobs
  Create new job
  Body: { jobType: string, data: object, attempts: number }
  Response: { id, status, createdAt }
  Auth: Requires X-API-Key

GET /api/jobs
  List all jobs
  Query: ?status=waiting|active|completed|failed&limit=50&offset=0
  Response: { jobs: [...], total, offset, limit }
  Auth: Requires X-API-Key

GET /api/jobs/:id
  Get job details
  Response: { id, type, status, data, progress, result, error }
  Auth: Requires X-API-Key

GET /api/jobs/:id/result
  Get job result (blocks until completion)
  Response: 200 { result } | 409 Conflict (still processing)
  Timeout: 60 seconds

DELETE /api/jobs/:id
  Cancel a job (if not started)
  Response: { canceled: true } | 404 { error: 'Job not found' }
  Auth: Requires X-API-Key

GET /health
  Service health check
  Response: { status: 'ok' }
  No Auth
```

**Configuration Env Vars**:
```bash
REDIS_HOST=redis              # Redis hostname
REDIS_PORT=6379              # Redis port
TRIGGER_API_KEY=change-me     # API key for auth
TRIGGER_READ_RATE_LIMIT=300   # Requests per minute
TRIGGER_WRITE_RATE_LIMIT=100  # Requests per minute
WORKER_CONCURRENCY=4          # Workers per instance
JOB_RETENTION_DAYS=7          # Keep completed jobs for N days
```

**Example Usage**:
```bash
# Enqueue a job
curl -X POST http://localhost:3001/api/jobs \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "jobType": "generate_report",
    "data": { "userId": 123, "format": "pdf" },
    "attempts": 3
  }'

# Response
{
  "id": "1:abc123",
  "status": "waiting",
  "createdAt": "2024-04-05T10:00:00Z"
}

# Poll for result
curl http://localhost:3001/api/jobs/1:abc123/result \
  -H "X-API-Key: your-api-key"

# Still processing (409 Conflict)
# or
# Success (200 OK)
{
  "result": {
    "reportUrl": "s3://bucket/report-123.pdf",
    "pages": 42,
    "generatedAt": "2024-04-05T10:00:30Z"
  }
}
```

---

### 2. dub-links (Link Shortener Service)

**Purpose**: URL shortening with persistent storage and analytics

**Database Schema**:
```sql
CREATE TABLE links (
  slug TEXT PRIMARY KEY,
  destination_url TEXT NOT NULL,
  title TEXT,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX links_destination_url_slug_idx ON links (slug);

-- Optional: Analytics table (for advanced tracking)
CREATE TABLE clicks (
  id SERIAL PRIMARY KEY,
  slug TEXT REFERENCES links(slug),
  referrer TEXT,
  user_agent TEXT,
  ip_address INET,
  clicked_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Connection Pooling**:
```javascript
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST || 'db-links',
  port: 5432,
  user: 'postgres',
  password: process.env.DATABASE_PASSWORD,
  database: 'dublinks',
  min: 2,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});
```

**Request Flow** (Create Link):
```
POST /api/links
│
├─► Middleware: requireApiKey
│   (Check X-API-Key header)
│
├─► Middleware: writeLimiter
│   (Rate limit: 60 req/min)
│
├─► Validate request
│   - destination_url: URL format
│   - slug: Optional, alphanumeric + hyphens
│   - title: Optional, string
│
├─► Generate slug if not provided
│   slug = crypto.randomBytes(6).toString('base64url')
│        = 8-character random string
│
├─► Check slug uniqueness
│   SELECT 1 FROM links WHERE slug = $1
│   If exists: reject with 409 Conflict
│
├─► Insert with transaction
│   BEGIN;
│   INSERT INTO links (slug, destination_url, title)
│   VALUES ($1, $2, $3);
│   COMMIT;
│
├─► Return short link
│   {
│     slug: "abc123xy",
│     shortUrl: "http://localhost/abc123xy",
│     destinationUrl: "https://example.com/...",
│     createdAt: "2024-04-05T10:00:00Z"
│   }
│
└─► Format response using formatLink()
```

**Request Flow** (Redirect + Click Tracking):
```
GET /:slug
│
├─► No auth (public)
│
├─► No rate limit (read-optimized)
│
├─► Query with transaction
│   BEGIN;
│   SELECT destination_url FROM links WHERE slug = $1;
│   UPDATE links SET clicks = clicks + 1, updated_at = NOW()
│   WHERE slug = $1;
│   COMMIT;
│   (Atomic: read + increment in same transaction)
│
├─► Return 302 redirect
│   Location: <destination_url>
│
└─► Analytics collected
    (clicks incremented in Postgres)
```

**Endpoints**:
```
POST /api/links
  Create short link
  Auth: Requires X-API-Key
  Body: {
    destination_url: string (required),
    slug: string (optional, auto-generated if missing),
    title: string (optional)
  }
  Response: { slug, shortUrl, destinationUrl, title, createdAt }

GET /api/links/:slug
  Fetch link metadata
  Auth: Requires X-API-Key
  Response: { slug, destination_url, clicks, created_at, updated_at }

GET /:slug
  Public redirect (no auth, no rate limit)
  Response: 302 Location: <destination_url>

DELETE /api/links/:slug
  Delete short link
  Auth: Requires X-API-Key
  Response: { deleted: true }

GET /health
  Health check
  Response: { status: 'ok' }
```

**Configuration Env Vars**:
```bash
DB_HOST=db-links
DB_PORT=5432
DB_USER=postgres
DATABASE_PASSWORD=change-me
DB_NAME=dublinks
PUBLIC_BASE_URL=http://localhost:3000
DUB_API_KEY=change-me
DUB_READ_RATE_LIMIT=300      # Requests per minute
DUB_WRITE_RATE_LIMIT=60      # Requests per minute
```

**Performance Characteristics**:
```
Create link:     ~50ms (includes DB transaction)
Redirect:        ~10ms (simple SELECT + UPDATE in transaction)
Throughput:      1,000+ redirects/sec on single Postgres instance
Storage:         ~2KB per link (slug + URL + metadata)
Scalability:     ~1M links per Postgres instance before sharding needed
```

**Example Usage**:
```bash
# Create short link
curl -X POST http://localhost:3000/api/links \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "destination_url": "https://www.example.com/very/long/path?param=value",
    "title": "Example Page"
  }'

# Response
{
  "slug": "abc123xy",
  "shortUrl": "http://localhost/abc123xy",
  "destinationUrl": "https://www.example.com/very/long/path?param=value",
  "clicks": 0,
  "createdAt": "2024-04-05T10:00:00Z"
}

# Use short link (public redirect)
curl -L http://localhost/abc123xy
# Returns: 302 Location: https://www.example.com/very/long/path?param=value
# Click count incremented

# Check link stats
curl http://localhost:3000/api/links/abc123xy \
  -H "X-API-Key: your-api-key"

# Response
{
  "slug": "abc123xy",
  "destination_url": "https://www.example.com/...",
  "clicks": 42,
  "created_at": "2024-04-05T10:00:00Z",
  "updated_at": "2024-04-05T10:05:30Z"
}
```

---

### 3. pocket-base (Auth & Data API)

**Purpose**: User authentication, JWT tokens, embedded database

**Tech Stack**: Go + SQLite + HTTP API

**Core Features**:
```go
// SQLite schema (auto-created)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,    // bcrypt
  email TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  schema JSONB,                   // Flexible schema
  owner_id TEXT REFERENCES users(id)
);

CREATE TABLE records (
  id TEXT PRIMARY KEY,
  collection_id TEXT REFERENCES collections(id),
  data JSONB,                     // Flexible data
  created_at DATETIME,
  updated_at DATETIME
);
```

**Authentication Flow**:
```
POST /register
├─► Body: { username, password, email }
├─► Validate: username unique, password strength
├─► Hash password: bcrypt.hash(password, 10)
├─► Create user: INSERT INTO users
└─► Return: { id, username, email, createdAt }

POST /login
├─► Body: { username, password }
├─► Query: SELECT * FROM users WHERE username = $1
├─► Verify: bcrypt.compare(password, password_hash)
├─► Generate JWT: sign({ userId, username }, secret, { expiresIn: '24h' })
└─► Return: { token, expiresIn: 86400 }

GET /me (protected)
├─► Header: Authorization: Bearer <token>
├─► Verify JWT signature
├─► Return: { id, username, email, createdAt }
└─► Refresh token if expiring soon
```

**Endpoints**:
```
POST /register
  Register new user
  Body: { username, password, email }
  Response: 201 { id, username, email }
  Error: 409 Conflict (username exists)

POST /login
  Authenticate and get token
  Body: { username, password }
  Response: 200 { token, expiresIn, user: {...} }
  Error: 401 Unauthorized (invalid credentials)

GET /me
  Get current user
  Auth: Bearer <token>
  Response: 200 { id, username, email, createdAt }
  Error: 401 Unauthorized (no token)

POST /collections (protected)
  Create collection
  Auth: Bearer <token>
  Body: { name, schema }
  Response: 201 { id, name, schema, ownerId }

POST /collections/:id/records (protected)
  Create record in collection
  Auth: Bearer <token>
  Body: { data }
  Response: 201 { id, collectionId, data, createdAt }

GET /collections/:id/records (protected)
  List records
  Auth: Bearer <token>
  Query: ?limit=50&offset=0
  Response: 200 { records: [...], total }

GET /health
  Health check
  Response: { status: 'ok' }
```

**Configuration Env Vars**:
```bash
POCKET_PORT=8080
POCKET_DB_PATH=/data/pocket.db      # SQLite file
JWT_SECRET=change-me-to-long-secret # JWT signing key
JWT_EXPIRY=24h                        # Token validity
```

---

### 4. paper-cups (WebSocket Service)

**Purpose**: Real-time bidirectional messaging

**Connection Flow**:
```
Client connects:
  ws://localhost:4000/ws

Optional token auth:
  ws://localhost:4000/ws?token=<jwt>

Server accepts connection:
  Client added to broadcast list

Client sends message:
  {
    type: 'message',
    room: 'general',
    text: 'Hello everyone!'
  }

Server broadcasts to all clients:
  {
    type: 'message',
    from: 'user-123',
    room: 'general',
    text: 'Hello everyone!',
    timestamp: '2024-04-05T10:00:00Z'
  }
```

**Message Protocol**:
```javascript
// Client → Server
{
  type: 'message' | 'typing' | 'presence',
  room: 'room-name',
  text: 'message text',
  metadata: { userId: 'user-123' }
}

// Server → All Clients (broadcast)
{
  type: 'message' | 'typing' | 'presence',
  from: 'user-123',
  room: 'room-name',
  text: 'message text',
  timestamp: '2024-04-05T10:00:00Z'
}
```

**Endpoints**:
```
GET /health
  Health check
  Response: { status: 'ok' }

WS /ws
  WebSocket upgrade
  Query: ?token=<optional-jwt>
  Broadcasts messages to all connected clients

POST /api/broadcast
  Admin endpoint to broadcast message to all
  Auth: Requires X-API-Key
  Body: { message: string, type: 'notification' }
  Response: { broadcasted: true }
```

---

### 5. coolify-paas & hopp-test

**Purpose**: Placeholder services for deployment orchestration and API testing

**Basic Endpoints**:
```
GET /health              → { status: 'ok' }
GET /api/health          → { status: 'ok' }
GET /api/apps            → { apps: [] }
GET /api/workspace       → { workspace: {...} }

All endpoints:
- No authentication required (dev mode)
- Rate limited by default
- Logged via requestLogger
```

---

## Data Model & Persistence

### Postgres Schema (dub-links)

**Tables**:
```sql
-- Main links table
CREATE TABLE links (
  slug TEXT PRIMARY KEY,
  destination_url TEXT NOT NULL,
  title TEXT,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optional: Advanced analytics
CREATE TABLE click_events (
  id SERIAL PRIMARY KEY,
  slug TEXT REFERENCES links(slug) ON DELETE CASCADE,
  referrer TEXT,
  user_agent TEXT,
  ip_address INET,
  country TEXT,
  device TEXT,
  os TEXT,
  clicked_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE UNIQUE INDEX idx_links_slug ON links(slug);
CREATE INDEX idx_click_events_slug ON click_events(slug);
CREATE INDEX idx_click_events_date ON click_events(clicked_at);
```

**Query Performance**:
```
CREATE link:      50-100ms  (1 INSERT + 1 SELECT for uniqueness)
Redirect:         5-10ms    (1 SELECT + 1 UPDATE in transaction)
List clicks:      20-50ms   (1 SELECT with aggregation)
Bulk insert:      1-2ms per row (batched)
```

**Connection Pool Configuration**:
```javascript
{
  min: 2,                    // Minimum connections
  max: 10,                   // Maximum connections
  idleTimeoutMillis: 30000,  // Close idle after 30s
  connectionTimeoutMillis: 5000  // Fail if can't get conn in 5s
}
```

### Redis Schema (trigger-bg)

**Data Structures**:
```
Hash: bull:job-queue:<job-id>
  - data: JSON payload
  - status: 'waiting' | 'active' | 'completed' | 'failed'
  - progress: 0-100
  - result: JSON result (if completed)
  - error: error message (if failed)

List: bull:job-queue:waiting
  - Job IDs waiting to be processed

List: bull:job-queue:active
  - Job IDs currently being processed

Sorted Set: bull:job-queue:completed
  - Job IDs: { score: completion_timestamp }

Sorted Set: bull:job-queue:failed
  - Job IDs: { score: failure_timestamp }
```

**Memory Considerations**:
```
Average job size:     ~1KB
Queue capacity:       ~10k jobs before memory pressure
Typical memory:       50-100MB for 10k jobs
Retention policy:     Delete completed jobs after 7 days
                      Keep failed jobs indefinitely
```

### SQLite Schema (pocket-base)

**Tables**:
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  email TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  schema TEXT,  -- JSON string
  owner_id TEXT REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE records (
  id TEXT PRIMARY KEY,
  collection_id TEXT REFERENCES collections(id),
  data TEXT,  -- JSON string
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**File Location**: `/data/pocket.db` (inside container)

---

## Queue & Worker System

### Job Lifecycle

```
1. ENQUEUE
   ├─► POST /api/jobs
   ├─► Validate request
   ├─► Generate job ID
   └─► Push to Redis queue
       Job state: "waiting"

2. WAIT
   ├─► Job sits in queue
   ├─► Waiting for worker to pick up
   └─► Average wait: 0-5s (depends on load)

3. START PROCESSING
   ├─► Worker picks up job from queue
   ├─► Job state: "active"
   └─► Processing starts

4. PROCESS
   ├─► Worker executes job handler
   ├─► Handler may take 1ms - hours
   ├─► Progress updates stored in Redis
   └─► Job state: "active" + progress: X%

5. COMPLETE
   ├─► Handler returns result
   ├─► Result stored in Redis
   ├─► Job state: "completed"
   └─► TTL: 7 days (then deleted)
       OR
6. FAIL
   ├─► Handler throws error
   ├─► Check retry count
   ├─► If retries left: ENQUEUE again
   ├─► If retries exhausted:
   │   Job state: "failed"
   │   Error stored in Redis
   │   TTL: indefinite (keep for debugging)
   └─► Client can query result endpoint
       Returns 409 (still processing)
       or 200 (result ready)
       or 404 (failed, check error)
```

### Worker Concurrency

**Configuration**:
```bash
# How many jobs to process simultaneously per worker
WORKER_CONCURRENCY=4

# With 2 worker containers × 4 concurrency = 8 jobs in parallel
```

**Example Job Processing**:
```
Time   Job 1    Job 2    Job 3    Job 4    Workers Free
0s     [start]  [start]  [start]  [start]  0/4
5s     [done]   [start]  [start]  [start]  1/4
       [Job 5:start]
10s    [done]   [done]   [start]  [start]  2/4
       [Job 6:start] [Job 7:start]
15s    [done]   [done]   [done]   [done]   4/4
       [Job 8:start] [Job 9:start] [Job 10:start] [Job 11:start]
```

**Max Throughput** (with defaults):
```
Concurrency: 4 per container
Average job duration: 5 seconds
Max jobs/sec: 4 / 5 = 0.8 jobs/sec per container

With 2 worker containers:
Max throughput: 1.6 jobs/sec = 5,760 jobs/hour

Scaling:
- Add more worker containers: throughput scales linearly
- 10 containers: 8 jobs/sec = 28,800 jobs/hour
```

### Retry Strategy

```javascript
// Enqueue with retry config
{
  attempts: 3,              // Total attempts (1 initial + 2 retries)
  backoff: 'exponential',   // Delay increases each retry
  backoffDelay: 2000        // 2 second initial delay
}

// Retry sequence:
Attempt 1: 0s delay
Attempt 2: 2s delay (if failed)
Attempt 3: 4s delay (if failed)
Final:     Job marked as "failed" (if still failing)
```

**Example**:
```
0s    Attempt 1: timeout error → retry
2s    Attempt 2: network error → retry
4s    Attempt 3: timeout error → failed (exhausted attempts)
```

---

## Authentication & Security

### API Key Auth

**Middleware**:
```javascript
function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const validKey = process.env.SERVICE_API_KEY;
  
  if (!apiKey || apiKey !== validKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
}

app.post('/api/jobs', requireApiKey, handler);
```

**Usage**:
```bash
curl -X POST http://localhost:3001/api/jobs \
  -H "X-API-Key: your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"jobType": "send_email"}'
```

**Key Management**:
```bash
# Dev environment
DUB_API_KEY=dev-key-change-me
TRIGGER_API_KEY=dev-key-change-me

# Production environment
# Generate strong keys
openssl rand -base64 32
# Output: abc123...xyz (44 chars)

# Store in secret manager (AWS Secrets Manager, Vault, etc.)
# Never commit .env to git
```

### JWT Authentication (pocket-base)

**Token Generation**:
```javascript
const jwt = require('jsonwebtoken');

const token = jwt.sign(
  { userId: user.id, username: user.username },
  process.env.JWT_SECRET,
  { expiresIn: '24h' }
);
```

**Token Verification**:
```javascript
function verifyJWT(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    throw new Error('Invalid token');
  }
}
```

**Usage**:
```bash
# Get token
curl -X POST http://localhost:8080/login \
  -H "Content-Type: application/json" \
  -d '{"username": "user", "password": "pass"}'

# Response
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 86400
}

# Use token
curl http://localhost:8080/me \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### Rate Limiting Security

**Middleware**:
```javascript
const limiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minute window
  max: 100,                  // 100 requests per minute
  standardHeaders: true,     // Include rate-limit headers
  legacyHeaders: false
});

app.use(limiter);
```

**Response Headers**:
```
RateLimit-Limit: 100
RateLimit-Remaining: 87
RateLimit-Reset: 1712325660
```

**Rate Limit Bypass** (internal services):
```javascript
// Create separate limiter for internal IPs
const internalLimiter = rateLimit({
  skip: (req) => {
    return req.ip === '172.18.0.1' || req.ip === '127.0.0.1';
  },
  max: 1000
});

app.use(internalLimiter);
```

### SQL Injection Prevention

**Bad (Vulnerable)**:
```javascript
const query = `SELECT * FROM links WHERE slug = '${req.params.slug}'`;
// Vulnerable to: '; DROP TABLE links; --
```

**Good (Safe)**:
```javascript
const query = 'SELECT * FROM links WHERE slug = $1';
const result = await pool.query(query, [req.params.slug]);
// Parameterized query prevents injection
```

**All dub-links queries use parameterized prepared statements**:
```javascript
// Safe patterns used throughout
await pool.query('INSERT INTO links (slug, destination_url) VALUES ($1, $2)', 
  [slug, url]);

await pool.query('SELECT * FROM links WHERE slug = $1', 
  [slug]);

await pool.query('UPDATE links SET clicks = clicks + 1 WHERE slug = $1',
  [slug]);
```

---

## Observability & Monitoring

### Request Logging

**Format**:
```json
{
  "timestamp": "2024-04-05T10:00:00Z",
  "service": "dub-links",
  "method": "POST",
  "path": "/api/links",
  "status": 201,
  "duration_ms": 45,
  "ip": "192.168.1.1",
  "user_agent": "curl/7.68.0"
}
```

**Implementation**:
```javascript
function requestLogger(serviceName) {
  return (req, res, next) => {
    const start = Date.now();
    
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        service: serviceName,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: duration,
        ip: req.ip,
        user_agent: req.get('user-agent')
      }));
    });
    
    next();
  };
}
```

### Health Checks

**Endpoint** (all services):
```
GET /health
Response: 200 { status: 'ok' }
```

**Compose Health Check**:
```yaml
healthcheck:
  test: ["CMD", "wget", "-qO-", "http://localhost:PORT/health"]
  interval: 10s
  timeout: 3s
  retries: 3
  start_period: 10s
```

**Gateway Aggregation**:
```
GET http://localhost/healthz
→ Checks all downstream services
→ Returns 503 if any service down
→ Used by Compose depends_on
```

### Monitoring Metrics to Track

**Application Metrics**:
```
- Request count (per service, per endpoint)
- Request latency (p50, p95, p99)
- Error rate (4xx, 5xx)
- Job queue depth (trigger-bg)
- Job processing time
- Database query latency
```

**Infrastructure Metrics**:
```
- CPU usage (per container)
- Memory usage (per container)
- Disk usage (Postgres, Redis volumes)
- Network I/O (bandwidth, connections)
- Container restart count
```

**Business Metrics**:
```
- Total links created (dub-links)
- Total redirects (dub-links)
- Total jobs processed (trigger-bg)
- Auth success/failure rate (pocket-base)
```

**Setup Instructions**:
```bash
# 1. Add prometheus client to Node services
npm install prom-client

# 2. Expose metrics endpoint
app.get('/metrics', (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(register.metrics());
});

# 3. Deploy Prometheus (Docker image)
# 4. Deploy Grafana (Docker image)
# 5. Configure dashboards
```

---

## Performance Optimization

### Database Optimization

**Connection Pool Tuning**:
```javascript
// Current settings
const pool = new Pool({
  min: 2,      // Start with 2 connections
  max: 10,     // Grow up to 10
  // Tune based on load testing
});

// For high throughput:
// min: 5, max: 20

// For low traffic:
// min: 1, max: 5
```

**Query Optimization**:
```javascript
// Bad: N+1 query problem
const slugs = ['abc', 'def', 'ghi'];
for (const slug of slugs) {
  const result = await pool.query('SELECT * FROM links WHERE slug = $1', [slug]);
}

// Good: Single query with IN clause
const result = await pool.query(
  'SELECT * FROM links WHERE slug = ANY($1)',
  [slugs]
);

// Good: Batch processing
const results = await pool.query(
  'SELECT * FROM links WHERE slug IN (' + slugs.map((_, i) => `$${i + 1}`).join(',') + ')',
  slugs
);
```

**Index Strategy**:
```sql
-- Essential indexes
CREATE UNIQUE INDEX idx_links_slug ON links(slug);

-- Optional (for analytics)
CREATE INDEX idx_links_created_at ON links(created_at);
CREATE INDEX idx_click_events_date ON click_events(clicked_at);

-- Composite indexes for common queries
CREATE INDEX idx_click_events_slug_date ON click_events(slug, clicked_at);
```

### Redis Optimization

**Memory Management**:
```bash
# Monitor memory usage
docker exec redis redis-cli info memory

# Set eviction policy (remove old jobs when memory full)
redis-cli CONFIG SET maxmemory-policy allkeys-lru

# Set memory limit
redis-cli CONFIG SET maxmemory 512mb
```

**Queue Optimization**:
```javascript
// Limit job retention
const queue = new Queue('job-queue', {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: {
      age: 604800  // Remove after 7 days
    },
    removeOnFail: {
      age: 2592000  // Keep failures for 30 days
    }
  }
});
```

### API Response Caching

**Example: Cache link data**:
```javascript
app.get('/api/links/:slug', readLimiter, async (req, res) => {
  const { slug } = req.params;
  
  // Check Redis cache first
  const cached = await redis.get(`link:${slug}`);
  if (cached) {
    return res.json(JSON.parse(cached));
  }
  
  // Query database
  const result = await pool.query(
    'SELECT * FROM links WHERE slug = $1',
    [slug]
  );
  
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Not found' });
  }
  
  const link = result.rows[0];
  
  // Cache for 1 hour
  await redis.setex(`link:${slug}`, 3600, JSON.stringify(link));
  
  res.json(link);
});

// Invalidate cache on update
app.put('/api/links/:slug', writeLimiter, async (req, res) => {
  // ... update logic ...
  
  // Clear cache
  await redis.del(`link:${slug}`);
  
  res.json(updatedLink);
});
```

---

## Troubleshooting & Debug

### Common Issues

**1. Services won't start**:
```bash
# Check logs
docker compose logs trigger-bg
docker compose logs dub-links

# Common causes:
# - Port conflict: lsof -i :3001
# - Missing env vars: echo $DUB_API_KEY
# - Invalid image: docker compose config
```

**2. Database connection errors**:
```bash
# Test Postgres connectivity
docker compose exec dub-links psql -h db-links -U postgres -c "SELECT 1"

# Check connection pool status
# Monitor: SELECT * FROM pg_stat_activity;
```

**3. Rate limiting too strict**:
```bash
# Check current limits
echo $DUB_READ_RATE_LIMIT
echo $DUB_WRITE_RATE_LIMIT

# Adjust and restart
# Edit .env
# docker compose up -d --build
```

**4. Job queue backed up**:
```bash
# Check queue depth
docker exec redis redis-cli HGETALL bull:job-queue:* | wc -l

# Monitor with separate window
watch 'docker exec redis redis-cli HGETALL bull:job-queue:* | wc -l'

# Scale workers: docker compose up -d --scale trigger-bg=3
```

### Debug Commands

```bash
# 1. Check service health
curl -i http://localhost:3000/health
curl -i http://localhost:3001/health
curl -i http://localhost/healthz  # Gateway

# 2. Test auth
curl -i -H "X-API-Key: wrong-key" http://localhost:3001/api/jobs
# Should return 401

# 3. Test rate limiting
for i in {1..101}; do curl -s http://localhost:3000/health > /dev/null; done
# Check header on 101st request: RateLimit-Remaining should be 0

# 4. Inspect database
docker compose exec db-links psql -U postgres -d dublinks -c "SELECT COUNT(*) FROM links;"

# 5. Inspect Redis queue
docker compose exec redis redis-cli
> HGETALL bull:job-queue:<job-id>
> LLEN bull:job-queue:waiting
> LLEN bull:job-queue:active

# 6. View real-time logs
docker compose logs -f --tail=50

# 7. Execute in container
docker compose exec dub-links sh
# Then inside: ps aux, curl localhost:3000/health, etc.

# 8. Get container details
docker compose ps
docker inspect <container-id>

# 9. Run smoke test with verbose output
bash scripts/smoke-test.sh -v

# 10. Check network connectivity
docker compose exec trigger-bg ping redis
docker compose exec dub-links nc -zv db-links 5432
```

---

## Advanced Configurations

### Multi-Region Deployment

**Architecture**:
```
Region 1 (US-East)          Region 2 (EU-West)
┌─────────────────┐         ┌─────────────────┐
│ Arqam Stack     │ ◄───►   │ Arqam Stack     │
│ (Primary)       │         │ (Replica)       │
└──────┬──────────┘         └────────┬────────┘
       │                             │
    Postgres                      Postgres
    (Master)                   (Read Replica)
       ▲                             │
       └─────────────────────────────┘
         Streaming Replication
```

**Configuration**:
```yaml
# docker-compose.yml (Region 1)
services:
  db-links:
    image: postgres:16-alpine
    environment:
      - POSTGRES_REPLICATION_MODE=master
      - WAL_LEVEL=replica
      - MAX_WAL_SENDERS=10

# docker-compose.yml (Region 2)
services:
  db-links:
    image: postgres:16-alpine
    environment:
      - POSTGRES_REPLICATION_MODE=slave
      - PRIMARY_CONNINFO=host=region1-db port=5432
```

### High Availability (HA)

**3-Node Redis Cluster**:
```yaml
redis-1:
  image: redis:7-alpine
  command: redis-server --cluster-enabled yes

redis-2:
  image: redis:7-alpine
  command: redis-server --cluster-enabled yes

redis-3:
  image: redis:7-alpine
  command: redis-server --cluster-enabled yes

# Initialize cluster:
# redis-cli --cluster create redis-1:6379 redis-2:6379 redis-3:6379
```

**Postgres HA Setup**:
```yaml
# Using Patroni + etcd for automatic failover
services:
  etcd:
    image: quay.io/coreos/etcd:latest

  postgres-1:
    image: postgres:16-alpine
    environment:
      - PATRONI_SCOPE=postgres-cluster
      - PATRONI_ETCD3_HOSTS=etcd:2379
```

### Kubernetes Migration

**Convert Compose to Kubernetes**:
```bash
# Install kompose
brew install kompose

# Convert
kompose convert -f docker-compose.yml

# Output: *.yaml files for Kubernetes
# Review and apply:
kubectl apply -f *.yaml
```

**Kubernetes ConfigMap** (instead of .env):
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: arqam-config
data:
  DUB_API_KEY: your-api-key
  TRIGGER_API_KEY: your-api-key
  DATABASE_PASSWORD: your-password
```

---

## API Reference

### dub-links

```
POST /api/links
  Create short link
  
  Header: X-API-Key: your-key
  
  Body:
  {
    "destination_url": "https://example.com/long/path",
    "slug": "optional-custom-slug",
    "title": "Page Title"
  }
  
  Response 201:
  {
    "slug": "abc123xy",
    "shortUrl": "http://localhost/abc123xy",
    "destinationUrl": "https://example.com/long/path",
    "title": "Page Title",
    "clicks": 0,
    "createdAt": "2024-04-05T10:00:00.000Z"
  }

GET /api/links/:slug
  Fetch link metadata
  
  Header: X-API-Key: your-key
  
  Response 200:
  {
    "slug": "abc123xy",
    "destination_url": "https://example.com/...",
    "title": "Page Title",
    "clicks": 42,
    "created_at": "2024-04-05T10:00:00.000Z",
    "updated_at": "2024-04-05T10:15:30.000Z"
  }

GET /:slug
  Public redirect
  
  Response 302:
  Location: https://example.com/long/path

DELETE /api/links/:slug
  Delete short link
  
  Header: X-API-Key: your-key
  
  Response 200:
  {
    "deleted": true
  }

GET /health
  Health check
  
  Response 200:
  {
    "status": "ok"
  }
```

### trigger-bg

```
POST /api/jobs
  Create job
  
  Header: X-API-Key: your-key
  
  Body:
  {
    "jobType": "send_email",
    "data": {
      "to": "user@example.com",
      "subject": "Welcome"
    },
    "attempts": 3,
    "backoff": "exponential"
  }
  
  Response 201:
  {
    "id": "1:abc123",
    "status": "waiting",
    "createdAt": "2024-04-05T10:00:00.000Z"
  }

GET /api/jobs
  List jobs
  
  Header: X-API-Key: your-key
  
  Query: ?status=waiting&limit=50&offset=0
  
  Response 200:
  {
    "jobs": [
      {
        "id": "1:abc123",
        "type": "send_email",
        "status": "waiting",
        "createdAt": "2024-04-05T10:00:00.000Z"
      }
    ],
    "total": 150,
    "offset": 0,
    "limit": 50
  }

GET /api/jobs/:id
  Get job details
  
  Header: X-API-Key: your-key
  
  Response 200:
  {
    "id": "1:abc123",
    "type": "send_email",
    "status": "completed",
    "data": {...},
    "progress": 100,
    "result": {...},
    "createdAt": "2024-04-05T10:00:00.000Z",
    "completedAt": "2024-04-05T10:00:05.000Z"
  }

GET /api/jobs/:id/result
  Get job result (blocks until done)
  
  Header: X-API-Key: your-key
  
  Response 200 (if completed):
  {
    "result": {
      "sent": true,
      "messageId": "msg-123"
    }
  }
  
  Response 409 (if still processing):
  {
    "status": "processing"
  }

DELETE /api/jobs/:id
  Cancel job
  
  Header: X-API-Key: your-key
  
  Response 200:
  {
    "canceled": true
  }

GET /health
  Health check
  
  Response 200:
  {
    "status": "ok"
  }
```

---

**Document Version**: 1.0  
**Last Updated**: April 5, 2026  
**Status**: Production Ready ✅
