import express from "express";

const app = express();
app.use(express.json());

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