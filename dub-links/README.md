# dub-links

Persistent link shortener backed by Postgres with API-key-protected writes, custom slugs, and click analytics.

## Run

```bash
npm start
```

## Endpoints

- `GET /health`
- `GET /api/links`
- `POST /api/links`
- `GET /api/links/:slug`
- `PATCH /api/links/:slug`
- `DELETE /api/links/:slug`
- `GET /:slug`

## Auth

Set `DUB_API_KEY` and send it as `X-API-Key` for write requests.
