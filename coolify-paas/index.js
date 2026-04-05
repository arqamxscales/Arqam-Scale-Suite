import express from "express";

const app = express();
app.use(express.json());

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