import express from "express";
import rateLimit from "express-rate-limit";
import { Queue, Worker, QueueEvents } from "bullmq";
import IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
const apiKey = process.env.TRIGGER_API_KEY || "change-me";
const queueName = process.env.TRIGGER_QUEUE_NAME || "ai-jobs";
const defaultAttempts = Number(process.env.TRIGGER_DEFAULT_ATTEMPTS || 5);
const defaultBackoffDelayMs = Number(process.env.TRIGGER_DEFAULT_BACKOFF_MS || 1000);

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true
});
const queue = new Queue(queueName, { connection });
const queueEvents = new QueueEvents(queueName, { connection });

queueEvents.on("error", (error) => {
  console.error("queueEvents error", error);
});

await queueEvents.waitUntilReady();

const worker = new Worker(
  queueName,
  async (job) => {
    const startedAt = new Date().toISOString();
    const simulatedMs = Math.max(0, Number(job.data?.simulateMs || 150));
    await new Promise((resolve) => setTimeout(resolve, Math.min(simulatedMs, 10_000)));

    const result = {
      ok: true,
      processedAt: new Date().toISOString(),
      startedAt,
      jobId: job.id,
      jobName: job.name,
      summary: "task executed"
    };

    console.log("processing job", { id: job.id, name: job.name, data: job.data, result });
    return result;
  },
  {
    connection,
    concurrency: Math.max(1, Number(process.env.TRIGGER_WORKER_CONCURRENCY || 5))
  }
);

worker.on("failed", (job, err) => {
  console.error("job failed", {
    id: job?.id,
    name: job?.name,
    reason: err?.message
  });
});

worker.on("error", (error) => {
  console.error("worker error", error);
});

const app = express();
app.set("trust proxy", 1);
app.use(requestLogger("trigger-bg"));
app.use(express.json());

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.TRIGGER_READ_RATE_LIMIT || 300),
  standardHeaders: true,
  legacyHeaders: false
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.TRIGGER_WRITE_RATE_LIMIT || 60),
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api", readLimiter);

app.get("/", (_req, res) => {
  res.json({
    service: "trigger-bg",
    status: "ok",
    features: ["authenticated enqueue", "job status", "job result", "retry/backoff"],
    routes: [
      "GET /health",
      "POST /api/jobs",
      "GET /api/jobs",
      "GET /api/jobs/:id",
      "GET /api/jobs/:id/result"
    ]
  });
});

app.get("/health", async (_req, res) => {
  try {
    const ping = await connection.ping();
    res.json({
      status: ping === "PONG" ? "ok" : "degraded",
      service: "trigger-bg",
      queue: queueName,
      redis: ping
    });
  } catch (error) {
    res.status(503).json({
      status: "degraded",
      service: "trigger-bg",
      queue: queueName,
      redis: "down"
    });
  }
});

app.post("/api/jobs", writeLimiter, requireApiKey, async (req, res, next) => {
  try {
    const payload = req.body?.payload ?? {};
    const name = normalizeJobName(req.body?.name);
    const attempts = normalizePositiveInt(req.body?.attempts, defaultAttempts, 1, 25);
    const backoffMs = normalizePositiveInt(req.body?.backoffMs, defaultBackoffDelayMs, 100, 60_000);

    const job = await queue.add(name, payload, {
      attempts,
      backoff: {
        type: "exponential",
        delay: backoffMs
      },
      removeOnComplete: {
        age: 60 * 60,
        count: 1000
      },
      removeOnFail: {
        age: 24 * 60 * 60,
        count: 5000
      }
    });

    res.status(202).json({
      queued: true,
      job: {
        id: job.id,
        name: job.name,
        attempts,
        backoffMs,
        createdAt: toIso(job.timestamp)
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs", async (req, res, next) => {
  try {
    const state = normalizeState(req.query?.state);
    const limit = normalizePositiveInt(req.query?.limit, 20, 1, 100);

    const jobs = await queue.getJobs([state], 0, limit - 1, true);
    res.json({
      items: jobs.map(toJobSummary)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs/:id", async (req, res, next) => {
  try {
    const job = await queue.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: "job not found" });
    }

    const state = await job.getState();
    return res.json({
      ...toJobSummary(job),
      state,
      payload: job.data,
      failedReason: job.failedReason || null,
      finishedOn: toIso(job.finishedOn),
      processedOn: toIso(job.processedOn)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs/:id/result", async (req, res, next) => {
  try {
    const job = await queue.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: "job not found" });
    }

    const state = await job.getState();
    if (state !== "completed") {
      return res.status(409).json({
        error: "job is not completed",
        state
      });
    }

    return res.json({
      id: job.id,
      name: job.name,
      state,
      result: job.returnvalue
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "internal server error" });
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`trigger-bg listening on ${port}`);
});

function requireApiKey(req, res, next) {
  const headerKey = String(req.get("x-api-key") || "").trim();
  if (!headerKey || headerKey !== apiKey) {
    return res.status(401).json({ error: "invalid api key" });
  }

  return next();
}

function normalizeJobName(value) {
  const name = String(value || "ai-task").trim();
  return name || "ai-task";
}

function normalizePositiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeState(value) {
  const allowed = new Set(["completed", "failed", "delayed", "active", "waiting", "prioritized", "paused", "waiting-children"]);
  const requested = String(value || "waiting").trim().toLowerCase();
  return allowed.has(requested) ? requested : "waiting";
}

function toIso(ms) {
  if (!ms) {
    return null;
  }
  return new Date(ms).toISOString();
}

function toJobSummary(job) {
  return {
    id: job.id,
    name: job.name,
    attemptsMade: job.attemptsMade,
    attemptsConfigured: job.opts?.attempts || 1,
    createdAt: toIso(job.timestamp),
    finishedOn: toIso(job.finishedOn),
    processedOn: toIso(job.processedOn)
  };
}

function requestLogger(service) {
  return (req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      const log = {
        ts: new Date().toISOString(),
        service,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - started,
        ip: req.ip
      };
      console.log(JSON.stringify(log));
    });
    next();
  };
}
