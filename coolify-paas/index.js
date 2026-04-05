import express from "express";
import rateLimit from "express-rate-limit";

const app = express();
app.set("trust proxy", 1);
app.use(requestLogger("coolify-paas"));
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.COOLIFY_RATE_LIMIT || 180),
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.get("/", (_req, res) => {
  res.json({
    service: "coolify-paas",
    status: "ok",
    routes: ["GET /health", "GET /apps", "POST /deploy"]
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "coolify-paas" });
});

app.get("/apps", (_req, res) => {
  res.json({ items: [] });
});

app.post("/deploy", (req, res) => {
  const appName = String(req.body?.name || "app").trim();
  res.status(202).json({ queued: true, app: appName, status: "build-started" });
});

const port = Number(process.env.PORT || 3002);
app.listen(port, () => {
  console.log(`coolify-paas listening on ${port}`);
});

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