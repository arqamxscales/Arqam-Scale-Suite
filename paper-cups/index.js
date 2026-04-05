import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";

const app = express();
app.use(cors());
app.use(express.json());

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

wss.on("connection", (ws) => {
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
