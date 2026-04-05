import express from "express";
import rateLimit from "express-rate-limit";

const app = express();
app.set("trust proxy", 1);
app.use(requestLogger("hopp-test"));
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.HOPP_RATE_LIMIT || 180),
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.get("/", (_req, res) => {
  res.json({
    service: "hopp-test",
    status: "ok",
    routes: ["GET /health", "GET /workspace", "POST /request"]
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "hopp-test" });
});

app.get("/workspace", (_req, res) => {
  res.json({
    collections: [
      {
        name: "default",
        requests: []
      }
    ]
  });
});

app.post("/request", (req, res) => {
  res.status(200).json({
    echo: req.body || {},
    status: "saved"
  });
});

const port = Number(process.env.PORT || 3003);
app.listen(port, () => {
  console.log(`hopp-test listening on ${port}`);
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