import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { WebSocketServer } from "ws";

const app = express();
const wsToken = String(process.env.PAPER_WS_TOKEN || "").trim();
app.set("trust proxy", 1);
app.use(requestLogger("paper-cups"));
app.use(cors());
app.use(express.json());

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.PAPER_RATE_LIMIT || 240),
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.get("/", (_req, res) => {
  res.json({
    service: "paper-cups",
    status: "ok",
    routes: ["GET /health", "WS /ws"]
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "paper-cups" });
});

const server = app.listen(process.env.PORT || 4000, () => {
  console.log("paper-cups listening on 4000");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  if (wsToken) {
    const url = new URL(req.url || "", "http://localhost");
    const token = String(url.searchParams.get("token") || "").trim();
    if (token !== wsToken) {
      ws.send(JSON.stringify({ type: "system", message: "unauthorized" }));
      ws.close(1008, "unauthorized");
      return;
    }
  }

  ws.send(JSON.stringify({ type: "system", message: "connected" }));

  ws.on("message", (message) => {
    const payload = message.toString();
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "chat", message: payload }));
      }
    }
  });
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
