import express from "express";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { Pool } from "pg";

const app = express();
app.set("trust proxy", 1);
app.use(requestLogger("dub-links"));
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://postgres:password@db-links:5432/dublinks?sslmode=disable"
});
const apiKey = process.env.DUB_API_KEY || "change-me";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:3000";

const createTableSql = `
  CREATE TABLE IF NOT EXISTS links (
    slug TEXT PRIMARY KEY,
    destination_url TEXT NOT NULL,
    title TEXT,
    clicks INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

const createIndexSql = `
  CREATE UNIQUE INDEX IF NOT EXISTS links_destination_url_slug_idx ON links (slug);
`;

await waitForDatabase();
await pool.query(createTableSql);
await pool.query(createIndexSql);

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.DUB_READ_RATE_LIMIT || 300),
  standardHeaders: true,
  legacyHeaders: false
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.DUB_WRITE_RATE_LIMIT || 60),
  standardHeaders: true,
  legacyHeaders: false
});

app.use(readLimiter);

app.get("/", (_req, res) => {
  res.json({
    service: "dub-links",
    status: "ok",
    features: ["persistent storage", "custom slugs", "click analytics", "API key auth"],
    routes: ["GET /health", "GET /api/links", "POST /api/links", "GET /api/links/:slug", "PATCH /api/links/:slug", "DELETE /api/links/:slug", "GET /:slug"]
  });
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", service: "dub-links", database: "ready" });
  } catch (error) {
    res.status(503).json({ status: "degraded", service: "dub-links", database: "down" });
  }
});

app.get("/api/links", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT slug, destination_url, title, clicks, created_at, updated_at
     FROM links
     ORDER BY created_at DESC
     LIMIT 100`
  );
  res.json({ items: rows.map(formatLink) });
});

app.post("/api/links", writeLimiter, requireApiKey, async (req, res) => {
  const destinationUrl = String(req.body?.url || "").trim();
  const requestedSlug = normalizeSlug(req.body?.slug);
  const title = normalizeOptionalText(req.body?.title);

  if (!isValidUrl(destinationUrl)) {
    return res.status(400).json({ error: "a valid url is required" });
  }

  const slug = requestedSlug || crypto.randomBytes(4).toString("hex");
  if (!isValidSlug(slug)) {
    return res.status(400).json({ error: "slug must be 3-64 characters and use letters, numbers, or hyphens" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO links (slug, destination_url, title)
       VALUES ($1, $2, $3)
       RETURNING slug, destination_url, title, clicks, created_at, updated_at`,
      [slug, destinationUrl, title]
    );

    const link = formatLink(rows[0]);
    res.status(201).json({
      ...link,
      shortUrl: `${publicBaseUrl.replace(/\/$/, "")}/${link.slug}`
    });
  } catch (error) {
    if (String(error?.message || "").includes("duplicate key")) {
      return res.status(409).json({ error: "slug already exists" });
    }
    throw error;
  }
});

app.get("/api/links/:slug", async (req, res) => {
  const link = await getLink(req.params.slug);
  if (!link) {
    return res.status(404).json({ error: "not found" });
  }

  res.json(link);
});

app.patch("/api/links/:slug", writeLimiter, requireApiKey, async (req, res) => {
  const slug = req.params.slug;
  const existing = await getLink(slug);
  if (!existing) {
    return res.status(404).json({ error: "not found" });
  }

  const nextUrl = req.body?.url !== undefined ? String(req.body.url).trim() : existing.destination_url;
  const nextTitle = req.body?.title !== undefined ? normalizeOptionalText(req.body.title) : existing.title;

  if (!isValidUrl(nextUrl)) {
    return res.status(400).json({ error: "a valid url is required" });
  }

  const { rows } = await pool.query(
    `UPDATE links
     SET destination_url = $1,
         title = $2,
         updated_at = NOW()
     WHERE slug = $3
     RETURNING slug, destination_url, title, clicks, created_at, updated_at`,
    [nextUrl, nextTitle, slug]
  );

  res.json(formatLink(rows[0]));
});

app.delete("/api/links/:slug", writeLimiter, requireApiKey, async (req, res) => {
  const result = await pool.query(`DELETE FROM links WHERE slug = $1`, [req.params.slug]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: "not found" });
  }

  res.status(204).end();
});

app.get("/:slug", async (req, res) => {
  const slug = req.params.slug;
  if (!isValidSlug(slug)) {
    return res.status(404).json({ error: "not found" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE links
       SET clicks = clicks + 1,
           updated_at = NOW()
       WHERE slug = $1
       RETURNING slug, destination_url, title, clicks, created_at, updated_at`,
      [slug]
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not found" });
    }

    await client.query("COMMIT");
    return res.redirect(302, rows[0].destination_url);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "internal server error" });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`dub-links listening on ${port}`);
});

function requireApiKey(req, res, next) {
  const headerKey = String(req.get("x-api-key") || "").trim();
  if (!headerKey || headerKey !== apiKey) {
    return res.status(401).json({ error: "invalid api key" });
  }

  return next();
}

function normalizeSlug(value) {
  const slug = String(value || "").trim().toLowerCase();
  return slug || null;
}

function normalizeOptionalText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function isValidSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length >= 3 && slug.length <= 64;
}

function isValidUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function getLink(slug) {
  const { rows } = await pool.query(
    `SELECT slug, destination_url, title, clicks, created_at, updated_at
     FROM links
     WHERE slug = $1`,
    [slug]
  );

  return rows[0] ? formatLink(rows[0]) : null;
}

function formatLink(row) {
  return {
    slug: row.slug,
    url: row.destination_url,
    title: row.title,
    clicks: Number(row.clicks),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    shortUrl: `${publicBaseUrl.replace(/\/$/, "")}/${row.slug}`
  };
}

async function waitForDatabase() {
  const maxAttempts = 30;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
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

