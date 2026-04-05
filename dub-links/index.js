import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.json());

const links = new Map();

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "dub-links" });
});

app.post("/shorten", (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  const slug = crypto.randomBytes(3).toString("hex");
  links.set(slug, {
    url,
    createdAt: new Date().toISOString(),
    clicks: 0
  });

  res.status(201).json({ slug, shortUrl: `/${slug}` });
});

app.get("/:slug", (req, res) => {
  const item = links.get(req.params.slug);
  if (!item) {
    return res.status(404).json({ error: "not found" });
  }

  item.clicks += 1;
  res.redirect(item.url);
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`dub-links listening on ${port}`);
});
