import express from "express";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue("ai-jobs", { connection });

new Worker(
  "ai-jobs",
  async (job) => {
    console.log("processing job", job.id, job.name, job.data);
    return { ok: true, processedAt: new Date().toISOString() };
  },
  { connection }
);

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "trigger-bg" });
});

app.post("/enqueue", async (req, res) => {
  const payload = req.body?.payload || {};
  const job = await queue.add("ai-task", payload, {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 1000
    },
    removeOnComplete: true
  });

  res.status(202).json({ queued: true, jobId: job.id });
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`trigger-bg listening on ${port}`);
});
